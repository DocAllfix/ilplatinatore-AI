import { createHash } from "crypto";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "@/config/env.js";
import { getClient } from "@/config/database.js";
import { redis } from "@/config/redis.js";
import { logger } from "@/utils/logger.js";
import { GuidesModel } from "@/models/guides.model.js";
import { EmbeddingsModel, chunkHash, type EmbeddingInsert } from "@/models/embeddings.model.js";

const CHARS_PER_TOKEN = 4;
const MAX_INPUT_TOKENS = 2000;
const MAX_INPUT_CHARS = MAX_INPUT_TOKENS * CHARS_PER_TOKEN;
const MIN_GUIDE_CHARS = 50;
const CACHE_TTL_SECONDS = 86_400; // 24h

// T1.6 — modello esposto come costante per idempotency (chunk_hash + model uniq).
// Migrazione futura a un modello successivo = nuova costante + nuovi embedding paralleli.
//
// FIX 2026-05-01 — `text-embedding-004` è stato rimosso da Generative Language API v1beta
// (404 Not Found su embedContent). Migrato a `gemini-embedding-001`, allineato all'harvester
// Python (vedi harvester/src/injector/embedder.py:_MODEL).
//
// `gemini-embedding-001` ritorna 3072-dim di default (Matryoshka Representation Learning).
// La colonna `guide_embeddings.embedding` è VECTOR(768) — tronchiamo al prefix-768 e
// L2-normalizziamo, pattern documentato per MRL truncation. Cosine distance pgvector
// resta scale-invariant ma manteniamo norma unitaria per consistency con embedding
// prodotti server-side dall'harvester (output_dimensionality=768 SDK Python).
const EMBEDDING_MODEL = "gemini-embedding-001";
const EMBEDDING_DIM = 768;

const genAI = new GoogleGenerativeAI(env.GOOGLE_EMBEDDING_API_KEY);
const embedModel = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function truncateAndNormalize(values: number[], dim: number): number[] {
  const truncated = values.length > dim ? values.slice(0, dim) : values;
  let sumSq = 0;
  for (const v of truncated) sumSq += v * v;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return truncated;
  const result = new Array<number>(truncated.length);
  for (let i = 0; i < truncated.length; i++) result[i] = truncated[i]! / norm;
  return result;
}

export const EmbeddingService = {
  /**
   * Genera un embedding 768d via gemini-embedding-001 (MRL truncated + L2-normalized).
   * Cache Redis 24h su modello+sha256(text). Ritorna null su errore API (contract esplicito).
   */
  async generateEmbedding(text: string): Promise<number[] | null> {
    const input = text.length > MAX_INPUT_CHARS
      ? text.slice(0, MAX_INPUT_CHARS)
      : text;
    // Cache key include il modello: cambiando modello, niente collisioni con cache vecchia.
    const cacheKey = `embed:${EMBEDDING_MODEL}:${sha256(input)}`;

    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        logger.debug({ length: input.length, cacheHit: true }, "Embedding cache hit");
        return JSON.parse(cached) as number[];
      }
    } catch (err) {
      logger.warn({ err, cacheKey }, "Redis cache read failed, fallback ad API");
    }

    const start = performance.now();
    try {
      const result = await embedModel.embedContent(input);
      const raw = result.embedding.values;
      // gemini-embedding-001 ritorna 3072-dim → truncate prefix-768 + L2-normalize.
      const embedding = truncateAndNormalize(raw, EMBEDDING_DIM);
      const ms = Math.round(performance.now() - start);
      logger.info(
        { length: input.length, rawDims: raw.length, dims: embedding.length, ms, cacheHit: false },
        "Embedding generato via Gemini",
      );

      try {
        await redis.set(cacheKey, JSON.stringify(embedding), "EX", CACHE_TTL_SECONDS);
      } catch (err) {
        logger.warn({ err, cacheKey }, "Redis cache write failed (non-fatale)");
      }

      return embedding;
    } catch (err) {
      const ms = Math.round(performance.now() - start);
      logger.error({ err, length: input.length, ms }, "Gemini embedding API failed");
      return null;
    }
  },

  /**
   * Divide il testo in chunk di max `maxTokens` token (≈4 char/token),
   * con `overlap` token di sovrapposizione tra chunk consecutivi.
   * Rispetta i confini di frase (. ! ?); frasi singole mostruose vengono spezzate a forza.
   */
  chunkText(text: string, maxTokens = 600, overlap = 100): string[] {
    if (!text.trim()) return [];

    const maxChars = maxTokens * CHARS_PER_TOKEN;
    const overlapChars = overlap * CHARS_PER_TOKEN;

    if (text.length <= maxChars) {
      logger.debug({ inputChars: text.length, chunks: 1 }, "Testo sta in un solo chunk");
      return [text];
    }

    // Split su fine-frase mantenendo il separatore nel segmento precedente.
    const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.length > 0);
    const chunks: string[] = [];
    let current: string[] = [];
    let currentLen = 0;

    for (const sentence of sentences) {
      // Frase più lunga di un intero chunk: la spezziamo a forza.
      if (sentence.length > maxChars) {
        if (current.length > 0) {
          chunks.push(current.join(" "));
          current = [];
          currentLen = 0;
        }
        for (let i = 0; i < sentence.length; i += maxChars) {
          chunks.push(sentence.slice(i, i + maxChars));
        }
        continue;
      }

      // +1 per lo spazio che verrà inserito nel join.
      if (currentLen + sentence.length + 1 > maxChars && current.length > 0) {
        chunks.push(current.join(" "));
        // Overlap: tieni la coda del chunk appena chiuso come prefisso del prossimo.
        const prev = current.join(" ");
        const overlapText = prev.length > overlapChars
          ? prev.slice(prev.length - overlapChars)
          : prev;
        current = overlapText.length > 0 ? [overlapText] : [];
        currentLen = current.reduce((n, s) => n + s.length + 1, 0);
      }

      current.push(sentence);
      currentLen += sentence.length + 1;
    }

    if (current.length > 0) chunks.push(current.join(" "));

    logger.info({ inputChars: text.length, chunks: chunks.length }, "Testo diviso in chunk");
    return chunks;
  },

  /**
   * Genera gli embedding per una guida e li salva in guide_embeddings.
   *
   * T1.6 — Idempotency: se un retry parziale BullMQ riprocessa una guide,
   * skipper i chunk_hash già presenti in DB (NO chiamata API ripetuta) e
   * inserisce solo i mancanti. Niente più 50× chiamate Gemini su fail al chunk 49.
   *
   * Throw su errore API SOLO per chunk realmente nuovi → BullMQ retenta con
   * backoff esponenziale ma il prossimo retry parte da dove si era fermato.
   */
  async embedAndStoreGuide(guideId: number): Promise<void> {
    const start = performance.now();
    const guide = await GuidesModel.findById(guideId);
    if (!guide) {
      logger.warn({ guideId }, "embedAndStoreGuide: guida non trovata, skip");
      return;
    }

    const fullText = `${guide.title}\n\n${guide.content}`;

    // Guide troppo corte: skip definitivo (flag=false per non far retriare lo scheduler).
    if (fullText.length < MIN_GUIDE_CHARS) {
      logger.warn(
        { guideId, length: fullText.length },
        "Guida troppo corta per embedding, flag=false",
      );
      await GuidesModel.update(guideId, { embedding_pending: false });
      return;
    }

    const isShort = fullText.length <= MAX_INPUT_CHARS;
    const chunks = isShort ? [fullText] : EmbeddingService.chunkText(fullText);

    // T1.6 — fetch dei chunk_hash già embeddati per questa guide+model. I chunk
    // il cui hash è già presente vengono saltati senza chiamare Gemini.
    const existingHashes = await EmbeddingsModel.existingHashes(guideId, EMBEDDING_MODEL);

    const items: EmbeddingInsert[] = [];
    let skipped = 0;
    let generated = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const hash = chunkHash(chunk);
      if (existingHashes.has(hash)) {
        skipped++;
        continue;
      }
      const embedding = await EmbeddingService.generateEmbedding(chunk);
      if (embedding === null) {
        // Throw → BullMQ retenta. Al prossimo retry, existingHashes coprirà
        // i chunk già scritti dai retry precedenti.
        throw new Error(
          `Embedding failed for guide ${guideId} chunk ${i}/${chunks.length}`,
        );
      }
      items.push({ chunk_index: i, chunk_text: chunk, embedding });
      generated++;
    }

    // Transazione: insert idempotente (ON CONFLICT DO NOTHING) + flag=false.
    // Non facciamo più deleteByGuide: gli hash mismatched sono trattati come
    // nuovi chunk (pure adds). Se la guide cambia content, l'hash cambia e i
    // nuovi insert convivono — il caller può fare cleanup esplicito se serve.
    const client = await getClient();
    try {
      await client.query("BEGIN");
      const inserted = items.length > 0
        ? await EmbeddingsModel.insertBatch(guideId, items, client, {
            language: guide.language,
            embeddingModel: EMBEDDING_MODEL,
          })
        : 0;
      await client.query(
        `-- Segna la guida come embeddata; updated_at NON toccato (solo metadata tecnico).
         UPDATE guides SET embedding_pending = false WHERE id = $1`,
        [guideId],
      );
      await client.query("COMMIT");

      const ms = Math.round(performance.now() - start);
      logger.info(
        { guideId, chunks: chunks.length, generated, skipped, inserted, ms },
        "Guida embeddata e salvata (idempotent T1.6)",
      );
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      logger.error({ err, guideId }, "Transaction failed, rolled back");
      throw err;
    } finally {
      client.release();
    }
  },

  /**
   * Processa un array di guide in sequenza con delay 200ms (5 req/sec = 300 RPM).
   * Uso: CLI/one-shot per re-embed massivi. Per flussi normali usa la coda BullMQ.
   */
  async batchEmbedGuides(
    guideIds: number[],
  ): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;
    const total = guideIds.length;

    for (let i = 0; i < total; i++) {
      const id = guideIds[i]!;
      try {
        await EmbeddingService.embedAndStoreGuide(id);
        success++;
      } catch (err) {
        logger.error({ err, guideId: id }, "batchEmbedGuides: guida fallita");
        failed++;
      }
      // 200ms tra guide: 5 req/sec ≪ 1500 RPM Gemini, sicuro anche con chunking.
      if (i < total - 1) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if ((i + 1) % 10 === 0) {
        logger.info({ processed: i + 1, total, success, failed }, "Batch progress");
      }
    }

    logger.info({ total, success, failed }, "Batch embedding completato");
    return { success, failed };
  },
};

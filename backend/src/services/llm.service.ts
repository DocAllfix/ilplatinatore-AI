import { GoogleGenerativeAI, type GenerativeModel } from "@google/generative-ai";
import { env } from "@/config/env.js";
import { logger } from "@/utils/logger.js";
import { CircuitBreaker, CircuitOpenError } from "@/services/llm.circuitBreaker.js";
import { buildPrompt, type PromptContext, type BuiltPrompt } from "@/services/prompt.builder.js";

/**
 * Servizio integrazione LLM chat — Gemini 2.5 Flash primario.
 *
 * DECISIONI (vedi memory project_fase16_decisions.md §1):
 * - Provider singolo in Fase 16: Gemini. DeepSeek è usato dall'harvester Python,
 *   NON qui. Estensione multi-provider prevista in refactor futuro con dispatch
 *   LLM_CHAT_PROVIDER ∈ {gemini, deepseek}.
 * - Circuit breaker wrappa TUTTE le chiamate, anche streaming.
 * - Fallback model: se il primario fallisce e il circuit si apre, i test
 *   possono switchare a GEMINI_CHAT_MODEL_FALLBACK (gemini-2.5-flash-lite).
 *   In Fase 16 usiamo SOLO il primario — il fallback è cablato per Fase 17.
 */

const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);

const primaryModel: GenerativeModel = genAI.getGenerativeModel({
  model: env.GEMINI_CHAT_MODEL,
  generationConfig: {
    temperature: env.LLM_CHAT_TEMPERATURE,
    topP: env.LLM_CHAT_TOP_P,
    maxOutputTokens: env.LLM_CHAT_MAX_TOKENS,
  },
});

const breaker = new CircuitBreaker({ name: "gemini-chat" });

export interface GenerateGuideResult {
  content: string;
  templateId: string;
  model: string;
  finishReason: string | null;
  elapsedMs: number;
}

/**
 * Genera risposta non-streaming. Usato quando il client richiede JSON pieno
 * (es. job backfill, API non-UI).
 */
export async function generateGuide(ctx: PromptContext): Promise<GenerateGuideResult> {
  const prompt = buildPrompt(ctx);
  const start = Date.now();
  try {
    const result = await breaker.execute(async () => {
      return await primaryModel.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt.user }] }],
        systemInstruction: { role: "system", parts: [{ text: prompt.system }] },
      });
    });
    const response = result.response;
    const content = response.text();
    const finishReason = response.candidates?.[0]?.finishReason ?? null;
    const elapsedMs = Date.now() - start;
    logger.info(
      {
        templateId: prompt.templateId,
        model: env.GEMINI_CHAT_MODEL,
        elapsedMs,
        finishReason,
        length: content.length,
      },
      "generateGuide: OK",
    );
    return {
      content,
      templateId: prompt.templateId,
      model: env.GEMINI_CHAT_MODEL,
      finishReason,
      elapsedMs,
    };
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      logger.warn({ err, templateId: prompt.templateId }, "generateGuide: circuit OPEN");
    } else {
      logger.error({ err, templateId: prompt.templateId }, "generateGuide: chiamata Gemini fallita");
    }
    throw err;
  }
}

export interface StreamChunk {
  /** Testo parziale (delta dall'ultimo chunk). */
  text: string;
}

/**
 * Generatore async: yield chunk man mano che Gemini li streama.
 * Il circuit breaker è applicato alla CREAZIONE dello stream (await iniziale);
 * failure durante lo stream NON riarmano il breaker — è un tradeoff accettato:
 * lo streaming è long-running, segnarlo come errore pigliere troppe volte
 * farebbe tripare il breaker su timeout utente/abort e non su vero outage.
 */
export async function* generateGuideStream(
  ctx: PromptContext,
): AsyncGenerator<StreamChunk, { templateId: string; model: string; elapsedMs: number }, void> {
  const prompt = buildPrompt(ctx);
  const start = Date.now();

  let result;
  try {
    result = await breaker.execute(async () => {
      return await primaryModel.generateContentStream({
        contents: [{ role: "user", parts: [{ text: prompt.user }] }],
        systemInstruction: { role: "system", parts: [{ text: prompt.system }] },
      });
    });
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      logger.warn({ err, templateId: prompt.templateId }, "generateGuideStream: circuit OPEN");
    } else {
      logger.error({ err, templateId: prompt.templateId }, "generateGuideStream: open stream fallita");
    }
    throw err;
  }

  try {
    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) yield { text };
    }
  } catch (err) {
    // Errore mid-stream (es. abort, rete): loggiamo e propagiamo, senza tripare il breaker.
    logger.warn({ err, templateId: prompt.templateId }, "generateGuideStream: errore durante stream");
    throw err;
  }

  const elapsedMs = Date.now() - start;
  logger.info(
    { templateId: prompt.templateId, model: env.GEMINI_CHAT_MODEL, elapsedMs },
    "generateGuideStream: completato",
  );
  return { templateId: prompt.templateId, model: env.GEMINI_CHAT_MODEL, elapsedMs };
}

/**
 * Traduce una guida da una lingua all'altra.
 * Uso: DB è in EN (memory rule project_kb_language_english.md), l'utente è IT
 * → orchestrator chiama translateGuide(guide, 'en', 'it') prima di rispondere.
 *
 * Nota: è ancora una chiamata al modello chat — non un API di traduzione
 * dedicata, per non introdurre un secondo provider.
 */
export async function translateGuide(
  content: string,
  fromLang: string,
  toLang: string,
): Promise<string> {
  if (fromLang === toLang) return content;

  const system = `Sei un traduttore tecnico specializzato in guide videoludiche.
Traduci il contenuto da ${fromLang} a ${toLang} preservando:
  - Markdown (titoli, liste, grassetto)
  - Nomi propri di personaggi, luoghi, trofei, abilità (mantieni l'originale)
  - Identificativi tecnici (psn_trophy_id, codici, tag HTML)
Ritorna SOLO il testo tradotto, senza preamboli né commenti.`;

  try {
    const result = await breaker.execute(async () => {
      return await primaryModel.generateContent({
        contents: [{ role: "user", parts: [{ text: content }] }],
        systemInstruction: { role: "system", parts: [{ text: system }] },
      });
    });
    return result.response.text();
  } catch (err) {
    logger.error({ err, fromLang, toLang }, "translateGuide: fallita, ritorno testo originale");
    // Degradation graceful: meglio risposta in lingua "sbagliata" che nessuna risposta.
    return content;
  }
}

/** Espone il breaker per endpoint admin / health-check. */
export function getBreakerState() {
  return breaker.getState();
}

/** Espone il prompt builder per introspezione/log orchestrator. */
export function previewPrompt(ctx: PromptContext): BuiltPrompt {
  return buildPrompt(ctx);
}

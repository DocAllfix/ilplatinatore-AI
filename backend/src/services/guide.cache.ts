import { redis } from "@/config/redis.js";
import { env } from "@/config/env.js";
import { logger } from "@/utils/logger.js";
import type { GuideType } from "@/services/prompt.builder.js";

/**
 * Cache Redis per risposte LLM già generate.
 *
 * FORMATO CHIAVE (spec Fase 16 checklist):
 *   guide:{game_slug}:{trophy_slug}:{language}
 *
 * Dove:
 *   - game_slug: slug del gioco risolto, "unknown" se non identificato.
 *   - trophy_slug: slug trofeo, oppure topic, oppure guide_type come fallback
 *     (es. "platinum" per roadmap plat generale del gioco). Garantisce che
 *     due richieste per scopi diversi non collassino sulla stessa chiave.
 *   - language: lingua utente richiesta.
 *
 * Slug-based è VOLUTAMENTE meno collision-proof dell'hash ma human-readable —
 * consente invalidazione manuale con SCAN `guide:elden-ring:*` in Redis.
 *
 * TTL: GUIDE_CACHE_TTL_SECONDS (default 24h).
 */

export interface GuideCacheKeyParams {
  gameSlug: string | null;
  trophySlug: string | null;
  topic: string | null;
  guideType: GuideType;
  language: string;
}

/**
 * T3.3 — KF-2 Inline citations: shape estesa con metadata per UI hover.
 * Tutti i campi POST `title` sono OPZIONALI per backward-compat con
 * cached entries pre-T3.3 in Redis (parse soft-fail tollerato).
 *
 * `index` (1-based) corrisponde al "FONTE N" nel prompt → permette al
 * frontend di mappare i tag `[N]` nel content alla source corrispondente.
 */
export interface CachedGuide {
  content: string;
  sources: Array<{
    url?: string;
    domain?: string;
    guideId?: number;
    title?: string;
    /** Indice 1-based usato come marker [N] nel content. */
    index?: number;
    /** 0..1 — affidabilità (RAG verified=1, scraping trusted-domain=0.95, etc.). */
    reliability?: number;
    /** Solo per RAG sources: la guide ha verified=true nel DB. */
    verified?: boolean;
    /** Solo per RAG sources: vector similarity score (cos sim 0..1). */
    vectorScore?: number;
  }>;
  generatedAt: number;
  templateId: string;
  model: string;
}

/**
 * Normalizza una stringa in slug URL-safe: lowercase, Unicode → ASCII-ish,
 * non-alnum → "-", collapse trattini ripetuti, trim.
 */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // rimuove accenti
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120); // safety cap
}

export function computeKey(p: GuideCacheKeyParams): string {
  const gameSlug = p.gameSlug && p.gameSlug.trim().length > 0 ? slugify(p.gameSlug) : "unknown";
  // Precedenza: trophy_slug → topic → guide_type (per evitare collisioni su NULL).
  const target = p.trophySlug ?? p.topic ?? p.guideType;
  const targetSlug = slugify(target);
  const lang = slugify(p.language) || "en";
  return `guide:${gameSlug}:${targetSlug}:${lang}`;
}

export const GuideCache = {
  async get(params: GuideCacheKeyParams): Promise<CachedGuide | null> {
    const key = computeKey(params);
    try {
      const raw = await redis.get(key);
      if (!raw) return null;
      logger.info({ key }, "GuideCache: HIT");
      return JSON.parse(raw) as CachedGuide;
    } catch (err) {
      logger.warn({ err, key }, "GuideCache.get: errore Redis, procedo senza cache");
      return null;
    }
  },

  async set(params: GuideCacheKeyParams, value: CachedGuide): Promise<void> {
    const key = computeKey(params);
    try {
      await redis.setex(key, env.GUIDE_CACHE_TTL_SECONDS, JSON.stringify(value));
    } catch (err) {
      logger.warn({ err, key }, "GuideCache.set: errore Redis (non-fatal)");
    }
  },

  computeKey,
};

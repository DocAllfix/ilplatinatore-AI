import { z } from "zod";

/**
 * Schema Zod per TUTTE le variabili d'ambiente.
 * Se una variabile obbligatoria manca, il processo crasha al boot con messaggio chiaro.
 * Le variabili con default (PORT, NODE_ENV) hanno fallback.
 */
const envSchema = z.object({
  // ── Database ────────────────────────────────────────────────
  // Connessione applicazione via PgBouncer (porta 6432)
  DATABASE_URL: z.string().url(),
  // Connessione diretta per migration (porta 5432)
  POSTGRES_DIRECT_URL: z.string().url(),
  POSTGRES_DB: z.string().min(1),
  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(1),

  // ── Redis ───────────────────────────────────────────────────
  REDIS_URL: z.string().url(),

  // ── API Keys ────────────────────────────────────────────────
  GEMINI_API_KEY: z.string().min(1),
  GOOGLE_EMBEDDING_API_KEY: z.string().min(1),
  SERPAPI_KEY: z.string().default(""),
  // Tavily Search API — web fallback per scraping (Fase 23)
  TAVILY_API_KEY: z.string().default(""),

  // ── WordPress ───────────────────────────────────────────────
  WP_API_URL: z.string().url(),
  WP_APP_PASSWORD: z.string().min(1),
  WP_WEBHOOK_SECRET: z.string().min(1),

  // ── Auth ────────────────────────────────────────────────────
  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  // AUDIT FIX (R2): CSRF secret SEPARATO da JWT_SECRET
  CSRF_SECRET: z.string().min(32),

  // ── Stripe ──────────────────────────────────────────────────
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  STRIPE_PRICE_PRO: z.string().min(1),
  STRIPE_PRICE_PLATINUM: z.string().min(1),

  // ── App ─────────────────────────────────────────────────────
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  CORS_ORIGINS: z.string().min(1),

  // ── RAG Config ──────────────────────────────────────────────
  RAG_SIMILARITY_THRESHOLD_HIGH: z.coerce.number().default(0.85),
  RAG_SIMILARITY_THRESHOLD_LOW: z.coerce.number().default(0.6),
  RAG_MAX_RESULTS: z.coerce.number().int().positive().default(5),
  EMBEDDING_DIMENSION: z.coerce.number().int().positive().default(768),

  // ── LLM Chat (Fase 16 — Gemini primario; DeepSeek deferral in memoria) ──
  GEMINI_CHAT_MODEL: z.string().min(1).default("gemini-2.5-flash"),
  GEMINI_CHAT_MODEL_FALLBACK: z.string().min(1).default("gemini-2.5-flash-lite"),
  LLM_CHAT_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.3),
  LLM_CHAT_TOP_P: z.coerce.number().min(0).max(1).default(0.9),
  LLM_CHAT_MAX_TOKENS: z.coerce.number().int().positive().default(4096),
  LLM_CIRCUIT_ERROR_THRESHOLD: z.coerce.number().int().positive().default(3),
  LLM_CIRCUIT_OPEN_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  GUIDE_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24),

  // ── Scraping / Tavily ───────────────────────────────────────
  // TTL cache Redis per risposte Tavily (default 1h)
  SCRAPING_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  // Limite giornaliero chiamate Tavily (default 500 req/giorno free tier)
  SCRAPING_MAX_DAILY_REQUESTS: z.coerce.number().int().positive().default(500),

  // ── Guide Drafts ─────────────────────────────────────────────
  // TTL Redis per stato conversazione bozze (default 30 min)
  DRAFT_TTL_SECONDS: z.coerce.number().int().positive().default(1800),

  // ── Rate Limits ─────────────────────────────────────────────
  RATE_LIMIT_FREE_DAILY: z.coerce.number().int().positive().default(3),
  RATE_LIMIT_FREE_REGISTERED_DAILY: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_FREE_PER_MINUTE: z.coerce.number().int().positive().default(1),
  RATE_LIMIT_REGISTERED_PER_MINUTE: z.coerce.number().int().positive().default(2),
  RATE_LIMIT_PRO_PER_MINUTE: z.coerce.number().int().positive().default(10),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");

    // Unico console.error consentito: il processo sta per crashare,
    // pino non è ancora inizializzato
    console.error(
      `\n❌ Variabili d'ambiente mancanti o non valide:\n${formatted}\n`,
    );
    process.exit(1);
  }

  return result.data;
}

export const env: Env = loadEnv();

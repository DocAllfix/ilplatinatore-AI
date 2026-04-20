import { config } from "dotenv";
import { z } from "zod";

// Carica .env nell'ambiente. In produzione (Docker) le env sono già iniettate.
config();

// Schema zod: validazione + default. Niente hardcode (CLAUDE.md §Codice).
const EnvSchema = z.object({
  REDIS_URL: z.string().default("redis://localhost:6379"),
  // Se vuota, lo scraping ritorna risultato vuoto invece di crashare (regola prompt §3).
  SERPAPI_KEY: z.string().default(""),
  // Path a Chromium di sistema (Dockerfile: /usr/bin/chromium-browser).
  PUPPETEER_EXECUTABLE_PATH: z.string().default("/usr/bin/chromium-browser"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  USER_AGENT: z
    .string()
    .default("IlPlatinatoreBot/1.0 (+https://ilplatinatore.ai/bot)"),
  // 7 giorni = 604800 secondi (regola prompt: cache scraping 7gg).
  SCRAPE_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 7),
  // Delay minimo tra due request allo stesso dominio (regola prompt: 3s).
  DOMAIN_RATE_LIMIT_MS: z.coerce.number().int().nonnegative().default(3000),
});

export const env = EnvSchema.parse(process.env);
export type Env = z.infer<typeof EnvSchema>;

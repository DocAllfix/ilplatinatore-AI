import pino from "pino";
import { env } from "@/config/env";

// Logger singleton pino. CLAUDE.md §Codice: "Logger: usa SOLO pino. Mai console.log".
// pino-pretty attivo solo in dev — in prod log JSON strutturato per ingestion.
export const logger = pino({
  name: "scraper",
  level: env.LOG_LEVEL,
  ...(env.NODE_ENV !== "production" && {
    transport: {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "SYS:standard" },
    },
  }),
});

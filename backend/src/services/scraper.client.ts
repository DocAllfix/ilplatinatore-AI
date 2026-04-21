import { logger } from "@/utils/logger.js";

/**
 * Client verso il microservizio scraper. In Fase 16 non esiste ancora un HTTP
 * transport lato scraper (scraper/src/index.ts è uno stub): il client ritorna
 * sempre risultato vuoto e logga warning.
 *
 * DECISIONE (memory project_fase16_decisions.md §3):
 *   On-demand harvest via BullMQ cross-language è DEFERITO a Fase 25 con
 *   pattern DB-driven (tabella on_demand_requests). In Fase 16 il fallback
 *   scraping qui è un no-op strutturato: l'orchestrator degrada gracefully
 *   senza crashare, preservando la shape del contesto.
 *
 * Per wiring futuro: sostituire `fetchScrapedContext` con una fetch verso
 *   http://scraper:PORT/scrape  { gameTitle, query } → ScrapingResult.
 */

export interface ScrapedSource {
  url: string;
  domain: string;
  reliability: number;
}

export interface ScrapingResult {
  context: string;
  sources: ScrapedSource[];
  totalWordCount: number;
  scrapingTimeMs: number;
}

export async function fetchScrapedContext(
  gameTitle: string,
  query: string,
): Promise<ScrapingResult> {
  logger.warn(
    { gameTitle, query: query.slice(0, 60) },
    "scraper.client: transport non wired (Fase 16 stub) — ritorno empty",
  );
  return {
    context: "",
    sources: [],
    totalWordCount: 0,
    scrapingTimeMs: 0,
  };
}

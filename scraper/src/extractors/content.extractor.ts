import { extractWithCheerio } from "@/extractors/cheerio.extractor";
import { extractWithReadability } from "@/extractors/readability.extractor";
import { extractWithPuppeteer } from "@/extractors/puppeteer.extractor";
import type { ExtractedContent } from "@/types";
import { logger } from "@/utils/logger";

// Soglia qualità: sotto questo wordCount promuoviamo all'extractor più potente.
// 200 parole ≈ 1 paragrafo denso — sotto è un preview/boilerplate.
const QUALITY_THRESHOLD = 200;

/**
 * Strategy chain escalante per estrazione contenuto.
 *
 *   (1) cheerio     — 0ms, 0 RAM — se html fornito
 *   (2) readability — ~50ms, basso RAM — stesso html, parsing più accurato
 *   (3) puppeteer   — 3-8s, ~200MB — ultima risorsa, richiede JS rendering
 *
 * Ogni step promuove al successivo se: null O wordCount < QUALITY_THRESHOLD.
 * Puppeteer fetcha da sé (non accetta html in input).
 */
export async function extractContent(
  url: string,
  html?: string,
): Promise<ExtractedContent | null> {
  const start = Date.now();

  // STEP 1+2: solo se abbiamo HTML statico (già fetchato).
  if (html) {
    const cheerioResult = extractWithCheerio(html, url);
    if (cheerioResult && cheerioResult.wordCount >= QUALITY_THRESHOLD) {
      logger.info(
        {
          url,
          extractor: "cheerio",
          wordCount: cheerioResult.wordCount,
          elapsed: Date.now() - start,
        },
        "content.extractor: cheerio OK",
      );
      return cheerioResult;
    }

    const readResult = extractWithReadability(html, url);
    if (readResult && readResult.wordCount >= QUALITY_THRESHOLD) {
      logger.info(
        {
          url,
          extractor: "readability",
          wordCount: readResult.wordCount,
          elapsed: Date.now() - start,
        },
        "content.extractor: readability OK",
      );
      return readResult;
    }
  }

  // STEP 3: puppeteer (costoso — JS rendering, ~200MB RAM).
  const puppetResult = await extractWithPuppeteer(url);
  if (puppetResult && puppetResult.wordCount >= QUALITY_THRESHOLD) {
    logger.info(
      {
        url,
        extractor: "puppeteer",
        wordCount: puppetResult.wordCount,
        elapsed: Date.now() - start,
      },
      "content.extractor: puppeteer OK",
    );
    return puppetResult;
  }

  logger.warn(
    { url, elapsed: Date.now() - start },
    `Contenuto non estraibile da ${url}`,
  );
  return null;
}

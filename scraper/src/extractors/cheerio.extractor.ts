import { load } from "cheerio";
import type { ExtractedContent } from "@/types";
import { logger } from "@/utils/logger";

// Selector per il contenuto principale — ordinati per preferenza.
const MAIN_SELECTORS = [
  "article",
  ".guide-content",
  ".entry-content",
  ".post-content",
  "main",
];

// Rumore da rimuovere PRIMA di estrarre testo.
const NOISE_SELECTORS = [
  "nav",
  "footer",
  "aside",
  ".sidebar",
  ".ads",
  ".advertisement",
  "script",
  "style",
  "noscript",
  ".comments",
  ".comment",
  ".share",
  ".social",
  ".related",
  ".breadcrumb",
  "form",
  ".newsletter",
];

const MIN_WORDS = 100;

/**
 * Extractor statico basato su Cheerio. Zero costo (no browser), no JS rendering.
 * Ritorna null se contenuto < MIN_WORDS (regola prompt FILE 1).
 */
export function extractWithCheerio(
  html: string,
  url: string,
): ExtractedContent | null {
  try {
    const $ = load(html);

    // Strip noise.
    for (const sel of NOISE_SELECTORS) $(sel).remove();

    // Titolo: h1 preferito, fallback a <title>.
    const title =
      $("h1").first().text().trim() ||
      $("title").text().trim() ||
      "Senza titolo";

    // Cerca il primo container "main" non vuoto.
    let content = "";
    for (const sel of MAIN_SELECTORS) {
      const el = $(sel).first();
      if (el.length > 0) {
        content = el.text().replace(/\s+/g, " ").trim();
        if (content.length > 0) break;
      }
    }
    // Fallback estremo: tutto il body (dopo strip noise).
    if (!content) {
      content = $("body").text().replace(/\s+/g, " ").trim();
    }

    const wordCount = content.split(/\s+/).filter(Boolean).length;
    if (wordCount < MIN_WORDS) {
      logger.debug({ url, wordCount }, "cheerio: contenuto insufficiente");
      return null;
    }

    return {
      title,
      content,
      wordCount,
      source: url,
      extractor: "cheerio",
    };
  } catch (err) {
    logger.warn({ err, url }, "cheerio: extraction fallita");
    return null;
  }
}

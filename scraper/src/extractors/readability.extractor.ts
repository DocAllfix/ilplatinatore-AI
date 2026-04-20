import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import type { ExtractedContent } from "@/types";
import { logger } from "@/utils/logger";

const MIN_WORDS = 100;

/**
 * Extractor basato su @mozilla/readability + JSDOM.
 * Più accurato di cheerio per articoli (stesso algoritmo di Firefox Reader View),
 * ma più costoso (virtual DOM). Ritorna null se parse fallisce o contenuto < MIN_WORDS.
 */
export function extractWithReadability(
  html: string,
  url: string,
): ExtractedContent | null {
  try {
    // JSDOM senza fetch di risorse esterne (default ok: resources non impostato).
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article || !article.textContent) {
      logger.debug({ url }, "readability: parse returned null");
      return null;
    }

    const content = article.textContent.replace(/\s+/g, " ").trim();
    const wordCount = content.split(/\s+/).filter(Boolean).length;
    if (wordCount < MIN_WORDS) {
      logger.debug({ url, wordCount }, "readability: contenuto insufficiente");
      return null;
    }

    return {
      title: article.title?.trim() || "Senza titolo",
      content,
      wordCount,
      source: url,
      extractor: "readability",
    };
  } catch (err) {
    logger.warn({ err, url }, "readability: extraction fallita");
    return null;
  }
}

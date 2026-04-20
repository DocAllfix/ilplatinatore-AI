export type ExtractorName = "cheerio" | "readability" | "puppeteer";

export interface ExtractedContent {
  title: string;
  content: string;
  wordCount: number;
  source: string; // URL sorgente
  extractor: ExtractorName;
}

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

import { createHash } from "node:crypto";
import Redis from "ioredis";
import { env } from "@/config/env";
import { logger } from "@/utils/logger";
import { extractContent } from "@/extractors/content.extractor";
import { getReliabilityScore, rankSources } from "@/ranker/source.ranker";
import { isAllowedByRobots } from "@/utils/robots";
import type {
  ExtractedContent,
  ScrapedSource,
  ScrapingResult,
} from "@/types";

// --- Costanti tarature ---
const SERP_TOP_N = 5;           // prompt §STEP 3: top 5 organic results
const TOP_N_RANKED = 3;         // prompt §STEP 6: top 3 dopo rank
const PER_SOURCE_CHARS = 12_000; // 3000 token * 4 char/token
const MAX_CONTEXT_TOKENS = 8_000;
const MAX_CONTEXT_CHARS = MAX_CONTEXT_TOKENS * 4;
const FETCH_TIMEOUT_MS = 10_000;

// --- Redis singleton ---
const redis = new Redis(env.REDIS_URL, {
  lazyConnect: false,
  maxRetriesPerRequest: 3,
});
redis.on("error", (err) => logger.error({ err }, "scraping: Redis error"));

// --- Rate limit per-dominio (regola prompt: 3s delay fra request stesso host) ---
const domainLastRequest = new Map<string, number>();

async function enforceDomainRateLimit(domain: string): Promise<void> {
  const now = Date.now();
  const last = domainLastRequest.get(domain) ?? 0;
  const wait = last + env.DOMAIN_RATE_LIMIT_MS - now;
  if (wait > 0) {
    logger.debug({ domain, wait }, "rate limit: attendo");
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  domainLastRequest.set(domain, Date.now());
}

// --- Cache key ---
function cacheKey(query: string, gameTitle: string): string {
  const raw = `${gameTitle.toLowerCase().trim()}|${query.toLowerCase().trim()}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  return `scrape:${hash}`;
}

// --- Query builder: 3 varianti (prompt §STEP 2) ---
function buildQueries(query: string, gameTitle: string): string[] {
  return [
    `${gameTitle} ${query} guide`,
    `${gameTitle} ${query} trophy achievement guide`,
    `${gameTitle} guida ${query}`,
  ];
}

// --- SerpAPI ---
interface SerpOrganic {
  url: string;
  snippet?: string;
}

async function callSerpApi(query: string): Promise<SerpOrganic[]> {
  if (!env.SERPAPI_KEY) {
    logger.warn("SERPAPI_KEY non configurata — ritorno risultato vuoto");
    return [];
  }
  try {
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("q", query);
    url.searchParams.set("engine", "google");
    url.searchParams.set("num", String(SERP_TOP_N));
    url.searchParams.set("api_key", env.SERPAPI_KEY);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      logger.warn({ status: res.status }, "serpapi: risposta non-2xx");
      return [];
    }
    const json = (await res.json()) as {
      organic_results?: Array<{ link?: string; snippet?: string }>;
    };
    const organics = json.organic_results ?? [];
    return organics
      .filter((r): r is { link: string; snippet?: string } => typeof r.link === "string")
      .slice(0, SERP_TOP_N)
      .map((r) => (r.snippet ? { url: r.link, snippet: r.snippet } : { url: r.link }));
  } catch (err) {
    logger.error({ err }, "serpapi: fetch fallita");
    return [];
  }
}

// --- Fetch HTML con timeout + content-type guard ---
async function fetchHtml(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      headers: { "User-Agent": env.USER_AGENT, Accept: "text/html" },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) {
      logger.debug({ url, status: res.status }, "fetchHtml: non-200");
      return null;
    }
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("text/html")) return null;
    return await res.text();
  } catch (err) {
    logger.debug({ err, url }, "fetchHtml: errore");
    return null;
  }
}

// --- Assembly contesto ---
interface AssembledContext {
  context: string;
  sources: ScrapedSource[];
  totalWordCount: number;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function assembleContext(ranked: ExtractedContent[]): AssembledContext {
  const parts: string[] = [];
  const sources: ScrapedSource[] = [];
  let totalChars = 0;
  let totalWords = 0;

  for (const item of ranked.slice(0, TOP_N_RANKED)) {
    const domain = hostOf(item.source);
    const reliability = getReliabilityScore(item.source);
    const body = item.content.slice(0, PER_SOURCE_CHARS);
    const header = `=== FONTE: ${domain} (affidabilità: ${reliability.toFixed(2)}) ===`;
    const block = `${header}\n${body}`;
    const sep = parts.length > 0 ? 2 : 0;

    if (totalChars + block.length + sep > MAX_CONTEXT_CHARS) {
      // Troncamento fine-blocco: usiamo il residuo per chiudere la fonte corrente.
      const remaining = MAX_CONTEXT_CHARS - totalChars - sep - header.length - 1;
      if (remaining > 0) {
        parts.push(`${header}\n${body.slice(0, remaining)}`);
        sources.push({ url: item.source, domain, reliability });
      }
      break;
    }
    parts.push(block);
    totalChars += block.length + sep;
    totalWords += item.wordCount;
    sources.push({ url: item.source, domain, reliability });
  }

  return { context: parts.join("\n\n"), sources, totalWordCount: totalWords };
}

// --- Main entry point ---
/**
 * Pipeline scraping on-demand:
 *   1. cache Redis (7gg)
 *   2. build 3 query variants
 *   3. SerpAPI (prima query)
 *   4. per ogni URL: robots.txt → rate limit → fetch → extract
 *   5. rank per (reliability*0.6 + quality*0.4)
 *   6. assembla contesto top-3, max 8000 token
 *   7. cache write
 *
 * Resiliente: ogni errore loggato, ritorna risultato vuoto anziché crashare.
 */
export async function scrapeForGuide(
  query: string,
  gameTitle: string,
): Promise<ScrapingResult> {
  const start = Date.now();
  const key = cacheKey(query, gameTitle);

  // STEP 1 — cache read
  try {
    const cached = await redis.get(key);
    if (cached) {
      logger.info(
        { key, gameTitle, query: query.slice(0, 60) },
        "scraping: cache HIT",
      );
      return JSON.parse(cached) as ScrapingResult;
    }
  } catch (err) {
    logger.warn({ err, key }, "scraping: cache read error, procedo live");
  }

  // STEP 2+3 — SerpAPI con prima query (le altre logged per eventual A/B futuro)
  const queries = buildQueries(query, gameTitle);
  logger.debug({ queries }, "scraping: query variants");
  const primaryQuery = queries[0]!; // sempre presente — buildQueries ritorna array fisso
  const serpResults = await callSerpApi(primaryQuery);

  if (serpResults.length === 0) {
    logger.warn(
      { gameTitle, query: query.slice(0, 60) },
      "scraping: nessun risultato SerpAPI",
    );
    return emptyResult(start);
  }

  // STEP 4 — fetch + extract con robots + rate limit per dominio
  const extracted: ExtractedContent[] = [];
  for (const r of serpResults) {
    try {
      const allowed = await isAllowedByRobots(r.url);
      if (!allowed) {
        logger.info({ url: r.url }, "robots.txt: disallowed, skip");
        continue;
      }
      const domain = hostOf(r.url);
      await enforceDomainRateLimit(domain);
      const html = await fetchHtml(r.url);
      const content = await extractContent(r.url, html ?? undefined);
      if (content) extracted.push(content);
    } catch (err) {
      logger.warn({ err, url: r.url }, "scraping: estrazione fallita per URL");
    }
  }

  if (extracted.length === 0) {
    logger.warn(
      { gameTitle, query: query.slice(0, 60) },
      "scraping: nessun contenuto estratto",
    );
    return emptyResult(start);
  }

  // STEP 5 — rank
  const ranked = rankSources(extracted);

  // STEP 6 — assembla contesto
  const assembled = assembleContext(ranked);

  const result: ScrapingResult = {
    context: assembled.context,
    sources: assembled.sources,
    totalWordCount: assembled.totalWordCount,
    scrapingTimeMs: Date.now() - start,
  };

  // STEP 7 — cache write (7gg)
  try {
    await redis.setex(key, env.SCRAPE_CACHE_TTL_SECONDS, JSON.stringify(result));
  } catch (err) {
    logger.warn({ err, key }, "scraping: cache write fallita");
  }

  logger.info(
    {
      gameTitle,
      query: query.slice(0, 60),
      sources: result.sources.length,
      totalWordCount: result.totalWordCount,
      elapsed: result.scrapingTimeMs,
    },
    "scraping: completato",
  );
  return result;
}

function emptyResult(start: number): ScrapingResult {
  return {
    context: "",
    sources: [],
    totalWordCount: 0,
    scrapingTimeMs: Date.now() - start,
  };
}

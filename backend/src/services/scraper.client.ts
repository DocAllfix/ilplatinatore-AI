import { redis } from "@/config/redis.js";
import { env } from "@/config/env.js";
import { logger } from "@/utils/logger.js";
import crypto from "node:crypto";

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

// Domains trusted for gaming guides — reduces hallucination risk
const TRUSTED_DOMAINS = new Set([
  "powerpyx.com",
  "playstationtrophies.org",
  "trueachievements.com",
  "ign.com",
  "gamefaqs.gamespot.com",
  "gamesradar.com",
  "pushsquare.com",
  "psnprofiles.com",
  "exophase.com",
  "thegamer.com",
  "gamepressure.com",
  "wikigameguides.com",
  "fandom.com",
  "neoseeker.com",
  "jeuxvideo.com",
  "guide-ps4.fr",
  "trophygamers.com",
  "supersoluce.com",
]);

const CACHE_PREFIX = "tavily:";
const DAILY_COUNT_KEY = "tavily:daily_count";

function extractDomain(url: string): string {
  try {
    const { hostname } = new URL(url);
    return hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isTrusted(url: string): boolean {
  const domain = extractDomain(url);
  if (!domain) return false;
  if (TRUSTED_DOMAINS.has(domain)) return true;
  // Also accept subdomains of trusted domains (e.g. guides.ign.com)
  for (const trusted of TRUSTED_DOMAINS) {
    if (domain.endsWith(`.${trusted}`)) return true;
  }
  return false;
}

function reliabilityScore(url: string): number {
  const domain = extractDomain(url);
  // Dedicated trophy/achievement sites: highest reliability
  const topTier = new Set([
    "powerpyx.com",
    "playstationtrophies.org",
    "trueachievements.com",
    "psnprofiles.com",
    "exophase.com",
  ]);
  if (topTier.has(domain)) return 0.95;
  if (TRUSTED_DOMAINS.has(domain)) return 0.8;
  return 0.5;
}

function buildCacheKey(gameTitle: string, query: string): string {
  const raw = `${gameTitle.toLowerCase()}|${query.toLowerCase()}`;
  const hash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return `${CACHE_PREFIX}${hash}`;
}

async function checkDailyLimit(): Promise<boolean> {
  const count = await redis.get(DAILY_COUNT_KEY);
  return parseInt(count ?? "0", 10) < env.SCRAPING_MAX_DAILY_REQUESTS;
}

async function incrementDailyCount(): Promise<void> {
  const pipeline = redis.pipeline();
  pipeline.incr(DAILY_COUNT_KEY);
  // Expire at midnight UTC
  const now = new Date();
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  const ttlSeconds = Math.floor((midnight.getTime() - now.getTime()) / 1000);
  pipeline.expire(DAILY_COUNT_KEY, ttlSeconds, "NX");
  await pipeline.exec();
}

async function callTavily(
  gameTitle: string,
  query: string,
): Promise<ScrapingResult> {
  const searchQuery = `${gameTitle} ${query} trophy guide walkthrough`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.TAVILY_API_KEY}`,
      },
      body: JSON.stringify({
        query: searchQuery,
        search_depth: "advanced",
        include_answer: false,
        include_raw_content: false,
        max_results: 5,
        include_domains: [...TRUSTED_DOMAINS],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      logger.warn(
        { status: response.status, gameTitle },
        "scraper.client: Tavily non-200",
      );
      return { context: "", sources: [], totalWordCount: 0, scrapingTimeMs: 0 };
    }

    const data = (await response.json()) as {
      results?: Array<{ url: string; content: string; title?: string }>;
    };

    const results = data.results ?? [];
    // Filter to trusted domains only — exclude untrusted results entirely
    const trusted = results.filter((r) => isTrusted(r.url));

    if (trusted.length === 0) {
      logger.info(
        { gameTitle, total: results.length },
        "scraper.client: nessun risultato da domini trusted",
      );
      return { context: "", sources: [], totalWordCount: 0, scrapingTimeMs: 0 };
    }

    const sources: ScrapedSource[] = trusted.map((r) => ({
      url: r.url,
      domain: extractDomain(r.url),
      reliability: reliabilityScore(r.url),
    }));

    const contextParts = trusted.map((r, i) => {
      const header = `--- FONTE ${i + 1}: ${r.url} ---`;
      return `${header}\n${r.content.trim()}`;
    });

    const context = contextParts.join("\n\n");
    const totalWordCount = context.split(/\s+/).filter(Boolean).length;

    return { context, sources, totalWordCount, scrapingTimeMs: 0 };
  } catch (err) {
    clearTimeout(timeoutId);
    const isAbort = err instanceof Error && err.name === "AbortError";
    logger.warn(
      { gameTitle, timeout: isAbort, err },
      "scraper.client: errore chiamata Tavily",
    );
    return { context: "", sources: [], totalWordCount: 0, scrapingTimeMs: 0 };
  }
}

export async function fetchScrapedContext(
  gameTitle: string,
  query: string,
): Promise<ScrapingResult> {
  if (!env.TAVILY_API_KEY) {
    logger.debug("scraper.client: TAVILY_API_KEY non configurata — skip");
    return { context: "", sources: [], totalWordCount: 0, scrapingTimeMs: 0 };
  }

  const cacheKey = buildCacheKey(gameTitle, query);
  const start = Date.now();

  // 1. Check Redis cache
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as ScrapingResult;
      logger.debug({ gameTitle, cacheKey }, "scraper.client: cache HIT");
      return { ...parsed, scrapingTimeMs: Date.now() - start };
    }
  } catch (err) {
    logger.warn({ err }, "scraper.client: errore lettura cache Redis");
  }

  // 2. Daily limit guard
  const withinLimit = await checkDailyLimit().catch(() => false);
  if (!withinLimit) {
    logger.warn(
      { gameTitle, limit: env.SCRAPING_MAX_DAILY_REQUESTS },
      "scraper.client: limite giornaliero Tavily raggiunto",
    );
    return { context: "", sources: [], totalWordCount: 0, scrapingTimeMs: 0 };
  }

  // 3. Call Tavily
  await incrementDailyCount();
  const result = await callTavily(gameTitle, query);
  result.scrapingTimeMs = Date.now() - start;

  // 4. Cache on success (even empty — avoid hammering on misses for same query)
  if (result.context || result.sources.length > 0) {
    try {
      await redis.setex(
        cacheKey,
        env.SCRAPING_CACHE_TTL_SECONDS,
        JSON.stringify(result),
      );
    } catch (err) {
      logger.warn({ err }, "scraper.client: errore scrittura cache Redis");
    }
  }

  logger.info(
    {
      gameTitle,
      sources: result.sources.length,
      words: result.totalWordCount,
      ms: result.scrapingTimeMs,
    },
    "scraper.client: Tavily fetch completata",
  );

  return result;
}

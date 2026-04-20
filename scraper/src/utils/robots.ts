import robotsParser from "robots-parser";
import { env } from "@/config/env";
import { logger } from "@/utils/logger";

// Cache del parser robots.txt per dominio. TTL 1h — robots.txt cambia raramente.
const ROBOTS_TTL_MS = 60 * 60 * 1000;
const ROBOTS_FETCH_TIMEOUT_MS = 5000;

type Robot = ReturnType<typeof robotsParser>;
interface CachedRobot {
  parser: Robot;
  at: number;
}
const cache = new Map<string, CachedRobot>();

async function fetchRobots(origin: string): Promise<Robot | null> {
  const robotsUrl = `${origin}/robots.txt`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ROBOTS_FETCH_TIMEOUT_MS);
    const res = await fetch(robotsUrl, {
      headers: { "User-Agent": env.USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      logger.debug({ robotsUrl, status: res.status }, "robots.txt non disponibile - allow");
      return null;
    }
    const text = await res.text();
    return robotsParser(robotsUrl, text);
  } catch (err) {
    logger.debug({ err, robotsUrl }, "robots.txt fetch fallito - allow");
    return null;
  }
}

/**
 * Verifica se l'URL può essere scrapato secondo robots.txt del dominio.
 * LENIENT: se robots.txt è irraggiungibile o malformato, default ALLOW.
 * Policy strict sarebbe DENY ma bloccherebbe siti con robots.txt assente.
 */
export async function isAllowedByRobots(url: string): Promise<boolean> {
  try {
    const u = new URL(url);
    const origin = u.origin;
    const now = Date.now();
    const cached = cache.get(origin);
    let parser: Robot | null;
    if (cached && now - cached.at < ROBOTS_TTL_MS) {
      parser = cached.parser;
    } else {
      parser = await fetchRobots(origin);
      if (parser) cache.set(origin, { parser, at: now });
    }
    if (!parser) return true;
    const allowed = parser.isAllowed(url, env.USER_AGENT);
    // isAllowed può tornare undefined (nessuna regola matcha) → default allow.
    return allowed ?? true;
  } catch (err) {
    logger.debug({ err, url }, "robots check errore - allow");
    return true;
  }
}

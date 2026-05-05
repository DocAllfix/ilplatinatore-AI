/**
 * IGDB Client — Twitch OAuth2 + IGDB v4 game search.
 *
 * Opzionale: se IGDB_CLIENT_ID o IGDB_CLIENT_SECRET sono vuoti,
 * searchByTitle() ritorna [] e il caller fa fallback minimal.
 *
 * Token Twitch: cachato in Redis (TTL 30gg) per non sprecare quota.
 * Rate limit IGDB: max 4 req/s → 260ms di delay tra chiamate successive.
 */

import { redis } from "@/config/redis.js";
import { env } from "@/config/env.js";
import { logger } from "@/utils/logger.js";

const TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const IGDB_BASE = "https://api.igdb.com/v4";
const TOKEN_REDIS_KEY = "igdb:twitch_token";
const TOKEN_TTL_SECONDS = 30 * 24 * 3600; // 30 giorni (token Twitch dura ~60gg)

// Mapping platform IGDB ID → stringa leggibile.
// Allineato con l'harvester Python (igdb.py _map_platform_ids).
const PLATFORM_MAP: Record<number, string> = {
  6:   "PC",
  48:  "PS4",
  167: "PS5",
  49:  "Xbox One",
  169: "Xbox Series X/S",
  130: "Nintendo Switch",
  471: "Nintendo Switch 2",
};

export interface IgdbGame {
  igdb_id: number;
  title: string;
  slug: string;
  cover_url: string | null;
  platforms: string[];
  genre: string[];
  release_date: Date | null;
}

async function _fetchToken(): Promise<string> {
  const cached = await redis.get(TOKEN_REDIS_KEY).catch(() => null);
  if (cached) return cached;

  const params = new URLSearchParams({
    client_id:     env.IGDB_CLIENT_ID,
    client_secret: env.IGDB_CLIENT_SECRET,
    grant_type:    "client_credentials",
  });

  const res = await fetch(`${TWITCH_TOKEN_URL}?${params.toString()}`, {
    method: "POST",
  });

  if (!res.ok) {
    throw new Error(`Twitch token fetch failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as { access_token: string };
  const token = data.access_token;

  await redis.setex(TOKEN_REDIS_KEY, TOKEN_TTL_SECONDS, token).catch(() => {});
  logger.info("IGDB: token Twitch acquisito e cachato");
  return token;
}

async function _query(apicalypseBody: string, retried = false): Promise<unknown[]> {
  const token = await _fetchToken();

  const res = await fetch(`${IGDB_BASE}/games`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Client-ID":     env.IGDB_CLIENT_ID,
      "Content-Type":  "text/plain",
    },
    body: apicalypseBody,
  });

  if (res.status === 401 && !retried) {
    // Token revocato — cancella cache e riprova una volta.
    await redis.del(TOKEN_REDIS_KEY).catch(() => {});
    logger.warn("IGDB: 401 ricevuto, token invalidato — retry");
    return _query(apicalypseBody, true);
  }

  if (!res.ok) {
    throw new Error(`IGDB query failed: ${res.status} ${res.statusText}`);
  }

  return (await res.json()) as unknown[];
}

async function _resolveCoverUrl(coverId: number): Promise<string | null> {
  try {
    const res = await fetch(`${IGDB_BASE}/covers`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${await _fetchToken()}`,
        "Client-ID":     env.IGDB_CLIENT_ID,
        "Content-Type":  "text/plain",
      },
      body: `fields url; where id = ${coverId};`,
    });
    if (!res.ok) return null;
    const data = await res.json() as Array<{ url?: string }>;
    const raw = data[0]?.url;
    if (!raw) return null;
    // IGDB restituisce URL senza protocollo (//images.igdb.com/...) e in bassa res.
    // Sostituiamo thumb con cover_big (264×374).
    return raw.replace(/^\/\//, "https://").replace("t_thumb", "t_cover_big");
  } catch {
    return null;
  }
}

function _mapPlatforms(platformIds: number[] | undefined): string[] {
  if (!platformIds?.length) return [];
  return platformIds
    .map((id) => PLATFORM_MAP[id])
    .filter((p): p is string => p !== undefined);
}

/**
 * Cerca giochi IGDB per titolo testuale.
 * Ritorna [] se le credenziali non sono configurate o la ricerca fallisce.
 */
async function searchByTitle(title: string, limit = 3): Promise<IgdbGame[]> {
  if (!env.IGDB_CLIENT_ID || !env.IGDB_CLIENT_SECRET) {
    logger.debug("IGDB: credenziali non configurate, skip search");
    return [];
  }

  // Sanifica il titolo per APICALYPSE (escape doppi apici)
  const safeTitle = title.replace(/"/g, '\\"').slice(0, 200);
  const body = `search "${safeTitle}"; fields name,slug,cover,platforms,first_release_date,genres; limit ${limit};`;

  let raw: unknown[];
  try {
    raw = await _query(body);
  } catch (err) {
    logger.warn({ err, title }, "IGDB: searchByTitle fallito");
    return [];
  }

  if (!Array.isArray(raw) || raw.length === 0) return [];

  const games: IgdbGame[] = [];
  for (const r of raw) {
    const rec = r as Record<string, unknown>;
    const igdb_id = typeof rec.id === "number" ? rec.id : null;
    if (!igdb_id) continue;

    const rawSlug = typeof rec.slug === "string" ? rec.slug : null;
    const title_out = typeof rec.name === "string" ? rec.name : safeTitle;

    // Cover: fetch asincrono solo se presente per non ritardare troppo.
    const cover_url = typeof rec.cover === "number"
      ? await _resolveCoverUrl(rec.cover)
      : null;

    const platforms = _mapPlatforms(
      Array.isArray(rec.platforms) ? rec.platforms as number[] : undefined,
    );

    const release_date = typeof rec.first_release_date === "number"
      ? new Date(rec.first_release_date * 1000)
      : null;

    games.push({
      igdb_id,
      title:  title_out,
      slug:   rawSlug ?? title_out.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
      cover_url,
      platforms,
      genre:  [],
      release_date,
    });
  }

  logger.info({ title, found: games.length }, "IGDB: searchByTitle completata");
  return games;
}

export const IgdbClient = { searchByTitle };

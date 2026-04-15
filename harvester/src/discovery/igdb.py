"""IGDBDiscovery — popola il catalogo giochi via IGDB API v4.

Autenticazione: Twitch OAuth2 client_credentials.
Token cachato in memoria (~60 giorni di vita).
Rate limit IGDB: 4 req/s → delay 0.25s tra richieste.

Tre feed di discovery:
  1. Popular: giochi più giocati (popularity_primitives) per piattaforma
  2. New releases: usciti negli ultimi N giorni con alto rating/following
  3. Upcoming: non ancora usciti con alto hype, salvati in upcoming_games
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx

from src.config.db import execute, fetch_all, fetch_one
from src.config.logger import get_logger
from src.config.settings import settings
from src.injector.upserter import Upserter

_TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token"
_IGDB_BASE = "https://api.igdb.com/v4"

# Platform IDs IGDB.
PLATFORM_PS5 = 167
PLATFORM_PS4 = 48
PLATFORM_XBOX_SERIES = 169
PLATFORM_XBOX_ONE = 49
PLATFORM_PC = 6
PLATFORM_SWITCH = 130
PLATFORM_SWITCH_2 = 471

# Tutte le piattaforme supportate.
ALL_PLATFORMS = [
    PLATFORM_PS5, PLATFORM_PS4,
    PLATFORM_XBOX_SERIES, PLATFORM_XBOX_ONE,
    PLATFORM_PC,
    PLATFORM_SWITCH, PLATFORM_SWITCH_2,
]

# Piattaforme MAI ammesse: se un gioco ha *una qualsiasi* di queste nell'elenco
# platforms → SCARTATO, anche se ha anche PC/console. Richiesta esplicita:
# nessun gioco mobile o VR nel catalogo (anche cross-platform tipo Fortnite Mobile).
# 34=Android, 39=iOS, 55=Legacy Mobile, 405=Meta Quest, 74=Windows Phone.
MOBILE_VR_PLATFORM_IDS = {34, 39, 55, 405, 74}

# Soglie qualità per filtrare junk PC senza traction.
# Un gioco passa se soddisfa ALMENO UNA di queste → preserva AAA day-1 (alti hypes)
# e giochi stabiliti (alto rating_count), taglia indie NSFW/spam senza traction.
_QUALITY_MIN_RATING_COUNT = 3
_QUALITY_MIN_HYPES = 5
_QUALITY_MIN_FOLLOWS = 20

# Delay tra richieste IGDB (4 req/s max).
_IGDB_DELAY_S = 0.25


class IGDBDiscovery:
    """Client IGDB per discovery automatica giochi e popolamento catalogo DB."""

    def __init__(self, upserter: Upserter | None = None) -> None:
        self._client = httpx.AsyncClient(timeout=30.0)
        self._logger = get_logger(self.__class__.__name__)
        self._upserter = upserter or Upserter()

        # Token cache: (access_token, expires_at_monotonic)
        self._token: str | None = None
        self._token_expires_at: float = 0.0

    # ── Auth ─────────────────────────────────────────────────────────────────

    async def _get_token(self) -> str:
        """Ritorna il token Twitch OAuth, richiedendolo/rinnovandolo se scaduto."""
        now = time.monotonic()
        # Rinnova 60 secondi prima della scadenza per sicurezza.
        if self._token and now < self._token_expires_at - 60:
            return self._token

        resp = await self._client.post(
            _TWITCH_TOKEN_URL,
            params={
                "client_id": settings.igdb_client_id,
                "client_secret": settings.igdb_client_secret,
                "grant_type": "client_credentials",
            },
        )
        resp.raise_for_status()
        data = resp.json()

        self._token = data["access_token"]
        # expires_in è in secondi.
        self._token_expires_at = now + float(data.get("expires_in", 3600))
        self._logger.info(
            "Twitch token rinnovato",
            expires_in_s=data.get("expires_in"),
        )
        return self._token  # type: ignore[return-value]

    # ── IGDB Query generica ─────────────────────────────────────────────────

    async def _query(self, endpoint: str, body: str) -> list[dict[str, Any]]:
        """Esegue una query POST su un endpoint IGDB e ritorna la risposta JSON."""
        token = await self._get_token()
        resp = await self._client.post(
            f"{_IGDB_BASE}/{endpoint}",
            headers={
                "Authorization": f"Bearer {token}",
                "Client-ID": settings.igdb_client_id,
            },
            content=body,
        )
        resp.raise_for_status()
        result: list[dict[str, Any]] = resp.json()
        await asyncio.sleep(_IGDB_DELAY_S)
        return result

    # ── Feed 1: Giochi popolari ──────────────────────────────────────────────

    async def fetch_popular(
        self,
        platform_ids: list[int] | None = None,
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        """Recupera i giochi più giocati via popularity_primitives.

        popularity_type=1 = numero di plays (il ranking più affidabile).
        popularity_primitives non supporta filtri su game.platforms,
        quindi prendiamo un pool più ampio e filtriamo in fetch_game_details.
        Ritorna lista di game IDs con value di popolarità.
        """
        body = (
            f"fields game_id, value, popularity_type;"
            f" where popularity_type = 1;"
            f" sort value desc;"
            f" limit {limit};"
        )
        results = await self._query("popularity_primitives", body)
        self._logger.info("Popular games ricevuti", count=len(results))
        return results

    async def fetch_game_details(self, igdb_ids: list[int]) -> list[dict[str, Any]]:
        """Recupera i dettagli dei giochi per una lista di IGDB IDs."""
        if not igdb_ids:
            return []
        ids_str = ",".join(str(i) for i in igdb_ids)
        body = (
            f"fields name, slug, platforms, first_release_date,"
            f" genres, cover, aggregated_rating, total_rating_count,"
            f" follows, hypes;"
            f" where id = ({ids_str});"
            f" limit 500;"
        )
        return await self._query("games", body)

    # ── Feed 2: Nuove uscite ─────────────────────────────────────────────────

    async def fetch_new_releases(
        self,
        platform_ids: list[int] | None = None,
        days: int = 30,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """Recupera giochi usciti negli ultimi N giorni per piattaforma.

        Usa l'endpoint /release_dates e ritorna dati con game info embedded.
        """
        pids = platform_ids or ALL_PLATFORMS
        ids_str = ",".join(str(p) for p in pids)
        cutoff = int(time.time()) - (days * 86400)
        body = (
            f"fields game.name, game.slug, game.platforms,"
            f" game.aggregated_rating, game.total_rating_count,"
            f" game.follows, game.hypes, date;"
            f" where date >= {cutoff}"
            f" & platform = ({ids_str});"
            f" sort date desc;"
            f" limit {limit};"
        )
        results = await self._query("release_dates", body)
        self._logger.info("New releases ricevuti", count=len(results), days=days)
        return results

    # ── Feed 3: Upcoming ─────────────────────────────────────────────────────

    async def fetch_upcoming(
        self,
        platform_ids: list[int] | None = None,
        min_hypes: int = 10,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        """Recupera giochi upcoming con alto hype/following.

        status=2 = "alpha", 3 = "beta", 4 = "early_access", 7 = "rumored"
        Ma il campo più utile è first_release_date nel futuro.
        """
        pids = platform_ids or ALL_PLATFORMS
        ids_str = ",".join(str(p) for p in pids)
        now_ts = int(time.time())
        body = (
            f"fields name, slug, platforms, first_release_date,"
            f" hypes, follows, genres, cover;"
            f" where platforms = ({ids_str})"
            f" & first_release_date > {now_ts}"
            f" & hypes >= {min_hypes};"
            f" sort hypes desc;"
            f" limit {limit};"
        )
        results = await self._query("games", body)
        self._logger.info("Upcoming games ricevuti", count=len(results))
        return results

    # ── Discovery orchestrata: popular + new releases ─────────────────────────

    async def discover_popular_and_new(
        self,
        platform_ids: list[int] | None = None,
    ) -> dict[str, int]:
        """Scopre giochi popolari e nuove uscite, li inserisce in games.

        Ritorna stats: {'popular_added': N, 'new_releases_added': N, 'skipped': N}
        """
        stats = {
            "popular_added": 0,
            "new_releases_added": 0,
            "skipped": 0,
            "skipped_mobile": 0,
            "skipped_low_quality": 0,
        }

        # ── Popular games ────────────────────────────────────────────────────
        # popularity_primitives non filtra per piattaforma: prendiamo top 200
        # e filtriamo dopo fetch_game_details.
        pids = set(platform_ids or ALL_PLATFORMS)
        popular_raw = await self.fetch_popular(limit=200)
        if popular_raw:
            game_ids = [r["game_id"] for r in popular_raw if "game_id" in r]
            if game_ids:
                details = await self.fetch_game_details(game_ids)
                for game in details:
                    verdict = self._accept_game(game, pids)
                    if verdict == "mobile":
                        stats["skipped_mobile"] += 1
                        continue
                    if verdict == "low_quality":
                        stats["skipped_low_quality"] += 1
                        continue
                    if verdict == "no_platform":
                        stats["skipped"] += 1
                        continue
                    added = await self._ingest_game(game)
                    if added:
                        stats["popular_added"] += 1
                    else:
                        stats["skipped"] += 1

        # ── New releases ─────────────────────────────────────────────────────
        releases = await self.fetch_new_releases(platform_ids, days=30)
        for release in releases:
            game_data = release.get("game")
            if not game_data or not isinstance(game_data, dict):
                continue
            verdict = self._accept_game(game_data, pids)
            if verdict == "mobile":
                stats["skipped_mobile"] += 1
                continue
            if verdict == "low_quality":
                stats["skipped_low_quality"] += 1
                continue
            if verdict == "no_platform":
                stats["skipped"] += 1
                continue
            added = await self._ingest_game(game_data)
            if added:
                stats["new_releases_added"] += 1
            else:
                stats["skipped"] += 1

        self._logger.info("discover_popular_and_new completato", **stats)
        return stats

    # ── Discovery upcoming → tabella separata ─────────────────────────────────

    async def discover_upcoming(
        self,
        platform_ids: list[int] | None = None,
    ) -> dict[str, int]:
        """Scopre giochi upcoming e li salva in upcoming_games.

        Non li mette in games — saranno migrati quando escono.
        Ritorna stats: {'added': N, 'updated': N, 'skipped': N}
        """
        stats = {"added": 0, "updated": 0, "skipped": 0}

        upcoming = await self.fetch_upcoming(platform_ids, min_hypes=10)
        for game in upcoming:
            igdb_id = game.get("id")
            name = game.get("name", "").strip()
            if not igdb_id or not name:
                continue

            # Controlla se già in games (processato in precedenza)
            existing = await fetch_one(
                "SELECT id FROM games WHERE igdb_id = %s",
                (igdb_id,),
            )
            if existing:
                stats["skipped"] += 1
                continue

            # Estrai piattaforme come nomi leggibili
            platforms = self._map_platform_ids(game.get("platforms", []))
            slug = game.get("slug", "")
            release_ts = game.get("first_release_date")
            release_date = None
            if release_ts:
                import datetime
                release_date = datetime.date.fromtimestamp(release_ts)

            await execute(
                """
                -- Inserisce o aggiorna upcoming game (dedup via igdb_id).
                INSERT INTO upcoming_games
                    (igdb_id, title, slug, platforms, expected_date, hypes, follows)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (igdb_id) DO UPDATE SET
                    title = EXCLUDED.title,
                    hypes = EXCLUDED.hypes,
                    follows = EXCLUDED.follows,
                    expected_date = COALESCE(EXCLUDED.expected_date, upcoming_games.expected_date),
                    updated_at = NOW()
                """,
                (
                    igdb_id,
                    name,
                    slug,
                    platforms,
                    release_date,
                    game.get("hypes", 0),
                    game.get("follows", 0),
                ),
            )
            # Verifica se è un update o insert
            existing_upcoming = await fetch_one(
                "SELECT id FROM upcoming_games WHERE igdb_id = %s AND created_at < updated_at",
                (igdb_id,),
            )
            if existing_upcoming:
                stats["updated"] += 1
            else:
                stats["added"] += 1

        self._logger.info("discover_upcoming completato", **stats)
        return stats

    # ── Check released: migra upcoming → games ───────────────────────────────

    async def check_released_upcoming(self) -> dict[str, int]:
        """Controlla se giochi in upcoming_games sono stati rilasciati.

        Per ogni upcoming non processato, verifica su IGDB se ha
        first_release_date nel passato. Se sì, lo migra a games.
        Ritorna stats: {'migrated': N, 'still_upcoming': N}
        """
        stats = {"migrated": 0, "still_upcoming": 0}

        pending = await fetch_all(
            """SELECT igdb_id, title, slug, platforms
               FROM upcoming_games
               WHERE status = 'upcoming' AND processed = FALSE
               ORDER BY expected_date ASC NULLS LAST""",
        )
        if not pending:
            return stats

        igdb_ids = [r["igdb_id"] for r in pending]
        now_ts = int(time.time())

        # Batch fetch da IGDB per controllare release date
        details = await self.fetch_game_details(igdb_ids)
        released_ids: set[int] = set()
        for game in details:
            release_ts = game.get("first_release_date")
            if release_ts and release_ts <= now_ts:
                released_ids.add(game["id"])

        for row in pending:
            igdb_id = row["igdb_id"]
            if igdb_id not in released_ids:
                stats["still_upcoming"] += 1
                continue

            # Migra a games
            game_id = await self._upserter.find_or_create_game(row["title"])
            # Salva igdb_id su games
            await execute(
                """UPDATE games SET igdb_id = %s,
                   metadata = metadata || jsonb_build_object('igdb_id', %s::text)
                   WHERE id = %s AND igdb_id IS NULL""",
                (igdb_id, str(igdb_id), game_id),
            )

            # Segna come processato
            await execute(
                """UPDATE upcoming_games
                   SET status = 'released', processed = TRUE, updated_at = NOW()
                   WHERE igdb_id = %s""",
                (igdb_id,),
            )

            stats["migrated"] += 1
            self._logger.info(
                "Upcoming migrato a games",
                title=row["title"],
                igdb_id=igdb_id,
                game_id=game_id,
            )

        self._logger.info("check_released_upcoming completato", **stats)
        return stats

    # ── Legacy: discover_all_games (invariato, per compatibilità) ────────────

    async def fetch_games(
        self,
        platform_ids: list[int],
        offset: int = 0,
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        """Recupera giochi IGDB per le piattaforme indicate.

        IGDB usa POST con body query (non GET).
        Ritorna lista di dict con campi IGDB grezzi.
        """
        ids_str = ",".join(str(pid) for pid in platform_ids)
        body = (
            f"fields name,slug,platforms,first_release_date,genres,cover;"
            f" where platforms = ({ids_str});"
            f" sort popularity desc;"
            f" limit {limit};"
            f" offset {offset};"
        )
        return await self._query("games", body)

    async def discover_all_games(self, platform_ids: list[int]) -> int:
        """Scarica tutti i giochi IGDB per le piattaforme e li inserisce nel DB.

        Pagina con offset crescente finché IGDB ritorna lista vuota.
        Inserisce ogni gioco via upserter.find_or_create_game e aggiunge alias.
        Rispetta il rate limit IGDB: 0.25s tra richieste (4 req/s max).
        Ritorna il totale giochi inseriti/aggiornati.
        """
        total = 0
        offset = 0
        limit = 500

        while True:
            try:
                games = await self.fetch_games(platform_ids, offset=offset, limit=limit)
            except Exception as exc:
                self._logger.error(
                    "fetch_games fallito",
                    offset=offset,
                    error=str(exc),
                )
                break

            if not games:
                # Nessun risultato → fine paginazione.
                break

            for game in games:
                game_name: str = game.get("name", "").strip()
                if not game_name:
                    continue
                try:
                    game_id = await self._upserter.find_or_create_game(game_name)
                    await self._insert_aliases(game_id, game_name, game.get("slug"))
                    total += 1
                except Exception as exc:
                    self._logger.error(
                        "find_or_create_game fallito",
                        game=game_name,
                        error=str(exc),
                    )

            offset += limit

        self._logger.info("discover_all_games completato", total=total, platforms=platform_ids)
        return total

    # ── Helpers interni ──────────────────────────────────────────────────────

    async def _ingest_game(self, game_data: dict[str, Any]) -> bool:
        """Inserisce un gioco da dati IGDB se non già presente.

        Salva igdb_id sia come colonna dedicata che in metadata JSONB.
        Ritorna True se il gioco è stato aggiunto, False se skippato.
        """
        igdb_id = game_data.get("id")
        name = game_data.get("name", "").strip()
        if not name:
            return False

        # Dedup: controlla se igdb_id già presente
        if igdb_id:
            existing = await fetch_one(
                "SELECT id FROM games WHERE igdb_id = %s",
                (igdb_id,),
            )
            if existing:
                return False

        # Inserisci via upserter (gestisce dedup per slug/alias)
        game_id = await self._upserter.find_or_create_game(name)
        await self._insert_aliases(game_id, name, game_data.get("slug"))

        # Salva igdb_id
        if igdb_id:
            await execute(
                """UPDATE games SET igdb_id = %s,
                   metadata = metadata || jsonb_build_object('igdb_id', %s::text)
                   WHERE id = %s AND igdb_id IS NULL""",
                (igdb_id, str(igdb_id), game_id),
            )

        # Aggiorna piattaforme se mancanti
        platforms = self._map_platform_ids(game_data.get("platforms", []))
        if platforms:
            await execute(
                """UPDATE games SET platform = %s
                   WHERE id = %s AND (platform IS NULL OR platform = '{}')""",
                (platforms, game_id),
            )

        self._logger.info(
            "Gioco IGDB ingestito",
            game_title=name,
            game_id=game_id,
            igdb_id=igdb_id,
        )
        return True

    @staticmethod
    def _accept_game(
        game: dict[str, Any], allowed_pids: set[int]
    ) -> str:
        """Verdetto di ammissibilità per un gioco IGDB.

        Ritorna: 'ok' | 'mobile' | 'low_quality' | 'no_platform'.

        Regole (ordine di precedenza):
          1. Se platforms contiene iOS/Android/Quest/WinPhone → 'mobile' (scarto
             categorico, anche se cross-platform con PC/console: richiesta
             esplicita utente).
          2. Se nessuna platform in `allowed_pids` (PS4/PS5/Xbox/PC/Switch) →
             'no_platform'.
          3. Se total_rating_count < 3 AND hypes < 5 AND follows < 20 →
             'low_quality' (taglia junk senza traction, preserva AAA day-1).
          4. Altrimenti → 'ok'.
        """
        game_pids = set(game.get("platforms", []) or [])

        # 1. Esclusione mobile/VR (hard reject)
        if game_pids & MOBILE_VR_PLATFORM_IDS:
            return "mobile"

        # 2. Almeno una piattaforma console/PC supportata
        if not (game_pids & allowed_pids):
            return "no_platform"

        # 3. Quality gate: almeno uno dei segnali di traction
        rc = int(game.get("total_rating_count") or 0)
        hy = int(game.get("hypes") or 0)
        fo = int(game.get("follows") or 0)
        if (
            rc < _QUALITY_MIN_RATING_COUNT
            and hy < _QUALITY_MIN_HYPES
            and fo < _QUALITY_MIN_FOLLOWS
        ):
            return "low_quality"

        return "ok"

    @staticmethod
    def _map_platform_ids(igdb_platform_ids: list[int]) -> list[str]:
        """Mappa gli ID piattaforma IGDB ai nomi leggibili."""
        mapping = {
            PLATFORM_PS5: "PS5",
            PLATFORM_PS4: "PS4",
            PLATFORM_XBOX_SERIES: "Xbox Series X/S",
            PLATFORM_XBOX_ONE: "Xbox One",
            PLATFORM_PC: "PC",
            PLATFORM_SWITCH: "Nintendo Switch",
            PLATFORM_SWITCH_2: "Nintendo Switch 2",
        }
        return [mapping[pid] for pid in igdb_platform_ids if pid in mapping]

    async def _insert_aliases(
        self, game_id: int, game_name: str, igdb_slug: str | None
    ) -> None:
        """Inserisce alias per il gioco: titolo completo + slug IGDB."""
        from src.config.db import _get_pool

        pool = await _get_pool()
        async with pool.connection() as conn:
            # Alias: titolo completo (per match case-insensitive futuro).
            await conn.execute(
                # Inserisce alias titolo + slug IGDB; ignora duplicati.
                "INSERT INTO game_aliases (game_id, alias) VALUES (%s, %s) "
                "ON CONFLICT (game_id, lower(alias)) DO NOTHING",
                (game_id, game_name),
            )
            if igdb_slug:
                await conn.execute(
                    # Alias slug IGDB per matching alternativo.
                    "INSERT INTO game_aliases (game_id, alias) VALUES (%s, %s) "
                    "ON CONFLICT (game_id, lower(alias)) DO NOTHING",
                    (game_id, igdb_slug),
                )

    # ── Steam appid resolution via IGDB external_games ─────────────────────

    async def resolve_steam_appids(self) -> dict[str, int]:
        """Risolve steam_appid per giochi con igdb_id ma senza steam_appid.

        Usa l'endpoint IGDB /external_games con category=1 (Steam).
        Aggiorna games.steam_appid e games.metadata.
        Ritorna stats: {'resolved': N, 'no_steam': N, 'total_checked': N}
        """
        stats = {"resolved": 0, "no_steam": 0, "total_checked": 0}

        # Giochi con igdb_id ma senza steam_appid
        games = await fetch_all(
            """SELECT id, igdb_id, title FROM games
               WHERE igdb_id IS NOT NULL AND steam_appid IS NULL
               ORDER BY id"""
        )
        if not games:
            self._logger.info("Tutti i giochi con igdb_id hanno già steam_appid")
            return stats

        stats["total_checked"] = len(games)

        # Batch query IGDB: max 500 per richiesta
        igdb_ids = [g["igdb_id"] for g in games]
        igdb_to_game = {g["igdb_id"]: g for g in games}

        for batch_start in range(0, len(igdb_ids), 500):
            batch = igdb_ids[batch_start : batch_start + 500]
            ids_str = ",".join(str(i) for i in batch)
            body = (
                f"fields game, uid, category;"
                f" where game = ({ids_str}) & category = 1;"
                f" limit 500;"
            )
            try:
                results = await self._query("external_games", body)
            except Exception as exc:
                self._logger.error(
                    "external_games query fallita", error=str(exc)
                )
                continue

            # Mappa igdb_id → steam_appid
            resolved_map: dict[int, int] = {}
            for ext in results:
                igdb_id = ext.get("game")
                uid = ext.get("uid")
                if igdb_id and uid:
                    try:
                        resolved_map[igdb_id] = int(uid)
                    except (ValueError, TypeError):
                        pass

            # Aggiorna DB per ogni gioco nel batch
            for igdb_id in batch:
                steam_appid = resolved_map.get(igdb_id)
                if not steam_appid:
                    stats["no_steam"] += 1
                    continue

                game = igdb_to_game[igdb_id]
                await execute(
                    """UPDATE games
                       SET steam_appid = %s,
                           metadata = metadata || jsonb_build_object(
                               'steam_appid', %s::text
                           )
                       WHERE id = %s AND steam_appid IS NULL""",
                    (steam_appid, str(steam_appid), game["id"]),
                )
                stats["resolved"] += 1
                self._logger.debug(
                    "Steam appid risolto",
                    game_title=game["title"],
                    steam_appid=steam_appid,
                )

        self._logger.info("resolve_steam_appids completato", **stats)
        return stats

    async def close(self) -> None:
        """Chiude il client httpx."""
        await self._client.aclose()

"""SteamAchievementFetcher — recupera achievement Steam in 10 lingue.

Endpoint principali:
  - ISteamUserStats/GetSchemaForGame/v2  → nomi+descrizioni per lingua
  - ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2 → rarity %

Steam supporta ~29 lingue; noi mappiamo le stesse 10 del PSN fetcher per
consistenza con le colonne DB (name_en, name_it, ..., detail_zh_hant).

Rate limit Steam: 100.000 req/giorno, nessun rate limit per-secondo
documentato. Usiamo 50ms di delay conservativo tra richieste.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx

from src.config.db import execute, fetch_all
from src.config.logger import get_logger
from src.config.settings import settings

# ── Costanti ──────────────────────────────────────────────────────────────────

_SCHEMA_URL = (
    "https://api.steampowered.com/ISteamUserStats"
    "/GetSchemaForGame/v2/"
)
_GLOBAL_PCT_URL = (
    "https://api.steampowered.com/ISteamUserStats"
    "/GetGlobalAchievementPercentagesForApp/v2/"
)
_INTER_LANG_DELAY_S = 0.05  # 50ms tra richieste per lingua

# Steam language code → (name_field, detail_field) nel DB.
# Stesse 10 lingue di PSN per consistenza.
_LANG_MAP: dict[str, tuple[str, str]] = {
    "english": ("name_en", "detail_en"),
    "italian": ("name_it", "detail_it"),
    "french": ("name_fr", "detail_fr"),
    "german": ("name_de", "detail_de"),
    "spanish": ("name_es", "detail_es"),
    "portuguese": ("name_pt", "detail_pt"),
    "japanese": ("name_ja", "detail_ja"),
    "koreana": ("name_ko", "detail_ko"),
    "schinese": ("name_zh_hans", "detail_zh_hans"),
    "tchinese": ("name_zh_hant", "detail_zh_hant"),
}


# ── Classe principale ────────────────────────────────────────────────────────


class SteamAchievementFetcher:
    """Recupera achievement Steam con nomi multilingua e li salva nel DB."""

    def __init__(self) -> None:
        self._logger = get_logger(self.__class__.__name__)
        self._client = httpx.AsyncClient(timeout=15.0)
        self._sem = asyncio.Semaphore(5)

    # ── Fetch singola lingua ─────────────────────────────────────────────────

    async def _fetch_schema(
        self, appid: int, lang: str
    ) -> tuple[str, list[dict[str, Any]]]:
        """Fetcha lo schema achievement per una lingua.

        Ritorna (lang, lista_achievement) dove ogni achievement ha:
        name (apiname), displayName, description, icon, icongray.
        """
        async with self._sem:
            resp = await self._client.get(
                _SCHEMA_URL,
                params={
                    "appid": appid,
                    "key": settings.steam_api_key,
                    "l": lang,
                },
            )
            resp.raise_for_status()

        data = resp.json().get("game", {})
        achievements = (
            data.get("availableGameStats", {}).get("achievements", [])
        )
        await asyncio.sleep(_INTER_LANG_DELAY_S)
        return lang, achievements

    # ── Fetch rarity globale ─────────────────────────────────────────────────

    async def _fetch_global_percentages(
        self, appid: int
    ) -> dict[str, float]:
        """Fetcha le percentuali globali di completamento per achievement.

        Ritorna {apiname: percent}.
        """
        try:
            resp = await self._client.get(
                _GLOBAL_PCT_URL, params={"gameid": appid}
            )
            resp.raise_for_status()
        except httpx.HTTPStatusError:
            self._logger.warning(
                "Global percentages non disponibili",
                steam_appid=appid,
            )
            return {}

        achievements = (
            resp.json()
            .get("achievementpercentages", {})
            .get("achievements", [])
        )
        return {
            a["name"]: float(a["percent"])
            for a in achievements
            if "name" in a and "percent" in a
        }

    # ── Fetch tutte le lingue + merge ────────────────────────────────────────

    async def fetch_game_achievements(
        self, steam_appid: int
    ) -> list[dict[str, Any]]:
        """Fetcha tutti gli achievement in 10 lingue + rarity %.

        Ritorna lista di dict pronti per upsert_achievements.
        """
        langs = list(_LANG_MAP.keys())

        # Fetch tutte le lingue in parallelo + rarity
        tasks = [self._fetch_schema(steam_appid, lg) for lg in langs]
        tasks_with_pct = asyncio.gather(
            *tasks,
            self._fetch_global_percentages(steam_appid),
            return_exceptions=True,
        )
        results = await tasks_with_pct

        # L'ultimo risultato è il dict delle percentuali
        pct_result = results[-1]
        pct_map: dict[str, float] = (
            pct_result if isinstance(pct_result, dict) else {}
        )

        lang_results = results[:-1]

        # Merge: {apiname → dict con tutti i campi}
        merged: dict[str, dict[str, Any]] = {}

        for result in lang_results:
            if isinstance(result, Exception):
                self._logger.warning(
                    "Steam schema fetch fallito per una lingua",
                    error=str(result),
                )
                continue

            lang, achievements = result
            name_field, detail_field = _LANG_MAP[lang]

            for ach in achievements:
                apiname = ach.get("name")
                if not apiname:
                    continue

                if apiname not in merged:
                    merged[apiname] = {
                        "steam_achievement_id": apiname,
                        "icon_url": ach.get("icon", ""),
                    }

                merged[apiname][name_field] = ach.get("displayName", "")
                merged[apiname][detail_field] = ach.get("description", "")

        # Aggiungi rarity % dal global endpoint
        for apiname, data in merged.items():
            if apiname in pct_map:
                data["rarity_pct"] = round(pct_map[apiname], 2)

        self._logger.info(
            "Achievement Steam fetchati",
            steam_appid=steam_appid,
            count=len(merged),
        )
        return list(merged.values())

    # ── Upsert DB ────────────────────────────────────────────────────────────

    async def upsert_achievements(
        self, game_id: int, achievements: list[dict]
    ) -> int:
        """Inserisce o aggiorna achievement Steam nel DB.

        ON CONFLICT sull'indice parziale (game_id, steam_achievement_id).
        Ritorna il numero di achievement processati.
        """
        if not achievements:
            return 0

        for ach in achievements:
            name = ach.get("name_en") or ""
            await execute(
                """
                -- Upsert achievement Steam: inserisce se nuovo, aggiorna se esiste.
                -- ON CONFLICT sull'indice parziale idx_trophies_steam_id (migration 023).
                INSERT INTO trophies (
                    game_id, name, hidden, rarity_pct, icon_url,
                    steam_achievement_id,
                    name_en, name_it, name_fr, name_de, name_es,
                    name_pt, name_ja, name_ko, name_zh_hans, name_zh_hant,
                    detail_en, detail_it, detail_fr, detail_de, detail_es,
                    detail_pt, detail_ja, detail_ko, detail_zh_hans,
                    detail_zh_hant,
                    rarity_source
                ) VALUES (
                    %s, %s, false, %s, %s,
                    %s,
                    %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s,
                    %s, %s, %s, %s,
                    %s,
                    'steam_official'
                )
                ON CONFLICT (game_id, steam_achievement_id)
                WHERE steam_achievement_id IS NOT NULL
                DO UPDATE SET
                    name         = EXCLUDED.name,
                    name_en      = EXCLUDED.name_en,
                    name_it      = EXCLUDED.name_it,
                    name_fr      = EXCLUDED.name_fr,
                    name_de      = EXCLUDED.name_de,
                    name_es      = EXCLUDED.name_es,
                    name_pt      = EXCLUDED.name_pt,
                    name_ja      = EXCLUDED.name_ja,
                    name_ko      = EXCLUDED.name_ko,
                    name_zh_hans = EXCLUDED.name_zh_hans,
                    name_zh_hant = EXCLUDED.name_zh_hant,
                    detail_en    = EXCLUDED.detail_en,
                    detail_it    = EXCLUDED.detail_it,
                    detail_fr    = EXCLUDED.detail_fr,
                    detail_de    = EXCLUDED.detail_de,
                    detail_es    = EXCLUDED.detail_es,
                    detail_pt    = EXCLUDED.detail_pt,
                    detail_ja    = EXCLUDED.detail_ja,
                    detail_ko    = EXCLUDED.detail_ko,
                    detail_zh_hans = EXCLUDED.detail_zh_hans,
                    detail_zh_hant = EXCLUDED.detail_zh_hant,
                    icon_url     = EXCLUDED.icon_url,
                    rarity_pct   = COALESCE(
                        EXCLUDED.rarity_pct, trophies.rarity_pct
                    ),
                    rarity_source = 'steam_official'
                """,
                (
                    game_id,
                    name,
                    ach.get("rarity_pct"),
                    ach.get("icon_url"),
                    ach.get("steam_achievement_id"),
                    ach.get("name_en", ""),
                    ach.get("name_it", ""),
                    ach.get("name_fr", ""),
                    ach.get("name_de", ""),
                    ach.get("name_es", ""),
                    ach.get("name_pt", ""),
                    ach.get("name_ja", ""),
                    ach.get("name_ko", ""),
                    ach.get("name_zh_hans", ""),
                    ach.get("name_zh_hant", ""),
                    ach.get("detail_en", ""),
                    ach.get("detail_it", ""),
                    ach.get("detail_fr", ""),
                    ach.get("detail_de", ""),
                    ach.get("detail_es", ""),
                    ach.get("detail_pt", ""),
                    ach.get("detail_ja", ""),
                    ach.get("detail_ko", ""),
                    ach.get("detail_zh_hans", ""),
                    ach.get("detail_zh_hant", ""),
                ),
            )

        self._logger.info(
            "Achievement upsertati nel DB",
            game_id=game_id,
            count=len(achievements),
        )
        return len(achievements)

    # ── Entry point ad alto livello ──────────────────────────────────────────

    async def fetch_and_store_for_game(
        self, game_id: int, steam_appid: int, game_title: str
    ) -> int:
        """Fetch + store per un singolo gioco. Ritorna count o 0 su errore."""
        if not settings.steam_api_key:
            self._logger.warning("STEAM_API_KEY non configurata")
            return 0

        try:
            achievements = await self.fetch_game_achievements(steam_appid)
            if not achievements:
                self._logger.info(
                    "Nessun achievement Steam per questo gioco",
                    game_title=game_title,
                    steam_appid=steam_appid,
                )
                return 0
            count = await self.upsert_achievements(game_id, achievements)
            self._logger.info(
                "fetch_and_store_for_game completato",
                game_id=game_id,
                game_title=game_title,
                steam_appid=steam_appid,
                achievements_upserted=count,
            )
            return count
        except Exception as exc:
            self._logger.error(
                "fetch_and_store_for_game fallito",
                game_id=game_id,
                game_title=game_title,
                steam_appid=steam_appid,
                error=str(exc),
            )
            return 0

    # ── Batch: tutti i giochi con steam_appid senza achievement ──────────────

    async def fetch_all_missing(self) -> dict[str, int]:
        """Fetcha achievement per tutti i giochi con steam_appid ma senza
        achievement Steam nel DB.

        Ritorna stats: {'processed': N, 'achievements': N, 'failed': N}
        """
        stats = {"processed": 0, "achievements": 0, "failed": 0}

        games = await fetch_all(
            """
            -- Solo giochi con steam_appid presenti su PC (safety: steam_appid
            -- implica PC, ma filtro esplicito evita edge case di appid errati
            -- su giochi console-only). Legacy con platform vuoto ammessi per
            -- retrocompatibilità.
            SELECT g.id, g.title, g.steam_appid
            FROM games g
            WHERE g.steam_appid IS NOT NULL
              AND (
                'PC' = ANY(g.platform)
                OR g.platform IS NULL
                OR g.platform = '{}'
              )
              AND NOT EXISTS (
                SELECT 1 FROM trophies t
                WHERE t.game_id = g.id
                  AND t.steam_achievement_id IS NOT NULL
              )
            ORDER BY g.id
            """
        )

        if not games:
            self._logger.info(
                "Tutti i giochi con steam_appid hanno già achievement"
            )
            return stats

        self._logger.info(
            "Giochi da fetchare achievement Steam", count=len(games)
        )

        for i, game in enumerate(games, 1):
            self._logger.info(
                f"[{i}/{len(games)}] Fetching achievements",
                game_title=game["title"],
                steam_appid=game["steam_appid"],
            )
            count = await self.fetch_and_store_for_game(
                game["id"], game["steam_appid"], game["title"]
            )
            if count == 0:
                stats["failed"] += 1
            else:
                stats["achievements"] += count
                stats["processed"] += 1

            await asyncio.sleep(0.1)

        self._logger.info("fetch_all_missing completato", **stats)
        return stats

    async def close(self) -> None:
        """Chiude il client httpx."""
        await self._client.aclose()

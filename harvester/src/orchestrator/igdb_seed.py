"""igdb_seed — pipeline completa: IGDB discovery + PSN trofei + Steam achievements.

Uso (dall'interno di Docker o con .env caricato):
    python -m src.orchestrator.igdb_seed
    python -m src.orchestrator.igdb_seed --upcoming-only

Fasi:
  1. IGDB: controlla se upcoming precedenti sono usciti → migra a games
  2. IGDB: scopre giochi popolari + nuove uscite → inserisce in games
  3. IGDB: scopre upcoming → inserisce in upcoming_games
  4. PSN: per ogni nuovo gioco, trova comm_id e fetcha trofei in 10 lingue
  5. IGDB: risolve steam_appid per giochi senza (via external_games)
  6. Steam: per ogni gioco con steam_appid, fetcha achievement in 10 lingue

Prerequisiti:
  - IGDB_CLIENT_ID + IGDB_CLIENT_SECRET configurati in .env
  - PSN_NPSSO configurato in .env (opzionale: senza, solo discovery senza trofei)
  - STEAM_API_KEY configurato in .env (opzionale: senza, skip fase Steam)
  - DB accessibile con migration 023 applicata
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from typing import Any

from src.config.db import close_pool, fetch_all, init_pool
from src.config.logger import get_logger, setup_logging
from src.config.redis_client import close_redis
from src.config.settings import settings
from src.discovery.igdb import IGDBDiscovery

logger = get_logger(__name__)


async def _run(upcoming_only: bool = False) -> int:
    """Entry point asincrono. Ritorna 0 su successo, 1 su errore fatale."""

    # ── Prerequisito: credenziali IGDB ────────────────────────────────────
    if not settings.igdb_client_id or not settings.igdb_client_secret:
        logger.error("IGDB_CLIENT_ID / IGDB_CLIENT_SECRET non configurati in .env")
        return 1

    # ── Init infrastruttura ───────────────────────────────────────────────
    await init_pool()

    igdb = IGDBDiscovery()

    try:
        # ── Fase 1: Check upcoming rilasciati ────────────────────────────
        logger.info("Fase 1/4 — Check upcoming rilasciati")
        released_stats = await igdb.check_released_upcoming()
        logger.info("Fase 1 completata", **released_stats)

        if upcoming_only:
            # ── Solo upcoming: skip popular/new releases ─────────────────
            logger.info("Fase 2/4 — Scoperta upcoming")
            upcoming_stats = await igdb.discover_upcoming()
            logger.info("Fase 2 completata", **upcoming_stats)

            logger.info("igdb_seed completato (upcoming-only)")
            return 0

        # ── Fase 2: Discovery popular + new releases ─────────────────────
        logger.info("Fase 2/4 — Scoperta giochi popolari + nuove uscite")
        discovery_stats = await igdb.discover_popular_and_new()
        logger.info("Fase 2 completata", **discovery_stats)

        # ── Fase 3: Discovery upcoming ───────────────────────────────────
        logger.info("Fase 3/4 — Scoperta upcoming")
        upcoming_stats = await igdb.discover_upcoming()
        logger.info("Fase 3 completata", **upcoming_stats)

        # ── Fase 4: PSN trofei per nuovi giochi ─────────────────────────
        if not settings.psn_npsso:
            logger.warning(
                "PSN_NPSSO non configurato — skip fase trofei PSN."
            )
        else:
            logger.info("Fase 4/6 — PSN discovery comm_id + fetch trofei")
            psn_stats = await _run_psn_trophies()
            logger.info("Fase 4 completata", **psn_stats)

        # ── Fase 5: Risolvi steam_appid via IGDB external_games ─────────
        logger.info("Fase 5/6 — Risoluzione steam_appid via IGDB")
        steam_resolve_stats = await igdb.resolve_steam_appids()
        logger.info("Fase 5 completata", **steam_resolve_stats)

        # ── Fase 6: Steam achievements multilingua ──────────────────────
        if not settings.steam_api_key:
            logger.warning("STEAM_API_KEY non configurata — skip fase Steam.")
        else:
            logger.info("Fase 6/6 — Steam achievement fetch multilingua")
            steam_stats = await _run_steam_achievements()
            logger.info("Fase 6 completata", **steam_stats)

        return 0

    except Exception as exc:
        logger.exception("igdb_seed fallito con errore inatteso", error=str(exc))
        return 1

    finally:
        await igdb.close()
        await close_pool()
        await close_redis()


async def _run_psn_trophies() -> dict[str, Any]:
    """Esegue PsnGameFinder + PsnTrophyFetcher per giochi senza trofei PSN.

    Identico alla Fase 2+3 di psn_seed.py ma filtrato per giochi nuovi
    (senza psn_communication_id o senza trofei).
    """
    from src.discovery.psn_game_finder import PsnGameFinder
    from src.discovery.psn_trophy_fetcher import PsnTrophyFetcher

    fetcher = PsnTrophyFetcher()
    stats: dict[str, Any] = {
        "games_found": 0,
        "games_with_comm_id": 0,
        "trophies_fetched": 0,
        "games_failed": 0,
    }

    try:
        # Autenticazione PSN
        authenticated = await fetcher.authenticate()
        if not authenticated:
            logger.warning("Autenticazione PSN fallita — skip trofei")
            return stats

        # PsnGameFinder per i giochi senza comm_id
        from psnawp_api import PSNAWP

        def _make_psnawp(npsso: str) -> Any:
            p = PSNAWP(npsso)
            _ = p.me().online_id
            return p

        psnawp_inst = await asyncio.to_thread(_make_psnawp, settings.psn_npsso)
        finder = PsnGameFinder(psnawp_inst)
        finder_stats = await finder.populate_all_games()
        stats["games_with_comm_id"] = finder_stats["found"] + finder_stats["skipped"]

        # Fetch trofei per giochi con comm_id ma senza trofei PSN
        games = await fetch_all(
            """
            -- Giochi con comm_id PSN ma senza trofei ancora fetchati.
            -- Safety filter: deve essere effettivamente su PlayStation (o legacy
            -- con platform vuoto, pre-IGDB). Evita di cercare trofei per
            -- giochi che hanno comm_id spurio ma sono marcati solo PC/Xbox.
            SELECT g.id, g.title, g.metadata
            FROM games g
            WHERE g.metadata->>'psn_communication_id' IS NOT NULL
              AND (
                'PS4' = ANY(g.platform)
                OR 'PS5' = ANY(g.platform)
                OR g.platform IS NULL
                OR g.platform = '{}'
              )
              AND NOT EXISTS (
                SELECT 1 FROM trophies t
                WHERE t.game_id = g.id AND t.psn_trophy_id IS NOT NULL
              )
            ORDER BY g.id
            """
        )

        stats["games_found"] = len(games)
        if not games:
            logger.info("Tutti i giochi con comm_id hanno già trofei PSN")
            return stats

        logger.info("Giochi nuovi da fetchare trofei", count=len(games))

        for i, game in enumerate(games, 1):
            game_id: int = game["id"]
            title: str = game["title"]
            logger.info(
                f"[{i}/{len(games)}] Fetching trofei",
                game_title=title,
                game_id=game_id,
            )

            count = await fetcher.fetch_and_store_for_game(game_id, title)
            if count == 0:
                stats["games_failed"] += 1
            else:
                stats["trophies_fetched"] += count

            await asyncio.sleep(0.5)

        return stats

    finally:
        await fetcher.close()


async def _run_steam_achievements() -> dict[str, int]:
    """Fetcha achievement Steam per giochi con steam_appid senza achievement."""
    from src.discovery.steam_achievement_fetcher import SteamAchievementFetcher

    fetcher = SteamAchievementFetcher()
    try:
        return await fetcher.fetch_all_missing()
    finally:
        await fetcher.close()


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="IGDB discovery + PSN trophy seed")
    parser.add_argument(
        "--upcoming-only",
        action="store_true",
        help="Solo check/discovery upcoming, senza popular/new releases",
    )
    return parser.parse_args(argv)


def main() -> None:
    setup_logging()
    args = _parse_args()

    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

    exit_code = asyncio.run(_run(upcoming_only=args.upcoming_only))
    sys.exit(exit_code)


if __name__ == "__main__":
    main()

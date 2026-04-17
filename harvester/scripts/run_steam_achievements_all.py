"""Recupera achievement Steam (con descrizioni) per tutti i giochi PC nel DB.

Pipeline:
  Fase 1 — IGDB resolve_steam_appids: scopre steam_appid per i giochi
            con igdb_id ma senza steam_appid ancora (3.778 giochi)
  Fase 2 — SteamAchievementFetcher: fetcha achievement in 10 lingue
            per tutti i giochi con steam_appid

Nota: i giochi cross-platform (PC + PS4/PS5) hanno SISTEMI SEPARATI:
  - PSN trophies  → run_psn_trophies_all.py
  - Steam achievements → questo script
Entrambi vengono salvati nella stessa tabella 'trophies' con colonne
distinte: psn_trophy_id vs steam_achievement_id.

Prerequisiti:
  - STEAM_API_KEY in .env  (Steam Web API — gratuita su steamcommunity.com/dev/apikey)
  - IGDB_CLIENT_ID + IGDB_CLIENT_SECRET per Fase 1 (opzionale: --skip-resolver)

Uso:
    cd il-platinatore-ai/harvester
    python scripts/run_steam_achievements_all.py           # run completo
    python scripts/run_steam_achievements_all.py --skip-resolver  # solo fetch
    python scripts/run_steam_achievements_all.py --limit 200       # 200 giochi
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))


async def _run(limit: int | None, skip_resolver: bool) -> int:
    from src.config.db import close_pool, init_pool
    from src.config.logger import get_logger, setup_logging
    from src.config.redis_client import close_redis
    from src.config.settings import settings
    from src.discovery.steam_achievement_fetcher import SteamAchievementFetcher

    setup_logging()
    logger = get_logger("run_steam_achievements_all")

    if not settings.steam_api_key:
        logger.error(
            "STEAM_API_KEY non configurata in .env — impossibile procedere.\n"
            "Ottieni una chiave gratuita su: https://steamcommunity.com/dev/apikey"
        )
        return 1

    await init_pool()
    fetcher = SteamAchievementFetcher()

    try:
        # ── Fase 1: Popola steam_appid via IGDB external_games ────────────
        if not skip_resolver:
            if settings.igdb_client_id and settings.igdb_client_secret:
                logger.info("Fase 1/2 — Risoluzione steam_appid via IGDB")
                from src.discovery.igdb import IGDBDiscovery

                igdb = IGDBDiscovery()
                stats1 = await igdb.resolve_steam_appids()
                logger.info(
                    "Fase 1 completata",
                    resolved=stats1["resolved"],
                    no_steam=stats1["no_steam"],
                    total_checked=stats1["total_checked"],
                )
            else:
                logger.warning(
                    "IGDB_CLIENT_ID/SECRET non configurati — Fase 1 saltata. "
                    "Verranno processati solo i giochi con steam_appid già nel DB."
                )
        else:
            logger.info("Fase 1/2 — Risoluzione steam_appid saltata (--skip-resolver)")

        # ── Fase 2: Fetch achievement Steam ───────────────────────────────
        logger.info("Fase 2/2 — Fetch achievement Steam multilingua")
        stats2 = await fetcher.fetch_all_missing()
        logger.info(
            "Fase 2 completata",
            processed=stats2["processed"],
            total_achievements=stats2["achievements"],
            failed=stats2["failed"],
        )
        return 0

    except Exception as exc:
        logger.exception("Errore fatale", error=str(exc))
        return 1

    finally:
        await fetcher.close()
        await close_pool()
        await close_redis()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fetcha achievement Steam per tutti i giochi PC nel DB"
    )
    parser.add_argument(
        "--skip-resolver",
        action="store_true",
        help="Salta la risoluzione steam_appid via IGDB (Fase 1)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        metavar="N",
        help="Processa al massimo N giochi (non ancora implementato in fetch_all_missing)",
    )
    args = parser.parse_args()

    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

    exit_code = asyncio.run(_run(limit=args.limit, skip_resolver=args.skip_resolver))
    sys.exit(exit_code)


if __name__ == "__main__":
    main()

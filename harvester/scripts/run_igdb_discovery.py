"""Script: espande il catalogo giochi via IGDB, poi fetch trophy PSN."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

# Garantisce che src/ sia importabile.
sys.path.insert(0, str(Path(__file__).parent.parent))


async def main() -> None:
    from src.config.db import close_pool, init_pool
    from src.config.logger import get_logger

    logger = get_logger("igdb_discovery_script")
    await init_pool()

    try:
        # ── STEP 1: IGDB popular + new releases ──────────────────────────────
        from src.discovery.igdb import IGDBDiscovery

        igdb = IGDBDiscovery()

        logger.info("IGDB Discovery — popular + new releases")
        stats = await igdb.discover_popular_and_new()
        logger.info("IGDB popular_and_new completato", **stats)

        # ── STEP 2: IGDB upcoming (salva in upcoming_games) ──────────────────
        logger.info("IGDB Discovery — upcoming")
        stats_upcoming = await igdb.discover_upcoming()
        logger.info("IGDB upcoming completato", **stats_upcoming)

        # ── STEP 3: Controlla upcoming già usciti → migra a games ────────────
        logger.info("IGDB check_released_upcoming")
        stats_released = await igdb.check_released_upcoming()
        logger.info("check_released_upcoming completato", **stats_released)

        # ── Riepilogo finale ──────────────────────────────────────────────────
        from src.config.db import fetch_one

        row = await fetch_one("SELECT count(*) as n FROM games")
        logger.info("Totale games nel DB", count=row["n"] if row else "?")

        row2 = await fetch_one("SELECT count(*) as n FROM trophies")
        logger.info("Totale trophies nel DB", count=row2["n"] if row2 else "?")

    finally:
        await close_pool()


if __name__ == "__main__":
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(main())

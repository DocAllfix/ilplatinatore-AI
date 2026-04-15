"""psn_seed — pipeline completa trofei PSN: comm_id discovery + fetch multilingua.

Uso (dall'interno di Docker o con .env caricato):
    python -m src.orchestrator.psn_seed

Fasi:
  1. Autentica con PSN via NPSSO
  2. PsnGameFinder: trova e salva psn_communication_id per ogni gioco
  3. PsnTrophyFetcher: fetcha trofei in 10 lingue per ogni gioco
  4. Salva tutto in trophies (ON CONFLICT DO UPDATE)

Prerequisiti:
  - PSN_NPSSO configurato in .env
  - DB accessibile con migration 017 applicata
  - psnawp>=2.0 installato
"""

from __future__ import annotations

import asyncio
import sys
from typing import Any

from src.config.db import close_pool, fetch_all, init_pool
from src.config.logger import get_logger, setup_logging
from src.config.redis_client import close_redis
from src.config.settings import settings
from src.discovery.psn_game_finder import PsnGameFinder
from src.discovery.psn_trophy_fetcher import PsnTrophyFetcher

logger = get_logger(__name__)


async def _run() -> int:
    """Entry point asincrono. Ritorna 0 su successo, 1 su errore fatale."""

    # ── Prerequisito: PSN_NPSSO configurato ──────────────────────────────
    if not settings.psn_npsso:
        logger.error("PSN_NPSSO non configurato in .env — impossibile procedere")
        return 1

    # ── Init infrastruttura ───────────────────────────────────────────────
    await init_pool()

    fetcher = PsnTrophyFetcher()

    try:
        # ── Fase 1: Autenticazione PSN ────────────────────────────────────
        logger.info("Fase 1/3 — Autenticazione PSN")
        authenticated = await fetcher.authenticate()
        if not authenticated:
            logger.error("Autenticazione PSN fallita — verificare PSN_NPSSO in .env")
            return 1
        logger.info("Autenticazione PSN OK")

        # ── Fase 2: Scoperta comm_id per tutti i giochi ───────────────────
        logger.info("Fase 2/3 — Scoperta psn_communication_id per tutti i giochi")

        # Crea istanza psnawp per PsnGameFinder (stessa logica di authenticate)
        from psnawp_api import PSNAWP

        def _make_psnawp(npsso: str) -> Any:
            p = PSNAWP(npsso)
            _ = p.me().online_id  # forza autenticazione
            return p

        psnawp_inst = await asyncio.to_thread(_make_psnawp, settings.psn_npsso)

        finder = PsnGameFinder(psnawp_inst)
        stats = await finder.populate_all_games()
        logger.info(
            "Fase 2 completata",
            found=stats["found"],
            skipped=stats["skipped"],
            failed=stats["failed"],
        )

        # ── Fase 3: Fetch trofei in 10 lingue per ogni gioco ─────────────
        logger.info("Fase 3/3 — Fetch trofei multilingua")

        games = await fetch_all(
            """
            SELECT id, title, metadata
            FROM games
            WHERE metadata->>'psn_communication_id' IS NOT NULL
            ORDER BY id
            """
        )

        if not games:
            logger.warning("Nessun gioco con psn_communication_id — Fase 2 non ha trovato nulla")
            return 1

        logger.info("Giochi con comm_id trovati", count=len(games))

        total_trophies = 0
        failed_games = []

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
                failed_games.append(title)
                logger.warning("Nessun trofeo fetchato", game_title=title)
            else:
                total_trophies += count
                logger.info("Trofei salvati", game_title=title, count=count)

            # Pausa tra giochi per rispettare rate limit PSN Trophy API
            await asyncio.sleep(0.5)

        # ── Report finale ─────────────────────────────────────────────────
        logger.info(
            "psn_seed completato",
            total_trophies=total_trophies,
            games_ok=len(games) - len(failed_games),
            games_failed=len(failed_games),
        )
        if failed_games:
            logger.warning("Giochi senza trofei fetchati", games=failed_games)

        return 0

    except Exception as exc:
        logger.exception("psn_seed fallito con errore inatteso", error=str(exc))
        return 1

    finally:
        await fetcher.close()
        await close_pool()
        await close_redis()


def main() -> None:
    setup_logging()
    # psycopg3 richiede SelectorEventLoop su Windows (ProactorEventLoop non supportato).
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    exit_code = asyncio.run(_run())
    sys.exit(exit_code)


if __name__ == "__main__":
    main()

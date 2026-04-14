"""Entry point dell'harvester — avvia la pipeline in modalità seed o update.

Non è un server HTTP: parte, processa, si ferma.
Exit code 0 = successo, 1 = errore.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from src.config.db import close_pool, init_pool
from src.config.logger import get_logger

logger = get_logger("main")

# AUDIT FIX (W-ARCH-2): Heartbeat file per Docker healthcheck.
# Il container verifica che questo file sia stato toccato negli ultimi 5 minuti.
HEARTBEAT_FILE = Path("/tmp/harvester_heartbeat")


def touch_heartbeat() -> None:
    """Aggiorna il timestamp del heartbeat file per segnalare che il processo è vivo."""
    try:
        HEARTBEAT_FILE.touch()
    except OSError:
        # /tmp potrebbe non esistere su Windows in dev — non fatale.
        pass


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Il Platinatore AI — Harvester")
    parser.add_argument(
        "mode",
        nargs="?",
        default="seed",
        choices=["seed", "update"],
        help="Modalità di esecuzione (default: seed)",
    )
    return parser.parse_args(argv)


async def main(argv: list[str] | None = None) -> None:
    args = _parse_args(argv)
    mode: str = args.mode

    logger.info("starting_harvester", mode=mode)

    # Inizializza connessioni.
    await init_pool()
    touch_heartbeat()

    from src.orchestrator.pipeline import HarvestPipeline

    pipeline = HarvestPipeline()

    try:
        if mode == "seed":
            stats = await pipeline.run_seed_batch("seeds/top_games.json")
            touch_heartbeat()
            logger.info("seed_batch_complete", **stats)
        elif mode == "update":
            logger.info("update_mode_not_yet_implemented")
        else:
            logger.error("unknown_mode", mode=mode)
            sys.exit(1)
    except Exception as exc:
        logger.exception("pipeline_crashed", error=str(exc))
        sys.exit(1)
    finally:
        await pipeline.cleanup()
        await close_pool()

    logger.info("harvester_shutdown_clean")


if __name__ == "__main__":
    # psycopg3 richiede SelectorEventLoop su Windows (ProactorEventLoop non supportato).
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(main())

"""Recupera trofei PSN (con descrizioni) per tutti i giochi PS4/PS5 nel DB.

Pipeline:
  Fase 1 — Autenticazione PSN (NPSSO → access token)
  Fase 2 — PsnGameFinder: scopre psn_communication_id per giochi senza comm_id
  Fase 3 — PsnTrophyFetcher: fetcha trofei in 10 lingue (con detail_en/detail_it)

Ottimizzazioni rispetto a psn_seed.py:
  - Fase 3 processa solo giochi SENZA trofei nel DB (--only-missing, default on)
  - Checkpoint in psn_trophies_progress.json per resume automatico
  - --limit N: processa al massimo N giochi a sessione (utile per run notturne)
  - --skip-finder: salta Fase 2 se comm_id già presenti
  - --start-id N: riprende da game_id specifico

Uso:
    cd il-platinatore-ai/harvester
    python scripts/run_psn_trophies_all.py                  # run completo
    python scripts/run_psn_trophies_all.py --limit 100      # 100 giochi
    python scripts/run_psn_trophies_all.py --skip-finder    # solo fetch trofei
    python scripts/run_psn_trophies_all.py --all-games      # include già con trofei
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent.parent))

_CHECKPOINT_FILE = Path(__file__).parent.parent / "psn_trophies_progress.json"
# Pausa tra giochi in Fase 3 (PSN Trophy API rate limit non documentato).
_INTER_GAME_DELAY_S = 0.5
# Pausa aggiuntiva ogni 50 giochi (evita ban temporanei su run lunghe).
_COOLDOWN_INTERVAL = 50
_COOLDOWN_DELAY_S = 5.0


def _load_checkpoint() -> dict[str, Any]:
    """Carica checkpoint esistente o restituisce struttura vuota."""
    if _CHECKPOINT_FILE.exists():
        try:
            data = json.loads(_CHECKPOINT_FILE.read_text(encoding="utf-8"))
            return data
        except Exception:
            pass
    return {"processed_ids": [], "failed_ids": [], "last_run_ts": None}


def _save_checkpoint(data: dict[str, Any]) -> None:
    """Salva checkpoint su disco (atomico via tmp file)."""
    tmp = _CHECKPOINT_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(_CHECKPOINT_FILE)


async def _run(
    limit: int | None,
    skip_finder: bool,
    only_missing: bool,
    start_id: int | None,
) -> int:
    """Entry point asincrono. Ritorna 0 su successo, 1 su errore fatale."""
    from src.config.db import close_pool, fetch_all, init_pool
    from src.config.logger import get_logger, setup_logging
    from src.config.redis_client import close_redis
    from src.config.settings import settings
    from src.discovery.psn_game_finder import PsnGameFinder
    from src.discovery.psn_trophy_fetcher import PsnTrophyFetcher

    setup_logging()
    logger = get_logger("run_psn_trophies_all")

    if not settings.psn_npsso:
        logger.error("PSN_NPSSO non configurato in .env — impossibile procedere")
        return 1

    await init_pool()
    fetcher = PsnTrophyFetcher()

    try:
        # ── Fase 1: Autenticazione ─────────────────────────────────────────
        logger.info("Fase 1/3 — Autenticazione PSN")
        authenticated = await fetcher.authenticate()
        if not authenticated:
            logger.error("Autenticazione PSN fallita")
            return 1
        logger.info("Autenticazione PSN OK")

        # ── Fase 2: Scoperta comm_id ───────────────────────────────────────
        if not skip_finder:
            logger.info("Fase 2/3 — Scoperta psn_communication_id")
            from psnawp_api import PSNAWP

            def _make_psnawp(npsso: str) -> Any:
                p = PSNAWP(npsso)
                _ = p.me().online_id
                return p

            psnawp_inst = await asyncio.to_thread(_make_psnawp, settings.psn_npsso)
            finder = PsnGameFinder(psnawp_inst)
            stats2 = await finder.populate_all_games()
            logger.info(
                "Fase 2 completata",
                found=stats2["found"],
                skipped=stats2["skipped"],
                failed=stats2["failed"],
            )
        else:
            logger.info("Fase 2/3 — Scoperta comm_id saltata (--skip-finder)")

        # ── Fase 3: Fetch trofei ───────────────────────────────────────────
        logger.info("Fase 3/3 — Fetch trofei multilingua con descrizioni")

        # Query: giochi con comm_id, con o senza trofei già presenti
        if only_missing:
            games = await fetch_all(
                """
                -- Giochi PS4/PS5 con comm_id ma SENZA trofei nel DB.
                -- Questo è il target principale: 4000+ giochi da processare.
                SELECT g.id, g.title, g.metadata
                FROM games g
                WHERE g.metadata->>'psn_communication_id' IS NOT NULL
                  AND NOT EXISTS (
                      SELECT 1 FROM trophies t WHERE t.game_id = g.id
                  )
                ORDER BY g.id
                """
            )
        else:
            games = await fetch_all(
                """
                -- Tutti i giochi PS4/PS5 con comm_id (inclusi quelli già con trofei).
                SELECT id, title, metadata
                FROM games
                WHERE metadata->>'psn_communication_id' IS NOT NULL
                ORDER BY id
                """
            )

        if not games:
            logger.warning("Nessun gioco candidato per Fase 3 — comm_id non disponibili")
            logger.info(
                "Suggerimento: eseguire prima senza --skip-finder per popolare i comm_id"
            )
            return 0

        logger.info("Giochi candidati Fase 3", total=len(games))

        # ── Checkpoint + filtri ────────────────────────────────────────────
        checkpoint = _load_checkpoint()
        processed_set: set[int] = set(checkpoint.get("processed_ids", []))
        failed_set: set[int] = set(checkpoint.get("failed_ids", []))

        # Filtra giochi già processati con successo in sessioni precedenti
        pending = [g for g in games if g["id"] not in processed_set]

        # --start-id: riprende da un game_id specifico
        if start_id is not None:
            pending = [g for g in pending if g["id"] >= start_id]
            logger.info("Ripresa da start_id", start_id=start_id, remaining=len(pending))

        # --limit: cap al numero richiesto
        if limit is not None:
            pending = pending[:limit]

        logger.info(
            "Giochi da processare in questa sessione",
            total_candidates=len(games),
            already_done=len(processed_set),
            this_session=len(pending),
        )

        if not pending:
            logger.info("Tutti i giochi già processati — nulla da fare")
            return 0

        # ── Loop principale ────────────────────────────────────────────────
        stats: dict[str, int] = {"ok": 0, "failed": 0, "skipped": 0}
        t_start = time.monotonic()

        for i, game in enumerate(pending, 1):
            game_id: int = game["id"]
            title: str = game["title"]

            # Progress log ogni 10 giochi o all'ultimo
            if i % 10 == 0 or i == len(pending):
                elapsed = time.monotonic() - t_start
                rate = i / elapsed if elapsed > 0 else 0
                eta_s = (len(pending) - i) / rate if rate > 0 else 0
                logger.info(
                    f"[{i}/{len(pending)}] ETA ~{eta_s / 60:.1f}min",
                    ok=stats["ok"],
                    failed=stats["failed"],
                    rate_per_min=f"{rate * 60:.1f}",
                )

            try:
                count = await fetcher.fetch_and_store_for_game(game_id, title)
                if count > 0:
                    stats["ok"] += 1
                    processed_set.add(game_id)
                    failed_set.discard(game_id)
                else:
                    stats["failed"] += 1
                    failed_set.add(game_id)
                    logger.warning("Nessun trofeo fetchato", game_id=game_id, title=title)
            except Exception as exc:
                stats["failed"] += 1
                failed_set.add(game_id)
                logger.error(
                    "Errore fetch trofei", game_id=game_id, title=title, error=str(exc)
                )

            # Salva checkpoint ogni 10 giochi
            if i % 10 == 0:
                _save_checkpoint(
                    {
                        "processed_ids": sorted(processed_set),
                        "failed_ids": sorted(failed_set),
                        "last_run_ts": time.time(),
                    }
                )

            # Cooldown ogni 50 giochi
            if i % _COOLDOWN_INTERVAL == 0:
                logger.info(
                    f"Cooldown {_COOLDOWN_DELAY_S}s ogni {_COOLDOWN_INTERVAL} giochi"
                )
                await asyncio.sleep(_COOLDOWN_DELAY_S)
            else:
                await asyncio.sleep(_INTER_GAME_DELAY_S)

        # Checkpoint finale
        _save_checkpoint(
            {
                "processed_ids": sorted(processed_set),
                "failed_ids": sorted(failed_set),
                "last_run_ts": time.time(),
            }
        )

        elapsed_total = time.monotonic() - t_start
        logger.info(
            "Fase 3 completata",
            ok=stats["ok"],
            failed=stats["failed"],
            total_processed_ever=len(processed_set),
            elapsed_min=f"{elapsed_total / 60:.1f}",
        )

        if failed_set:
            logger.warning(
                "Giochi falliti (salvati in checkpoint per retry)",
                count=len(failed_set),
                checkpoint=str(_CHECKPOINT_FILE),
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
        description="Fetcha trofei PSN con descrizioni per tutti i giochi PS4/PS5"
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        metavar="N",
        help="Processa al massimo N giochi in questa sessione",
    )
    parser.add_argument(
        "--skip-finder",
        action="store_true",
        help="Salta Fase 2 (scoperta comm_id): usa solo giochi già con comm_id",
    )
    parser.add_argument(
        "--all-games",
        action="store_true",
        help="Includi anche giochi che hanno già trofei (default: solo quelli senza)",
    )
    parser.add_argument(
        "--start-id",
        type=int,
        default=None,
        metavar="GAME_ID",
        help="Riparte da game_id specifico (utile per debug o resume manuale)",
    )
    parser.add_argument(
        "--reset-checkpoint",
        action="store_true",
        help="Cancella il checkpoint e riparte da zero",
    )

    args = parser.parse_args()

    if args.reset_checkpoint and _CHECKPOINT_FILE.exists():
        _CHECKPOINT_FILE.unlink()
        print(f"Checkpoint rimosso: {_CHECKPOINT_FILE}")

    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

    exit_code = asyncio.run(
        _run(
            limit=args.limit,
            skip_finder=args.skip_finder,
            only_missing=not args.all_games,
            start_id=args.start_id,
        )
    )
    sys.exit(exit_code)


if __name__ == "__main__":
    main()

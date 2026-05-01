"""On-Demand worker (Fase 25) — singleton loop poller per `on_demand_requests`.

Esegue in container/processo separato dal seed batch (advisory_lock 98 vs 99).
Polla ogni 5 secondi le richieste pending, le processa con la pipeline esistente,
e aggiorna lo status in DB.

Avvio:
    python -m src.orchestrator.on_demand_worker

Stop:
    SIGTERM gracefulshutdown — finishes in-flight job, releases lock, exits.

Job timeout per riga: 30 secondi (buffer 15s vs orchestrator backend 45s).
Se la pipeline supera 30s, la riga resta in 'processing' fino al prossimo
processor restart, dove un cleanup recupera (sweep stale 'processing' > 5 min).
"""

from __future__ import annotations

import asyncio
import signal
from typing import Any

import psycopg
import psycopg_pool

from src.config.db import _get_pool, close_pool, init_pool
from src.config.logger import get_logger
from src.config.settings import settings

logger = get_logger(__name__)

# advisory_lock(98): distinto da run_seed_batch (99) e upserter xact lock (42).
# Permette al seed batch e al worker on-demand di coesistere (process distinti)
# senza race su un singolo lock condiviso.
_ON_DEMAND_LOCK_ID = 98
_POLL_INTERVAL_S = 5.0
_JOB_TIMEOUT_S = 30.0
_STALE_PROCESSING_MIN = 5  # cleanup row 'processing' più vecchie di 5 min al boot

# Shutdown flag — settato da signal handler.
_shutdown = asyncio.Event()


async def _acquire_singleton_lock(conn: Any) -> bool:
    """advisory_lock(98) session-level. False se già preso da altro processo."""
    cur = await conn.execute("SELECT pg_try_advisory_lock(%s)", (_ON_DEMAND_LOCK_ID,))
    row = await cur.fetchone()
    if not row or not row[0]:
        return False
    return True


async def _cleanup_stale(conn: Any) -> int:
    """Marca come 'failed' le righe 'processing' più vecchie di N minuti.

    Difesa contro crash worker che lasciano lock orfani — il prossimo restart
    le recupera invece di lasciarle bloccate per sempre.
    """
    cur = await conn.execute(
        """
        UPDATE on_demand_requests
        SET status = 'failed',
            error_message = 'stale processing recovered at worker restart',
            completed_at = NOW()
        WHERE status = 'processing'
          AND started_at < NOW() - INTERVAL '%s minutes'
        """
        % _STALE_PROCESSING_MIN,
    )
    return cur.rowcount or 0


async def _claim_next_pending(conn: Any) -> dict[str, Any] | None:
    """SELECT FOR UPDATE SKIP LOCKED: claim atomic + race-safe.

    Idiom standard per work queue su Postgres senza lock-out.
    """
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE on_demand_requests
            SET status = 'processing', started_at = NOW()
            WHERE id = (
                SELECT id FROM on_demand_requests
                WHERE status = 'pending'
                ORDER BY requested_at ASC
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            RETURNING id, user_id, query, game_id
            """
        )
        row = await cur.fetchone()
        if not row:
            return None
        return {
            "id": row[0],
            "user_id": row[1],
            "query": row[2],
            "game_id": row[3],
        }


async def _resolve_game_name(conn: Any, game_id: int | None, query: str) -> str:
    """Se game_id è dato, ritorna title da DB; altrimenti usa la query come fallback."""
    if game_id is not None:
        cur = await conn.execute("SELECT title FROM games WHERE id = %s", (game_id,))
        row = await cur.fetchone()
        if row and row[0]:
            return str(row[0])
    # Fallback: usa la query — il LLM transformer estrarrà il nome gioco dal contesto.
    return query[:120]


async def _latest_guide_id_for(conn: Any, game_id: int | None, since_started_at: Any) -> int | None:
    """Recupera la guide più recente creata dopo `since_started_at`.

    Filtra per game_id se presente; altrimenti la più recente in assoluto.
    Usato post-`process_single_guide` per ottenere guide_id (la pipeline non lo ritorna).
    """
    if game_id is not None:
        cur = await conn.execute(
            """
            SELECT id FROM guides
            WHERE game_id = %s AND created_at >= %s
            ORDER BY created_at DESC LIMIT 1
            """,
            (game_id, since_started_at),
        )
    else:
        cur = await conn.execute(
            """
            SELECT id FROM guides WHERE created_at >= %s
            ORDER BY created_at DESC LIMIT 1
            """,
            (since_started_at,),
        )
    row = await cur.fetchone()
    return int(row[0]) if row else None


async def _process_request(req: dict[str, Any]) -> tuple[bool, int | None, str | None]:
    """Esegue la pipeline esistente per produrre una guide live.

    Steps:
      1. DuckDuckGo search per trovare URL collector da domini trusted
      2. HarvestPipeline.process_single_guide(game_name, trophy_name, urls)
      3. Se True (iniettata) → query DB per guide_id più recente

    Returns:
        (ok, guide_id, error_message)
    """
    from src.collectors.guide_search import GuideSearchCollector
    from src.config.db import _get_pool
    from src.orchestrator.pipeline import HarvestPipeline

    pipeline = HarvestPipeline()
    search = GuideSearchCollector()
    pool = await _get_pool()

    try:
        async with pool.connection() as conn:
            game_name = await _resolve_game_name(conn, req["game_id"], req["query"])

        # Step 1: discover URL via DuckDuckGo trusted domains.
        urls = await asyncio.wait_for(
            search.search_guide_urls(req["query"], max_results=3, trusted_only=True),
            timeout=10.0,
        )
        if not urls:
            return (False, None, "no trusted URL found for query")

        # Snapshot timestamp PRIMA di process_single_guide: usato per identificare
        # la guide creata da questa run (vs guide preesistenti).
        async with pool.connection() as conn:
            cur = await conn.execute("SELECT NOW()")
            row = await cur.fetchone()
            run_started_at = row[0] if row else None

        # Step 2: pipeline esistente. trophy_name = la query intera (è una richiesta
        # specifica — il transformer LLM userà il contesto per capire cosa estrarre).
        # process_single_guide ritorna True su iniezione, False su skip/dedup.
        ok = await asyncio.wait_for(
            pipeline.process_single_guide(
                game_name=game_name,
                trophy_name=req["query"][:200],
                source_urls=urls,
            ),
            timeout=_JOB_TIMEOUT_S,
        )
        if not ok:
            # Possibile: tutte le sorgenti dedup → guide già esiste. Recupera comunque.
            async with pool.connection() as conn:
                gid = await _latest_guide_id_for(conn, req["game_id"], run_started_at)
            if gid is not None:
                return (True, gid, None)
            return (False, None, "pipeline non ha iniettato e nessuna guide trovata post-run")

        # Step 3: recupera guide_id appena creata.
        async with pool.connection() as conn:
            gid = await _latest_guide_id_for(conn, req["game_id"], run_started_at)
        if gid is None:
            return (False, None, "pipeline returned True ma guide_id non trovata in DB")
        return (True, gid, None)
    except asyncio.TimeoutError:
        return (False, None, f"pipeline timeout > {_JOB_TIMEOUT_S}s")
    except Exception as exc:  # noqa: BLE001
        return (False, None, f"{type(exc).__name__}: {exc}")


async def _mark_completed(conn: Any, request_id: int, guide_id: int) -> None:
    await conn.execute(
        """
        UPDATE on_demand_requests
        SET status = 'completed', guide_id = %s, completed_at = NOW()
        WHERE id = %s
        """,
        (guide_id, request_id),
    )


async def _mark_failed(conn: Any, request_id: int, error: str) -> None:
    await conn.execute(
        """
        UPDATE on_demand_requests
        SET status = 'failed', error_message = %s, completed_at = NOW()
        WHERE id = %s
        """,
        (error[:500], request_id),
    )


async def _main_loop() -> None:
    pool = await _get_pool()

    # Acquire singleton lock su una connessione dedicata (session-level lock
    # vive per tutta la sessione, NON ritornare la connessione al pool).
    lock_conn = await psycopg.AsyncConnection.connect(
        settings.database_url, autocommit=True
    )
    locked = await _acquire_singleton_lock(lock_conn)
    if not locked:
        logger.error(
            "advisory_lock(98) busy — un altro on_demand_worker è già in esecuzione. Exit."
        )
        await lock_conn.close()
        return

    # Cleanup stale al boot.
    async with pool.connection() as conn:
        recovered = await _cleanup_stale(conn)
        if recovered:
            logger.warning("Stale processing recuperate", count=recovered)

    logger.info("On-demand worker avviato (lock 98 acquisito, polling ogni 5s)")

    try:
        while not _shutdown.is_set():
            try:
                async with pool.connection() as conn:
                    req = await _claim_next_pending(conn)
                if req:
                    logger.info(
                        "On-demand request presa in carico",
                        request_id=req["id"],
                        user_id=req["user_id"],
                        query_len=len(req["query"] or ""),
                    )
                    ok, guide_id, error = await _process_request(req)
                    async with pool.connection() as conn:
                        if ok and guide_id is not None:
                            await _mark_completed(conn, req["id"], guide_id)
                            logger.info(
                                "On-demand request completata",
                                request_id=req["id"],
                                guide_id=guide_id,
                            )
                        else:
                            await _mark_failed(conn, req["id"], error or "unknown")
                            logger.warning(
                                "On-demand request fallita",
                                request_id=req["id"],
                                error=error,
                            )
                    continue  # subito al prossimo job, no sleep
            except Exception:
                logger.exception("Loop on-demand worker error, continue")
            try:
                await asyncio.wait_for(_shutdown.wait(), timeout=_POLL_INTERVAL_S)
            except asyncio.TimeoutError:
                pass  # poll cycle scaduto → next iter
    finally:
        await lock_conn.close()
        logger.info("On-demand worker shutdown — lock 98 rilasciato")


def _install_signal_handlers(loop: asyncio.AbstractEventLoop) -> None:
    def _shutdown_signal(*_: Any) -> None:
        logger.info("SIGTERM/SIGINT ricevuto, shutdown graceful")
        _shutdown.set()

    # Windows non supporta loop.add_signal_handler — fallback signal.signal.
    try:
        loop.add_signal_handler(signal.SIGTERM, _shutdown_signal)
        loop.add_signal_handler(signal.SIGINT, _shutdown_signal)
    except (NotImplementedError, AttributeError):
        signal.signal(signal.SIGTERM, _shutdown_signal)
        signal.signal(signal.SIGINT, _shutdown_signal)


async def _run() -> None:
    await init_pool()
    try:
        loop = asyncio.get_running_loop()
        _install_signal_handlers(loop)
        await _main_loop()
    finally:
        await close_pool()


if __name__ == "__main__":
    asyncio.run(_run())

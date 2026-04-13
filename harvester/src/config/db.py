import time
from typing import Any

import psycopg_pool
from psycopg.rows import dict_row

from src.config.logger import get_logger
from src.config.settings import settings

logger = get_logger(__name__)

# Pool max=3: non contende con il backend Node.js su PgBouncer (max=10).
# autocommit=True: ogni statement è committato immediatamente.
# Transazioni esplicite (es. injector) devono acquisire la connessione direttamente.
db_pool: psycopg_pool.AsyncConnectionPool | None = None


async def init_pool() -> None:
    """Apre il connection pool. Da chiamare all'avvio dell'orchestratore."""
    global db_pool
    if db_pool is None:
        db_pool = psycopg_pool.AsyncConnectionPool(
            conninfo=settings.database_url,
            min_size=1,
            max_size=3,
            open=False,
            kwargs={"autocommit": True},
        )
        await db_pool.open()
        logger.info("DB pool aperto", min_size=1, max_size=3)


async def close_pool() -> None:
    """Chiude il connection pool. Da chiamare allo shutdown."""
    global db_pool
    if db_pool is not None:
        await db_pool.close()
        db_pool = None
        logger.info("DB pool chiuso")


async def _get_pool() -> psycopg_pool.AsyncConnectionPool:
    """Restituisce il pool, inizializzandolo se necessario."""
    if db_pool is None:
        await init_pool()
    return db_pool  # type: ignore[return-value]


async def execute(query: str, params: tuple[Any, ...] | None = None) -> None:
    """Esegue una query senza risultati (INSERT, UPDATE, DELETE)."""
    pool = await _get_pool()
    start = time.perf_counter()
    try:
        async with pool.connection() as conn:
            await conn.execute(query, params)
        elapsed = (time.perf_counter() - start) * 1000
        logger.debug("query eseguita", query=query[:200], elapsed_ms=round(elapsed, 2))
    except Exception:
        elapsed = (time.perf_counter() - start) * 1000
        logger.exception("query fallita", query=query[:200], elapsed_ms=round(elapsed, 2))
        raise


async def fetch_all(
    query: str, params: tuple[Any, ...] | None = None
) -> list[dict[str, Any]]:
    """Esegue una query e restituisce tutte le righe come lista di dict."""
    pool = await _get_pool()
    start = time.perf_counter()
    try:
        async with pool.connection() as conn:
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(query, params)
                rows = await cur.fetchall()
        elapsed = (time.perf_counter() - start) * 1000
        logger.debug(
            "fetch_all completato",
            query=query[:200],
            rows=len(rows),
            elapsed_ms=round(elapsed, 2),
        )
        return rows
    except Exception:
        elapsed = (time.perf_counter() - start) * 1000
        logger.exception("fetch_all fallito", query=query[:200], elapsed_ms=round(elapsed, 2))
        raise


async def fetch_one(
    query: str, params: tuple[Any, ...] | None = None
) -> dict[str, Any] | None:
    """Esegue una query e restituisce la prima riga come dict, o None se vuota."""
    pool = await _get_pool()
    start = time.perf_counter()
    try:
        async with pool.connection() as conn:
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(query, params)
                row = await cur.fetchone()
        elapsed = (time.perf_counter() - start) * 1000
        logger.debug("fetch_one completato", query=query[:200], elapsed_ms=round(elapsed, 2))
        return row
    except Exception:
        elapsed = (time.perf_counter() - start) * 1000
        logger.exception("fetch_one fallito", query=query[:200], elapsed_ms=round(elapsed, 2))
        raise


async def test_connection() -> None:
    """Verifica la connessione al DB con SELECT NOW(). Logga il risultato."""
    try:
        row = await fetch_one("SELECT NOW() AS now")
        logger.info("Connessione DB OK", now=str(row["now"]) if row else None)
    except Exception as exc:
        logger.error("Connessione DB fallita", error=str(exc))
        raise

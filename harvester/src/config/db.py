import psycopg_pool
from src.config.settings import settings

# Pool max=3: non contende con il backend Node.js su PgBouncer
_pool: psycopg_pool.AsyncConnectionPool | None = None


async def get_pool() -> psycopg_pool.AsyncConnectionPool:
    global _pool
    if _pool is None:
        _pool = psycopg_pool.AsyncConnectionPool(
            conninfo=settings.database_url,
            min_size=1,
            max_size=3,
            open=False,
        )
        await _pool.open()
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None

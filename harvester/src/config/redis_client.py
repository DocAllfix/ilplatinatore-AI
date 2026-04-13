import redis.asyncio as aioredis

from src.config.logger import get_logger
from src.config.settings import settings

logger = get_logger(__name__)

# Redis db=1 — separato dal backend Node.js che usa db=0.
# from_url() è sincrono: crea il client ma non apre la connessione TCP.
# La connessione effettiva avviene al primo comando asincrono.
redis_client: aioredis.Redis = aioredis.from_url(
    settings.redis_url,
    decode_responses=True,
)


async def close_redis() -> None:
    """Chiude la connessione Redis. Da chiamare allo shutdown."""
    await redis_client.aclose()
    logger.info("Redis client chiuso")


async def test_redis_connection() -> None:
    """Verifica la connessione Redis con PING."""
    try:
        pong = await redis_client.ping()
        logger.info("Connessione Redis OK", pong=pong)
    except Exception as exc:
        logger.error("Connessione Redis fallita", error=str(exc))
        raise

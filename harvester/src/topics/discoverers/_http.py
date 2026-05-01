"""HTTP helper condiviso per discoverers — best-effort, no crash."""

from __future__ import annotations

import httpx

from src.config.logger import get_logger

logger = get_logger(__name__)

_DEFAULT_HEADERS = {
    "User-Agent": (
        "Il-Platinatore-AI/1.0 (+https://ilplatinatore.it; topic-mapper) "
        "Python/httpx"
    ),
    "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
}


async def fetch_html(url: str, timeout: float = 10.0) -> str | None:
    """GET URL, ritorna body se 200, altrimenti None.

    Cattura ogni eccezione e logga warning — i discoverers non devono crashare
    il topic_mapper se una sorgente è giù.
    """
    try:
        async with httpx.AsyncClient(
            headers=_DEFAULT_HEADERS,
            timeout=timeout,
            follow_redirects=True,
        ) as client:
            resp = await client.get(url)
        if resp.status_code != 200:
            logger.debug(
                "discoverer fetch non-200, skip",
                url=url,
                status=resp.status_code,
            )
            return None
        return resp.text
    except Exception as exc:
        logger.debug(
            "discoverer fetch fallito, skip",
            url=url,
            error=type(exc).__name__,
        )
        return None

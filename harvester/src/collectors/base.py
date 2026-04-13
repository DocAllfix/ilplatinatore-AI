"""BaseCollector — classe astratta per tutti i collector dell'Infinite Ingestion Engine.

Gestisce rate limiting globale (semaforo + token bucket per-host),
rispetto robots.txt, User-Agent dichiarato e logging strutturato.
"""

from __future__ import annotations

import asyncio
import hashlib
import time
from abc import ABC, abstractmethod
from collections import defaultdict
from typing import ClassVar

import httpx
from protego import Protego

from src.config.logger import get_logger
from src.config.settings import settings

# ── Semaforo GLOBALE condiviso tra TUTTI i collector ─────────────────────────
# Max 5 richieste HTTP in volo contemporaneamente, indipendentemente
# dal numero di collector attivi.  Previene esplosione connessioni
# (AUDIT FIX Warning #5).
GLOBAL_HTTP_SEMAPHORE = asyncio.Semaphore(5)


class PerHostTokenBucket:
    """Rate limiter per-host con algoritmo token bucket.

    rate = 0.33 → max 1 richiesta ogni ~3 secondi per singolo dominio.
    burst = 1   → nessun burst consentito oltre il rate base.
    """

    def __init__(self, rate: float = 0.33, burst: int = 1) -> None:
        self._rate = rate
        self._burst = burst
        self._tokens: dict[str, float] = defaultdict(lambda: float(burst))
        self._last_time: dict[str, float] = defaultdict(time.monotonic)
        self._lock = asyncio.Lock()

    async def acquire(self, host: str) -> None:
        """Attende fino a quando un token è disponibile per *host*."""
        async with self._lock:
            now = time.monotonic()
            elapsed = now - self._last_time[host]
            self._tokens[host] = min(
                self._burst,
                self._tokens[host] + elapsed * self._rate,
            )
            if self._tokens[host] < 1:
                wait_time = (1 - self._tokens[host]) / self._rate
                await asyncio.sleep(wait_time)
                self._tokens[host] = 0
            else:
                self._tokens[host] -= 1
            self._last_time[host] = time.monotonic()


# Istanza globale condivisa da tutti i collector
PER_HOST_BUCKET = PerHostTokenBucket(rate=0.33, burst=1)


def compute_hash(text: str) -> str:
    """Calcola SHA-256 di *text* e ritorna l'hash esadecimale."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class BaseCollector(ABC):
    """Classe astratta da cui ereditano tutti i collector.

    Sottoclassi DEVONO definire gli attributi di classe:
      - domain: str           (es. "powerpyx.com")
      - reliability_score: float  (0.0 – 1.0)
      - requires_js: bool     (default False)

    e implementare il metodo `extract()`.
    """

    # ── Attributi di classe (da sovrascrivere) ───────────────────────────────
    domain: ClassVar[str]
    reliability_score: ClassVar[float]
    requires_js: ClassVar[bool] = False

    def __init__(
        self,
        global_semaphore: asyncio.Semaphore = GLOBAL_HTTP_SEMAPHORE,
    ) -> None:
        self._semaphore = global_semaphore
        self._logger = get_logger(self.__class__.__name__)
        self._last_request_time: float = 0.0
        self._robots: Protego | None = None
        # Flag: True dopo il primo tentativo di caricare robots.txt
        # (successo o fallimento).  Evita retry infiniti su domini senza robots.txt.
        self._robots_loaded: bool = False

        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(15.0),
            headers={
                "User-Agent": settings.user_agent,
                "Accept-Language": "it-IT,it;q=0.9,en;q=0.8",
            },
            follow_redirects=True,
        )

    # ── Lifecycle ────────────────────────────────────────────────────────────

    async def _load_robots(self) -> None:
        """Scarica e parsa robots.txt del dominio.  Fail-open se non raggiungibile.

        Chiamato lazy dal primo fetch().  Una sola volta per istanza:
        _robots_loaded=True impedisce retry anche in caso di 404/errore.
        """
        self._robots_loaded = True
        robots_url = f"https://{self.domain}/robots.txt"
        try:
            resp = await self._client.get(robots_url)
            if resp.status_code == 200:
                self._robots = Protego.parse(resp.text)
                self._logger.debug("robots.txt caricato", domain=self.domain)
            else:
                self._logger.warning(
                    "robots.txt non disponibile, fail-open",
                    domain=self.domain,
                    status=resp.status_code,
                )
        except httpx.HTTPError as exc:
            self._logger.warning(
                "robots.txt fetch fallito, fail-open",
                domain=self.domain,
                error=str(exc),
            )

    async def close(self) -> None:
        """Chiude il client httpx."""
        await self._client.aclose()

    # ── Rate limiting ────────────────────────────────────────────────────────

    async def _respect_delay(self) -> None:
        """Aspetta almeno settings.scrape_delay_seconds tra richieste allo stesso dominio."""
        now = time.monotonic()
        elapsed = now - self._last_request_time
        required = settings.scrape_delay_seconds

        if self._last_request_time > 0 and elapsed < required:
            wait = required - elapsed
            self._logger.debug(
                "rate limit delay",
                domain=self.domain,
                wait_seconds=round(wait, 2),
            )
            await asyncio.sleep(wait)

        self._last_request_time = time.monotonic()

    # ── Robots.txt ───────────────────────────────────────────────────────────

    async def _is_allowed(self, url: str) -> bool:
        """Verifica se *url* è permesso da robots.txt.  Fail-open se non caricato."""
        if self._robots is None:
            return True

        allowed = self._robots.can_fetch(url, settings.user_agent)
        if not allowed:
            self._logger.warning(
                "URL vietato da robots.txt",
                url=url[:100],
                domain=self.domain,
            )
        return allowed

    # ── Fetch ────────────────────────────────────────────────────────────────

    async def fetch(self, url: str) -> str | None:
        """Scarica una pagina rispettando rate limit globale e per-host.

        Ritorna il body HTML come stringa, oppure None se bloccato/errore.
        """
        # Lazy load robots.txt alla prima richiesta (una sola volta per istanza).
        # __init__ non può essere async, quindi il caricamento è deferito qui.
        if not self._robots_loaded:
            await self._load_robots()

        # robots.txt check
        if not await self._is_allowed(url):
            return None

        # rate limit per-host (token bucket)
        await PER_HOST_BUCKET.acquire(self.domain)

        # rate limit legacy per-collector
        await self._respect_delay()

        # semaforo globale — max 5 richieste HTTP in volo
        async with self._semaphore:
            start = time.monotonic()
            try:
                resp = await self._client.get(url)
            except httpx.TimeoutException:
                self._logger.warning(
                    "timeout",
                    url=url[:100],
                    domain=self.domain,
                )
                return None
            except httpx.HTTPError as exc:
                self._logger.error(
                    "errore HTTP",
                    url=url[:100],
                    domain=self.domain,
                    error=str(exc),
                )
                return None

            elapsed_ms = round((time.monotonic() - start) * 1000, 1)
            body = resp.text

            self._logger.info(
                "fetch completato",
                url=url[:100],
                status=resp.status_code,
                elapsed_ms=elapsed_ms,
                body_size=len(body),
            )

            if resp.status_code == 200:
                return body

            if resp.status_code in (403, 429):
                self._logger.warning(
                    f"bloccato da {self.domain}",
                    status=resp.status_code,
                    url=url[:100],
                )
                return None

            self._logger.error(
                "status inatteso",
                status=resp.status_code,
                url=url[:100],
                domain=self.domain,
            )
            return None

    # ── Extract (astratto) ───────────────────────────────────────────────────

    @abstractmethod
    async def extract(self, html: str, url: str) -> dict | None:
        """Estrae dati strutturati dall'HTML.  Da implementare nelle sottoclassi.

        Deve ritornare un dizionario con le chiavi:
          title, game_name, trophy_name, guide_type,
          raw_content, source_url, source_domain, content_hash
        oppure None se l'estrazione fallisce.
        """

    # ── Collect (pipeline completa) ──────────────────────────────────────────

    async def collect(self, url: str) -> dict | None:
        """Pipeline completa: fetch → extract.  Ritorna i dati strutturati o None."""
        html = await self.fetch(url)
        if html is None:
            return None

        result = await self.extract(html, url)

        if result is not None:
            self._logger.info(
                "collect riuscito",
                title=result.get("title", "?")[:80],
                url=url[:100],
            )
        else:
            self._logger.warning(
                "extract fallito",
                url=url[:100],
                domain=self.domain,
            )

        return result

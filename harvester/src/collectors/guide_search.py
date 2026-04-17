"""GuideSearchCollector — scoperta fonti guide via DuckDuckGo HTML.

Invece di costruire URL a caso per ogni sito (fragile, spesso 404),
questo collector cerca prima i risultati reali per una query e ritorna
solo gli URL che esistono davvero.

Strategia:
  1. Lancia più query DDG HTML in parallelo (no API key, no auth).
  2. Filtra i risultati per domini di guida noti (lista di fiducia).
  3. Deduplica per dominio e ritorna max N URL totali.

Il chiamante fa poi fetch+extract sugli URL trovati.

Uso tipico:
    searcher = GuideSearchCollector()
    urls = await searcher.search_guide_urls_multi(game_title)
    for url in urls:
        html = await generic_client.get(url)
        ...

Domini di fiducia — divisi per accessibilità:
  WORKS (confermati accessibili):
  - powerpyx.com             — guide trofei PSN/achievement
  - fextralife.com           — wiki giochi soulslike/RPG (sottodomini)
  - thegamer.com             — guide trofei vari
  - gamesradar.com           — guide trofei vari
  - ign.com                  — guide professionali
  - gamespot.com             — guide professionali
  - gamefaqs.gamespot.com    — FAQ alta qualità
  - game8.co                 — guide JP/EN dettagliate
  - segmentnext.com          — guide achievement/trofei
  - vgkami.com               — guide trofei
  - fandom.com               — fan wiki (sottodomini per gioco)
  - wiki.gg                  — fan wiki moderni (sottodomini per gioco)
  - neoseeker.com            — FAQ e guide
  - eurogamer.net            — guide professionali
  - polygon.com              — guide professionali
  - screenrant.com           — guide achievement/trofei
  - digitaltrends.com        — guide trofei

  BLOCKED (403/Cloudflare, tenuti per futura compatibilità):
  - playstationtrophies.org  — 403
  - truetrophies.com         — 403
  - trueachievements.com     — Cloudflare
  - psnprofiles.com          — 403
  - trophygamers.com         — verifica necessaria
  - playstationlifestyle.net — verifica necessaria
"""

from __future__ import annotations

import asyncio
import re
import unicodedata
from urllib.parse import quote_plus, unquote, urlparse

import httpx
from bs4 import BeautifulSoup

from src.collectors.base import BaseCollector

# Domini di fiducia — confermati accessibili senza Cloudflare.
# Il matching è per dominio esatto O suffisso (.fextralife.com copre tutti i sottodomini).
TRUSTED_GUIDE_DOMAINS: list[str] = [
    # Confermati accessibili
    "powerpyx.com",
    "fextralife.com",        # sottodomini tipo sekiroshadowsdietwice.wiki.fextralife.com
    "thegamer.com",
    "gamesradar.com",
    "ign.com",
    "gamespot.com",
    "gamefaqs.gamespot.com",
    "game8.co",
    "segmentnext.com",
    "vgkami.com",
    "fandom.com",            # sottodomini tipo bloodborne.fandom.com
    "wiki.gg",               # sottodomini tipo eldenring.wiki.gg
    "neoseeker.com",
    "eurogamer.net",
    "polygon.com",
    "screenrant.com",
    "digitaltrends.com",
    # Tenuti ma spesso bloccati (403/Cloudflare)
    "playstationtrophies.org",
    "truetrophies.com",
    "trueachievements.com",
    "psnprofiles.com",
    "trophygamers.com",
    "playstationlifestyle.net",
]

# Max URL totali da ritornare dopo deduplication domini.
_MAX_RESULTS = 6

# URL DuckDuckGo HTML (no JS required).
_DDG_URL = "https://html.duckduckgo.com/html/?q={query}"

# Template di query multiple per massimizzare la copertura.
# {game} viene sostituito con il titolo del gioco.
_QUERY_TEMPLATES: list[str] = [
    '"{game}" trophy guide platinum walkthrough',
    '"{game}" trophy guide all trophies how to',
    '"{game}" wiki trophy achievement guide',
]


def _domain_of(url: str) -> str:
    """Estrae il dominio di un URL."""
    try:
        netloc = urlparse(url).netloc.lower()
        # Rimuovi 'www.' prefix.
        return netloc.removeprefix("www.")
    except (ValueError, AttributeError):
        return ""


def _is_trusted(url: str) -> bool:
    """True se l'URL appartiene a un dominio di fiducia."""
    domain = _domain_of(url)
    return any(domain == d or domain.endswith(f".{d}") for d in TRUSTED_GUIDE_DOMAINS)


class GuideSearchCollector(BaseCollector):
    """Scopre URL di guide via DuckDuckGo per query libere."""

    domain = "html.duckduckgo.com"
    reliability_score = 1.0  # Il searcher stesso è affidabile; i risultati variano.
    requires_js = False

    def __init__(self) -> None:
        super().__init__()
        # Salta robots.txt check per DuckDuckGo: stiamo usando browser UA,
        # non il bot UA dei settings, quindi il check sarebbe sbagliato.
        self._robots_loaded = True
        # DuckDuckGo richiede User-Agent browser-like; sovrascriviamo il client.
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(15.0),
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/124.0.0.0 Safari/537.36"
                ),
                "Accept-Language": "en-US,en;q=0.9",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
            follow_redirects=True,
        )

    async def _ddg_fetch(self, query: str) -> str | None:
        """Fetch diretto a DDG accettando sia 200 che 202.

        DDG restituisce 202 come rate-limit soft: la body può ancora
        contenere risultati. Accettiamo entrambi e proviamo a parsare.
        """
        ddg_url = _DDG_URL.format(query=quote_plus(query))
        try:
            resp = await self._client.get(ddg_url)
            if resp.status_code in (200, 202):
                return resp.text
            self._logger.warning(
                "DDG: status inatteso",
                status=resp.status_code,
                query=query[:60],
            )
            return None
        except httpx.TimeoutException:
            self._logger.warning("DDG: timeout", query=query[:60])
            return None
        except httpx.HTTPError as exc:
            self._logger.warning("DDG: errore HTTP", error=str(exc), query=query[:60])
            return None

    async def search_guide_urls(
        self,
        query: str,
        max_results: int = _MAX_RESULTS,
        trusted_only: bool = True,
    ) -> list[str]:
        """Cerca guide per una singola query e ritorna URL filtrati.

        Args:
            query: Query di ricerca libera.
            max_results: Massimo URL da ritornare.
            trusted_only: Se True, filtra per domini di fiducia.

        Returns:
            Lista di URL ordinata per posizione nel risultato DuckDuckGo.
        """
        html = await self._ddg_fetch(query)
        if not html:
            return []

        urls = _parse_ddg_results(html)
        self._logger.info(
            "DuckDuckGo: risultati trovati",
            query=query[:80],
            total=len(urls),
            trusted=sum(1 for u in urls if _is_trusted(u)),
        )

        if trusted_only:
            urls = [u for u in urls if _is_trusted(u)]

        return urls[:max_results]

    async def search_guide_urls_multi(
        self,
        game_title: str,
        max_results: int = _MAX_RESULTS,
    ) -> list[str]:
        """Lancia _QUERY_TEMPLATES sequenzialmente e aggrega i risultati.

        Le query sono eseguite in sequenza (non parallele) per non triggerare
        il rate-limit di DuckDuckGo (202 CAPTCHA). Si ferma in anticipo se
        ha già abbastanza URL diversi per dominio.

        Args:
            game_title: Titolo del gioco (es. "Doom Eternal").
            max_results: Max URL totali da ritornare.

        Returns:
            Lista URL deduplicata per netloc, ordinata per frequenza apparizione.
        """
        queries = [t.replace("{game}", game_title) for t in _QUERY_TEMPLATES]

        url_score: dict[str, int] = {}
        netloc_seen: set[str] = set()
        deduped: list[str] = []

        for i, query in enumerate(queries):
            # Early-exit: già abbastanza URL di domini diversi.
            if len(deduped) >= max_results:
                break

            urls = await self.search_guide_urls(query, max_results=10, trusted_only=True)

            for url in urls:
                url_score[url] = url_score.get(url, 0) + 1
                key = urlparse(url).netloc.lower()
                if key not in netloc_seen:
                    netloc_seen.add(key)
                    deduped.append(url)

            # Pausa tra query per evitare rate-limit DDG (tranne all'ultima).
            if i < len(queries) - 1 and len(deduped) < max_results:
                await asyncio.sleep(2.0)

        self._logger.info(
            "DDG multi-query: URL aggregati",
            game=game_title,
            queries_run=len(queries),
            unique_urls=len(deduped),
            domains=list(netloc_seen),
        )
        return deduped[:max_results]

    async def extract(self, html: str, url: str) -> dict | None:
        """Non usato direttamente — GuideSearchCollector è solo per discovery."""
        return None


# ── Fallback deterministico ───────────────────────────────────────────────────


def _slugify(text: str) -> str:
    """Slug URL-safe per costruzione URL fallback."""
    text = unicodedata.normalize("NFKD", text.lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r"['\u2019\u2018]", "", text)
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")


def build_fallback_urls(game_title: str) -> list[str]:
    """Costruisce URL deterministici per i siti più affidabili.

    Usato quando DDG è bloccato/rate-limited. Gli URL potrebbero dare 404
    se il gioco non è presente sul sito, ma è meglio che zero fonti.

    Siti scelti per accessibilità (no Cloudflare) e copertura PSN:
      - powerpyx.com        — guide trofei PSN
      - gamefaqs.gamespot.com — FAQ alta qualità
      - thegamer.com        — guide trofei vari
    """
    slug = _slugify(game_title)
    return [
        f"https://www.powerpyx.com/{slug}-trophy-guide-roadmap/",
        f"https://www.thegamer.com/{slug}-all-trophies-and-achievements-guide/",
        f"https://gamefaqs.gamespot.com/search?game={quote_plus(game_title)}&platform=ps5",
    ]


# ── Helpers ───────────────────────────────────────────────────────────────────


def _parse_ddg_results(html: str) -> list[str]:
    """Estrae gli URL dai risultati HTML di DuckDuckGo.

    DuckDuckGo HTML (html.duckduckgo.com) usa `<a class="result__a">` con href
    in formato `//duckduckgo.com/l/?uddg=<URL-encoded-target>&rut=...`.
    L'URL reale è nel parametro `uddg`.
    """
    soup = BeautifulSoup(html, "html.parser")
    urls: list[str] = []

    for a in soup.select("a.result__a"):
        href = str(a.get("href", ""))
        if not href:
            continue

        # Formato attuale DDG: //duckduckgo.com/l/?uddg=<encoded_url>&rut=...
        if "duckduckgo.com" in href and "uddg=" in href:
            match = re.search(r"[?&]uddg=([^&]+)", href)
            if match:
                decoded = unquote(match.group(1))
                if decoded.startswith("http") and "duckduckgo.com" not in decoded:
                    urls.append(decoded)
            continue

        # Formato diretto: href già come https://...
        if href.startswith("http") and "duckduckgo.com" not in href:
            urls.append(href)

    # Deduplication preservando ordine.
    seen: set[str] = set()
    deduped: list[str] = []
    for u in urls:
        if u not in seen:
            seen.add(u)
            deduped.append(u)

    return deduped

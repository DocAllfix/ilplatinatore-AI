"""ExophaseCollector — collector per exophase.com.

Exophase è un aggregatore di achievement/trofei con pagine per-gioco
che listano tutti i trofei con descrizioni e tips della community.

Struttura pagina trofei:
  - URL: https://www.exophase.com/game/{slug}/trophies/
  - I trofei sono in lista con nome, descrizione e tips.
  - Heading h3/h4 o div con classe trophy-name per ogni trofeo.

Reliability score 0.75 (community-based, aggiornamento variabile).
"""

from __future__ import annotations

import re
import unicodedata

from bs4 import BeautifulSoup

from src.collectors.base import BaseCollector, compute_hash

_JUNK_SELECTORS = [
    "nav", "aside", "footer", "header", "script", "style",
    "noscript", "form", ".sidebar", ".advertisement", ".ad",
    ".comments", ".comment", ".breadcrumb", ".pagination",
    "#footer", "#header", "#sidebar",
]

_MAX_CONTENT_CHARS = 15_000
_MIN_CONTENT_CHARS = 200

_TROPHIES_URL = "https://www.exophase.com/game/{slug}/trophies/"


def _slugify_exophase(title: str) -> str:
    """Slug per Exophase: lowercase + trattini, apostrofi rimossi."""
    text = unicodedata.normalize("NFKD", title.lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r"['\u2019\u2018]", "", text)
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")


class ExophaseCollector(BaseCollector):
    """Collector per trofei/achievement su exophase.com."""

    domain = "www.exophase.com"
    reliability_score = 0.75
    requires_js = False

    def guide_url(self, game_title: str) -> str:
        """Costruisce l'URL della pagina trofei per un gioco."""
        return _TROPHIES_URL.format(slug=_slugify_exophase(game_title))

    async def extract(self, html: str, url: str) -> dict | None:
        """Estrae trofei e descrizioni dall'HTML di Exophase.

        Ritorna None se la pagina non ha contenuto utile.
        """
        soup = BeautifulSoup(html, "html.parser")

        for selector in _JUNK_SELECTORS:
            for tag in soup.select(selector):
                tag.decompose()

        title = _extract_title(soup)

        # Container principale trofei.
        container = (
            soup.select_one(".trophy-list")
            or soup.select_one("#trophy-list")
            or soup.select_one(".achievements")
            or soup.select_one("#content")
            or soup.find("main")
            or soup.body
            or soup
        )

        raw_text = container.get_text(separator="\n", strip=True)
        clean_text = _normalize_whitespace(raw_text)[:_MAX_CONTENT_CHARS]

        if len(clean_text) < _MIN_CONTENT_CHARS:
            self._logger.debug(
                "pagina scartata: contenuto insufficiente",
                url=url[:100],
                chars=len(clean_text),
            )
            return None

        return {
            "title": title,
            "game_name": None,
            "trophy_name": None,
            "guide_type": "walkthrough",
            "raw_content": clean_text,
            "source_url": url,
            "source_domain": self.domain,
            "content_hash": compute_hash(clean_text),
        }


# ── Helpers ───────────────────────────────────────────────────────────────────


def _extract_title(soup: BeautifulSoup) -> str:
    h1 = soup.find("h1")
    if h1 and h1.get_text(strip=True):
        return h1.get_text(strip=True)
    title_tag = soup.find("title")
    if title_tag and title_tag.get_text(strip=True):
        return title_tag.get_text(strip=True)
    return "Untitled"


def _normalize_whitespace(text: str) -> str:
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text)
    text = re.sub(r" *\n *", "\n", text)
    return text.strip()

"""PSTrophiesOrgCollector — collector per playstationtrophies.org.

PlaystationTrophies.org ha guide scritte da editor con walkthrough dettagliati
per ogni trofeo, strutturate con heading h2/h3 per sezione.

Struttura pagina guida:
  - URL guida: https://www.playstationtrophies.org/game/{slug}/guide.html
  - Sezioni per-trofeo delimitate da h2/h3/h4.
  - Contenuto testuale di alta qualità (guide verificate).

Reliability score 0.88 (guide editoriali, aggiornate regolarmente).
"""

from __future__ import annotations

import re
import unicodedata

from bs4 import BeautifulSoup

from src.collectors.base import BaseCollector, compute_hash

_JUNK_SELECTORS = [
    "nav", "aside", "footer", "header", "script", "style",
    "noscript", "form", ".sidebar", ".advertisement", ".ad",
    ".comments", ".comment-section", ".breadcrumb", ".pagination",
    "#footer", "#header", "#sidebar", "#comments",
    ".social-share", ".related-guides", ".trophy-list-header",
]

_MAX_CONTENT_CHARS = 15_000
_MIN_CONTENT_CHARS = 200

_GUIDE_URL = "https://www.playstationtrophies.org/game/{slug}/guide.html"


def _slugify_psorg(title: str) -> str:
    """Slug per playstationtrophies.org: lowercase + trattini, no caratteri speciali."""
    text = unicodedata.normalize("NFKD", title.lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    # Sostituisce caratteri non alfanumerici con trattini.
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")


class PSTrophiesOrgCollector(BaseCollector):
    """Collector per guide trofei su playstationtrophies.org."""

    domain = "www.playstationtrophies.org"
    reliability_score = 0.88
    requires_js = False

    def guide_url(self, game_title: str) -> str:
        """Costruisce l'URL della guida per un gioco."""
        return _GUIDE_URL.format(slug=_slugify_psorg(game_title))

    async def extract(self, html: str, url: str) -> dict | None:
        """Estrae titolo e contenuto pulito dall'HTML di PlaystationTrophies.org.

        Ritorna None se la pagina non ha contenuto utile.
        """
        soup = BeautifulSoup(html, "html.parser")

        for selector in _JUNK_SELECTORS:
            for tag in soup.select(selector):
                tag.decompose()

        title = _extract_title(soup)

        # Container principale della guida.
        container = (
            soup.select_one(".guide-content")
            or soup.select_one("#guide-content")
            or soup.select_one(".trophy-guide")
            or soup.select_one("#content")
            or soup.find("article")
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

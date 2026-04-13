"""PowerPyxCollector — collector concreto per powerpyx.com.

PowerPyx è il sito di guide trofei più strutturato e affidabile.
Reliability score alto (0.95), contenuto statico (no JS).
"""

from __future__ import annotations

import re
from urllib.parse import urlparse

from bs4 import BeautifulSoup

from src.collectors.base import BaseCollector, compute_hash

# Tag/selettori da rimuovere prima di estrarre il testo.
_JUNK_SELECTORS = [
    "nav",
    "aside",
    "footer",
    "script",
    "style",
    "noscript",
    "form",
    ".comments",
    ".comment",
    ".sidebar",
    ".ad",
    ".ads",
    ".advertisement",
    ".share",
    ".social",
    "#comments",
    "#sidebar",
]

_MAX_CONTENT_CHARS = 15_000
_MIN_CONTENT_CHARS = 200


class PowerPyxCollector(BaseCollector):
    """Collector per guide trofei su powerpyx.com."""

    domain = "powerpyx.com"
    reliability_score = 0.95
    requires_js = False

    async def extract(self, html: str, url: str) -> dict | None:
        """Estrae titolo, contenuto pulito e metadati dall'HTML di PowerPyx.

        Ritorna None se la pagina non ha contenuto utile (< 200 char puliti).
        """
        soup = BeautifulSoup(html, "html.parser")

        # Rimuovi elementi di navigazione, sidebar, pubblicità, script.
        for selector in _JUNK_SELECTORS:
            for tag in soup.select(selector):
                tag.decompose()

        # Titolo: prima <h1>, fallback <title>.
        title = self._extract_title(soup)

        # Container principale: .entry-content, poi <article>, poi <main>, poi <body>.
        container = (
            soup.select_one(".entry-content")
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

        game_name, trophy_name = _parse_url_slug(url)

        return {
            "title": title,
            "game_name": game_name,
            "trophy_name": trophy_name,
            "guide_type": "walkthrough",
            "raw_content": clean_text,
            "source_url": url,
            "source_domain": self.domain,
            "content_hash": compute_hash(clean_text),
        }

    @staticmethod
    def _extract_title(soup: BeautifulSoup) -> str:
        h1 = soup.find("h1")
        if h1 and h1.get_text(strip=True):
            return h1.get_text(strip=True)
        title_tag = soup.find("title")
        if title_tag and title_tag.get_text(strip=True):
            return title_tag.get_text(strip=True)
        return "Untitled"


def _normalize_whitespace(text: str) -> str:
    """Collassa spazi multipli e normalizza newline."""
    # Collassa spazi/tab, preserva newline come separatori di paragrafo.
    text = re.sub(r"[ \t]+", " ", text)
    # Max 2 newline consecutivi.
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text)
    # Rimuovi spazi attorno ai newline.
    text = re.sub(r" *\n *", "\n", text)
    return text.strip()


def _parse_url_slug(url: str) -> tuple[str | None, str | None]:
    """Estrae game_name e trophy_name dallo slug URL di PowerPyx.

    Formati tipici:
      - /elden-ring-trophy-guide/       → game="Elden Ring", trophy=None
      - /elden-ring-elden-lord-trophy/  → game="Elden Ring" (best effort), trophy="Elden Lord"
      - /god-of-war-ragnarok-trophy-guide-roadmap/ → game="God Of War Ragnarok"
    """
    try:
        path = urlparse(url).path.strip("/")
    except (ValueError, AttributeError):
        return None, None

    if not path:
        return None, None

    # Prendi l'ultimo segmento significativo.
    slug = path.split("/")[-1]

    # Rimuovi suffissi comuni.
    suffixes = [
        "-trophy-guide-roadmap",
        "-trophies-guide-roadmap",
        "-trophy-guide",
        "-trophies-guide",
        "-trophy-roadmap",
        "-guide-roadmap",
        "-roadmap",
        "-guide",
        "-trophy",
        "-trophies",
    ]
    cleaned = slug
    for sfx in suffixes:
        if cleaned.endswith(sfx):
            cleaned = cleaned[: -len(sfx)]
            break

    if not cleaned:
        return None, None

    game_name = cleaned.replace("-", " ").strip().title() or None
    return game_name, None

"""TrueAchievementsCollector — collector per trueachievements.com.

Guide achievement nella sezione /game/{slug}/achievements e walkthrough.
Reliability score 0.90, contenuto statico (no JS).
"""

from __future__ import annotations

import re
from urllib.parse import urlparse

from bs4 import BeautifulSoup, Tag

from src.collectors.base import BaseCollector, compute_hash

_JUNK_SELECTORS = [
    "nav",
    "aside",
    "footer",
    "header",
    "script",
    "style",
    "noscript",
    "form",
    ".comments",
    ".comment",
    ".ad",
    ".ads",
    ".advertisement",
    ".sidebar",
    ".breadcrumb",
    ".breadcrumbs",
    ".pagination",
    ".social-share",
    "#header",
    "#footer",
    "#sidebar",
    "#comments",
]

# Selettori del container guida, in ordine di priorità.
_GUIDE_SELECTORS = [
    ".wiki-article",
    ".wiki-entry",
    ".achievement-solution",
    ".walkthrough-content",
    "article",
    "main",
    ".content",
]

_MAX_CONTENT_CHARS = 15_000
_MIN_CONTENT_CHARS = 200


class TrueAchievementsCollector(BaseCollector):
    """Collector per guide achievement su trueachievements.com."""

    domain = "trueachievements.com"
    reliability_score = 0.90
    requires_js = False

    async def extract(self, html: str, url: str) -> dict | None:
        """Estrae titolo, lista achievement e testo da TrueAchievements.

        Ritorna None se la pagina non ha contenuto utile (< 200 char puliti).
        """
        soup = BeautifulSoup(html, "html.parser")

        # Rimuovi nav, sidebar, ads, script, style.
        for selector in _JUNK_SELECTORS:
            for tag in soup.select(selector):
                tag.decompose()

        # Titolo: <h1> poi <title>.
        title = _extract_title(soup)

        # Container guida: prova selettori multipli.
        container: Tag | None = None
        for sel in _GUIDE_SELECTORS:
            container = soup.select_one(sel)
            if container is not None:
                break
        if container is None:
            container = soup.body or soup  # type: ignore[assignment]

        raw_text = container.get_text(separator="\n", strip=True)
        clean_text = _normalize_whitespace(raw_text)[:_MAX_CONTENT_CHARS]

        if len(clean_text) < _MIN_CONTENT_CHARS:
            self._logger.debug(
                "pagina scartata: contenuto insufficiente",
                url=url[:100],
                chars=len(clean_text),
            )
            return None

        game_name = _parse_game_name_from_url(url)

        return {
            "title": title,
            "game_name": game_name,
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
    """Collassa spazi multipli e normalizza newline."""
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text)
    text = re.sub(r" *\n *", "\n", text)
    return text.strip()


def _parse_game_name_from_url(url: str) -> str | None:
    """Estrae game_name dall'URL TrueAchievements.

    Formati tipici:
      - /game/elden-ring/achievements          → "Elden Ring"
      - /game/god-of-war-ragnarok/walkthrough  → "God Of War Ragnarok"
      - /game/the-last-of-us/                  → "The Last Of Us"
    """
    try:
        path = urlparse(url).path.strip("/")
    except (ValueError, AttributeError):
        return None

    parts = [p for p in path.split("/") if p]
    # Cerca il segmento dopo "game".
    for i, part in enumerate(parts):
        if part == "game" and i + 1 < len(parts):
            slug = parts[i + 1]
            return slug.replace("-", " ").strip().title() or None

    return None

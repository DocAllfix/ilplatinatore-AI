"""FextralifeCollector — guide wiki Soulslike/Metroidvania.

Fextralife usa rendering JS pesante. NON installiamo Playwright nel container
harvester (512MB target). Strategia:
  1. Tentativo httpx + BeautifulSoup (a volte CDN cache serve HTML parziale).
  2. Se clean_text < 200 char → logga warning e ritorna None.
     Lo scraping on-demand del backend Node (Puppeteer) lo gestirà live.
"""

from __future__ import annotations

import re
from urllib.parse import urlparse

from bs4 import BeautifulSoup

from src.collectors.base import BaseCollector, compute_hash

_JUNK_SELECTORS = [
    "nav",
    "aside",
    "footer",
    "script",
    "style",
    "noscript",
    "form",
    ".ad-container",
    ".sponsor",
    ".ads",
    ".advertisement",
    ".sidebar",
    "#sidebar",
    ".comments",
    "#comments",
]

_MAX_CONTENT_CHARS = 15_000
_MIN_CONTENT_CHARS = 200


class FextralifeCollector(BaseCollector):
    """Collector per wiki.fextralife.com (boss, build, lore)."""

    domain = "wiki.fextralife.com"
    reliability_score = 0.85
    requires_js = False  # Fallback interno: None se JS-rendered

    async def extract(self, html: str, url: str) -> dict | None:
        soup = BeautifulSoup(html, "html.parser")

        for selector in _JUNK_SELECTORS:
            for tag in soup.select(selector):
                tag.decompose()

        title = self._extract_title(soup)

        # Fextralife usa #wiki-content-block o .wiki-content-block.
        container = (
            soup.select_one("#wiki-content-block")
            or soup.select_one(".wiki-content-block")
            or soup.find("article")
            or soup.find("main")
            or soup.body
            or soup
        )

        raw_text = container.get_text(separator="\n", strip=True)
        clean_text = _normalize_whitespace(raw_text)[:_MAX_CONTENT_CHARS]

        if len(clean_text) < _MIN_CONTENT_CHARS:
            self._logger.warning(
                "Fextralife: contenuto insufficiente, probabile JS rendering "
                "richiesto. Skip (on-demand backend gestirà live).",
                url=url[:100],
                chars=len(clean_text),
            )
            return None

        game_name, topic = _parse_url_slug(url)

        return {
            "title": title,
            "game_name": game_name,
            "trophy_name": None,
            "guide_type": "boss",
            "topic": topic,
            "raw_content": clean_text,
            "source_url": url,
            "source_domain": self.domain,
            "content_hash": compute_hash(clean_text),
            "source_type": "supplementary",
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
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text)
    text = re.sub(r" *\n *", "\n", text)
    return text.strip()


def _parse_url_slug(url: str) -> tuple[str | None, str | None]:
    """Estrae game_name e topic dallo slug Fextralife.

    Pattern: wiki.fextralife.com/{game}/{topic}
    """
    try:
        path = urlparse(url).path.strip("/")
    except (ValueError, AttributeError):
        return None, None

    if not path:
        return None, None

    parts = path.split("/")
    game_name = parts[0].replace("-", " ").replace("+", " ").strip().title() or None
    topic = (
        parts[-1].replace("-", " ").replace("+", " ").strip().title()
        if len(parts) > 1
        else None
    )
    return game_name, topic

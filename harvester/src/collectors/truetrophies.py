"""TrueTrophiesCollector — collector per truetrophies.com.

TrueTrophies è una community di collezionisti trofei PSN con guide walkthrough
e tips per ogni trofeo, scritte e votate dalla community.

Struttura pagina guida:
  - URL gioco: https://www.truetrophies.com/{game-slug}-trophies.htm
  - Le sezioni per-trofeo usano heading h3/h4 con il nome del trofeo.
  - I tips della community sono sotto ogni sezione.

Reliability score 0.80 (community-based, qualità variabile).
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
    "#footer", "#header", "#sidebar", "#comments",
    ".leaderboard", ".social-share",
]

_MAX_CONTENT_CHARS = 15_000
_MIN_CONTENT_CHARS = 200

# URL patterns TrueTrophies
_GUIDE_URL = "https://www.truetrophies.com/{slug}-trophies.htm"


def _slugify_truetrophies(title: str) -> str:
    """Slug per TrueTrophies: NFKD + lowercase + trattini come separatori.

    Esempi:
      "Doom Eternal"      → "doom-eternal"
      "Bloodborne"        → "bloodborne"
      "Astro's Playroom"  → "astros-playroom"  (apostrofo rimosso, non convertito)
    """
    text = unicodedata.normalize("NFKD", title.lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    # Rimuovi apostrofi/virgolette prima di sostituire con trattini.
    text = re.sub(r"['\u2019\u2018]", "", text)
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")


class TrueTrophiesCollector(BaseCollector):
    """Collector per guide trofei su truetrophies.com."""

    domain = "www.truetrophies.com"
    reliability_score = 0.80
    requires_js = False

    def guide_url(self, game_title: str) -> str:
        """Costruisce l'URL della pagina trofei per un gioco."""
        return _GUIDE_URL.format(slug=_slugify_truetrophies(game_title))

    async def extract(self, html: str, url: str) -> dict | None:
        """Estrae titolo e contenuto pulito dall'HTML di TrueTrophies.

        Ritorna None se la pagina non ha contenuto utile.
        """
        soup = BeautifulSoup(html, "html.parser")

        for selector in _JUNK_SELECTORS:
            for tag in soup.select(selector):
                tag.decompose()

        title = _extract_title(soup)

        # Container principale: .walkthrough-content, .guide-content, article, main.
        container = (
            soup.select_one(".walkthrough-content")
            or soup.select_one(".guide-content")
            or soup.select_one(".trophy-guide")
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

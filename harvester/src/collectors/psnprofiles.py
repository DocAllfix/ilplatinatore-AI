"""PSNProfilesCollector — collector per psnprofiles.com.

Guide trophy nella sezione /guide/{id}-{slug}.
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
    ".comment-wrapper",
    ".comments",
    ".advertisement",
    ".ad-block",
    ".share-buttons",
    ".sidebar",
    "#header",
    "#footer",
    "#comments",
    "#sidebar",
    ".breadcrumbs",
    ".pagination",
]

# Selettori del container guida, in ordine di priorità.
_GUIDE_SELECTORS = [
    "#guide",
    ".guide-content",
    ".guide",
    "article",
    "main",
]

_MAX_CONTENT_CHARS = 15_000
_MIN_CONTENT_CHARS = 200


class PSNProfilesCollector(BaseCollector):
    """Collector per guide trofei su psnprofiles.com."""

    domain = "psnprofiles.com"
    reliability_score = 0.90
    requires_js = False

    async def extract(self, html: str, url: str) -> dict | None:
        """Estrae titolo, tabelle trofei e testo dalla guida PSNProfiles.

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

        # Converti tabelle trofei in testo strutturato prima di get_text.
        _convert_tables_to_text(container)

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


# ── Helpers ───────────────────────────────────────────────────────────────────


def _extract_title(soup: BeautifulSoup) -> str:
    h1 = soup.find("h1")
    if h1 and h1.get_text(strip=True):
        return h1.get_text(strip=True)
    title_tag = soup.find("title")
    if title_tag and title_tag.get_text(strip=True):
        return title_tag.get_text(strip=True)
    return "Untitled"


def _convert_tables_to_text(container: Tag) -> None:
    """Converte tabelle <table class="zebra"> in testo strutturato pipe-delimited.

    La conversione avviene in-place: ogni tabella viene sostituita con il suo
    equivalente testuale per preservare il contenuto nel get_text successivo.
    """
    for table in container.find_all("table"):
        rows: list[str] = []
        for tr in table.find_all("tr"):
            cells = [td.get_text(strip=True) for td in tr.find_all(["th", "td"])]
            if cells:
                rows.append("| " + " | ".join(cells) + " |")
        if rows:
            table_text = "\n".join(rows)
            table.replace_with(BeautifulSoup(f"<pre>{table_text}</pre>", "html.parser"))


def _normalize_whitespace(text: str) -> str:
    """Collassa spazi multipli e normalizza newline."""
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text)
    text = re.sub(r" *\n *", "\n", text)
    return text.strip()


def _parse_url_slug(url: str) -> tuple[str | None, str | None]:
    """Estrae game_name dall'URL PSNProfiles.

    Formati tipici:
      - /guide/12345-elden-ring/                  → game="Elden Ring"
      - /guide/7890-god-of-war-ragnarok/           → game="God Of War Ragnarok"
      - /trophy/12345-elden-ring/trophy-name/      → game="Elden Ring"
    """
    try:
        path = urlparse(url).path.strip("/")
    except (ValueError, AttributeError):
        return None, None

    parts = [p for p in path.split("/") if p]
    # Cerca il segmento dopo "guide" o "trophy".
    slug_part: str | None = None
    for i, part in enumerate(parts):
        if part in ("guide", "trophy") and i + 1 < len(parts):
            slug_part = parts[i + 1]
            break

    if slug_part is None and parts:
        slug_part = parts[-1]

    if not slug_part:
        return None, None

    # Rimuovi il prefisso numerico (es. "12345-elden-ring" → "elden-ring").
    slug_clean = re.sub(r"^\d+-", "", slug_part)
    if not slug_clean:
        return None, None

    game_name = slug_clean.replace("-", " ").strip().title() or None
    return game_name, None

"""FandomCollector — guide wiki via MediaWiki API (api.php).

Architettura
------------
Fandom espone l'API MediaWiki standard senza autenticazione su ogni subdomain:
  https://{subdomain}.fandom.com/api.php

Flusso principale:
  1. `search_wiki(subdomain, query, limit)` → lista titoli di pagina candidati
     via action=query&list=search
  2. `fetch_page(subdomain, title)` → wikitext parsato + categorie
     via action=parse&page={title}&prop=text|categories
  3. `extract(html_body, url, categories)` → dict standard pipeline
     con guide_type inferito dalle categorie MediaWiki

Il metodo `collect(url)` supporta anche URL diretti Fandom tipo:
  https://eldenring.fandom.com/wiki/Malenia

Copertura tematica
------------------
Fandom copre TUTTO, non solo trofei:
  - Boss strategies, lore, character pages
  - Build guides, weapon/armor stats
  - Puzzles, collectibles, questlines
  - General walkthroughs
Ideale per le domande non-trofeo dell'utente finale.

Compliance
----------
MediaWiki API è pubblica e documentata. Dati sotto CC-BY-SA.
Attribuzione tramite source_url nel DB (harvest_sources.source_url).
Rate limiting via BaseCollector._respect_delay + PerHostTokenBucket.
"""

from __future__ import annotations

import html
import json
import re
from typing import Any
from urllib.parse import quote, urlparse

from src.collectors.base import BaseCollector, compute_hash

# ── Endpoints ────────────────────────────────────────────────────────────────

_API_PATH = "/api.php"
_DEFAULT_LANG = "en"

# ── Filtri qualità ───────────────────────────────────────────────────────────

_MIN_CONTENT_CHARS = 300
_MAX_CONTENT_CHARS = 12_000

# ── Regex ────────────────────────────────────────────────────────────────────

# Estrae subdomain e page title da URL Fandom.
# https://eldenring.fandom.com/wiki/Malenia → ("eldenring", "Malenia")
_FANDOM_URL_RE = re.compile(
    r"https?://([a-zA-Z0-9\-]+)\.fandom\.com/(?:wiki|w)/([^?#]+)"
)

# Pulizia HTML: rimuove tag mantenendo testo.
_HTML_TAG_RE = re.compile(r"<[^>]+>")

# Normalizza whitespace multiplo.
_WHITESPACE_RE = re.compile(r"\s{2,}")

# ── Mapping categorie → guide_type ──────────────────────────────────────────

_CATEGORY_TYPE_MAP: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bboss(?:es)?\b", re.I), "boss"),
    (re.compile(r"\blore\b|\bstory\b|\bnarrative\b", re.I), "lore"),
    (re.compile(r"\bbuild(?:s)?\b|\bclass(?:es)?\b", re.I), "build"),
    (re.compile(r"\bcollectible(?:s)?\b|\bitem(?:s)?\b|\bweapon(?:s)?\b|\barmor\b", re.I),
     "collectible"),
    (re.compile(r"\bpuzzle(?:s)?\b|\brigma(?:s)?\b|\benigma\b", re.I), "puzzle"),
    (re.compile(r"\btrophy\b|\btrophies\b|\bachievement(?:s)?\b|\btrofe\b", re.I), "trophy_guide"),
    (re.compile(r"\bwalkthrough\b|\bguide\b|\btutorial\b", re.I), "walkthrough"),
]

_DEFAULT_GUIDE_TYPE = "walkthrough"


def _infer_guide_type(categories: list[str], title: str = "") -> str:
    """Inferisce guide_type da categorie MediaWiki e titolo pagina."""
    combined = " ".join(categories) + " " + title
    for pattern, gtype in _CATEGORY_TYPE_MAP:
        if pattern.search(combined):
            return gtype
    return _DEFAULT_GUIDE_TYPE


def _strip_html(raw: str) -> str:
    """Rimuove tag HTML e decodifica entità HTML. Normalizza whitespace."""
    text = _HTML_TAG_RE.sub(" ", raw)
    text = html.unescape(text)
    return _WHITESPACE_RE.sub(" ", text).strip()


class FandomCollector(BaseCollector):
    """Collector per guide wiki da Fandom via MediaWiki API."""

    domain = "fandom.com"
    reliability_score = 0.80  # wiki curate dalla community, buona profondità tematica
    requires_js = False

    # ── Discovery: ricerca pagine ────────────────────────────────────────────

    async def search_wiki(
        self, subdomain: str, query: str, limit: int = 5
    ) -> list[str]:
        """Cerca pagine nel wiki Fandom e ritorna lista di titoli.

        Usa action=query&list=search (MediaWiki search API).
        """
        params = (
            f"action=query"
            f"&list=search"
            f"&srsearch={quote(query)}"
            f"&srlimit={limit}"
            f"&format=json"
            f"&utf8=1"
        )
        url = f"https://{subdomain}.fandom.com{_API_PATH}?{params}"
        body = await self.fetch(url)
        if not body:
            return []

        try:
            data = json.loads(body)
        except (ValueError, json.JSONDecodeError):
            self._logger.warning("Fandom search: JSON invalido", subdomain=subdomain)
            return []

        results = (data.get("query") or {}).get("search") or []
        return [r["title"] for r in results if r.get("title")]

    # ── Fetch singola pagina ─────────────────────────────────────────────────

    async def fetch_page(
        self, subdomain: str, title: str
    ) -> dict[str, Any] | None:
        """Ritorna {html_text, categories, page_url} per una pagina Fandom.

        Usa action=parse (HTML parsato) + prop=text|categories.
        """
        params = (
            f"action=parse"
            f"&page={quote(title)}"
            f"&prop=text%7Ccategories"
            f"&format=json"
            f"&utf8=1"
        )
        url = f"https://{subdomain}.fandom.com{_API_PATH}?{params}"
        body = await self.fetch(url)
        if not body:
            return None

        try:
            data = json.loads(body)
        except (ValueError, json.JSONDecodeError):
            self._logger.warning(
                "Fandom fetch_page: JSON invalido",
                subdomain=subdomain,
                title=title,
            )
            return None

        # Errore API (pagina non trovata, ecc.)
        if "error" in data:
            self._logger.warning(
                "Fandom API error",
                subdomain=subdomain,
                title=title,
                error=data["error"].get("info", ""),
            )
            return None

        parse_data = data.get("parse") or {}
        html_text = (parse_data.get("text") or {}).get("*", "")
        cats_raw = parse_data.get("categories") or []
        categories = [c.get("*", "") for c in cats_raw if c.get("*")]

        page_title = parse_data.get("title", title)
        page_url = f"https://{subdomain}.fandom.com/wiki/{quote(page_title)}"

        return {
            "html_text": html_text,
            "categories": categories,
            "page_url": page_url,
            "page_title": page_title,
        }

    # ── collect() override per dispatch diretto da URL ───────────────────────

    async def collect(self, url: str) -> dict | None:  # type: ignore[override]
        """Supporta dispatch da seed file con URL fandom.com/wiki/PAGE."""
        m = _FANDOM_URL_RE.match(url)
        if not m:
            self._logger.warning(
                "collect Fandom: URL non riconosciuto", url=url[:100]
            )
            return None

        subdomain = m.group(1)
        title = m.group(2).replace("_", " ")

        page_data = await self.fetch_page(subdomain, title)
        if page_data is None:
            return None

        return await self.extract(
            page_data["html_text"],
            page_data["page_url"],
            categories=page_data["categories"],
            page_title=page_data["page_title"],
        )

    # ── extract() ────────────────────────────────────────────────────────────

    async def extract(  # type: ignore[override]
        self,
        html_body: str,
        url: str,
        categories: list[str] | None = None,
        page_title: str | None = None,
    ) -> dict | None:
        """Parsa HTML MediaWiki e ritorna dict standard collector.

        `categories` e `page_title` opzionali: usati per inferire guide_type
        e topic (slug della pagina wiki).
        """
        if not html_body:
            return None

        content = _strip_html(html_body)
        if len(content) < _MIN_CONTENT_CHARS:
            return None

        cats = categories or []
        title = page_title or ""
        guide_type = _infer_guide_type(cats, title)

        # topic: il titolo della pagina wiki (es. "Malenia", "Moonveil Katana")
        # usato dal deduplicatore per distinguere guide granulari diverse.
        topic = title.strip() if title.strip() else None

        # Estrai subdomain per source_domain più preciso
        parsed = urlparse(url)
        source_domain = parsed.netloc or "fandom.com"

        return {
            "title": title or "Fandom Wiki Guide",
            "game_name": None,  # caller (pipeline) popola
            "trophy_name": None,
            "guide_type": guide_type,
            "topic": topic,
            "raw_content": content[:_MAX_CONTENT_CHARS],
            "source_url": url,
            "source_domain": source_domain,
            "content_hash": compute_hash(content[:_MAX_CONTENT_CHARS]),
            "source_type": "supplementary",
            "extra": {
                "fandom_categories": cats,
                "fandom_page_title": title,
            },
        }

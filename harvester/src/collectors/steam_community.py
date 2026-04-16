"""SteamCommunityGuidesCollector — guide user-generated via API Steam ufficiale.

Endpoint: `IPublishedFileService/QueryFiles` (discovery) e `GetDetails`
(contenuto). Auth: `STEAM_API_KEY` già configurata.

License / compliance
--------------------
Contenuto è user-generated Steam Community. Steam Subscriber Agreement +
Workshop Distribution Agreement concedono a Valve licenza sul contenuto e
Valve espone l'API ufficiale per uso programmatico. Usiamo il contenuto in
modalità **transformative** (synthesis LLM + attribuzione allo URL
user-facing `steamcommunity.com/sharedfiles/filedetails/?id=<id>`), mai
ripubblicato wholesale. Compatibile con policy.

Sicurezza
---------
`STEAM_API_KEY` compare nell'URL della request (query string). Override
`fetch()` redige la chiave PRIMA del logging per evitare leak nei pino log.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any

import httpx

from src.collectors.base import (
    PER_HOST_BUCKET,
    BaseCollector,
    compute_hash,
)
from src.config.settings import settings

# ── Endpoint ─────────────────────────────────────────────────────────────────

_QUERY_URL = (
    "https://api.steampowered.com/IPublishedFileService/QueryFiles/v1/"
)
_DETAILS_URL = (
    "https://api.steampowered.com/IPublishedFileService/GetDetails/v1/"
)

_FILETYPE_GUIDE = 9  # Steam filetype id per Community Guides
_QUERY_TYPE_RANKED_BY_TREND = 3  # trending su 7d
_LANG_ENGLISH = 0

# ── Filtri qualità ───────────────────────────────────────────────────────────

_MIN_VIEWS = 500
_MIN_VOTES = 10
_MAX_GUIDES_PER_GAME = 10
_MAX_CONTENT_CHARS = 15_000
_MIN_CONTENT_CHARS = 300

# ── Tag Steam → guide_type (whitelist CHECK migration 018) ───────────────────

_TAG_TO_GUIDE_TYPE: dict[str, str] = {
    "walkthrough": "walkthrough",
    "achievements": "trophy",
    "maps or levels": "collectible",
    "secrets": "lore",
    "lore": "lore",
    "characters": "lore",
    "co-op": "meta",
    "multiplayer": "meta",
    "strategy": "meta",
    "tips and tricks": "meta",
    "modding or configuration": "meta",
}

# Regex per redigere la API key nei log
_KEY_REDACT_RE = re.compile(r"(key=)[^&]+")


class SteamCommunityGuidesCollector(BaseCollector):
    """Collector per Steam Community Guides via API ufficiale.

    Uso tipico (dal pipeline):
        guides = await col.discover_guides(appid, limit=5)
        for g in guides:
            result = await col.collect(g["detail_url"])
    """

    domain = "api.steampowered.com"
    reliability_score = 0.75  # user-generated, qualità variabile
    requires_js = False

    # ── Override fetch per redigere API key nei log ──────────────────────────

    async def fetch(self, url: str) -> str | None:
        """Fetch con redazione di `key=...` nei log.

        Implementazione: ricalca BaseCollector.fetch ma sostituisce l'URL nel
        log con una versione redatta. Non modifica l'URL reale della request.
        """
        # Lazy load robots.txt (stesso pattern di BaseCollector).
        if not self._robots_loaded:
            await self._load_robots()

        if not await self._is_allowed(url):
            return None

        await PER_HOST_BUCKET.acquire(self.domain)
        await self._respect_delay()

        redacted = _KEY_REDACT_RE.sub(r"\1***", url)

        async with self._semaphore:
            start = time.monotonic()
            try:
                resp = await self._client.get(url)
            except httpx.TimeoutException:
                self._logger.warning("timeout", url=redacted[:120])
                return None
            except httpx.HTTPError as exc:
                self._logger.error(
                    "errore HTTP", url=redacted[:120], error=str(exc)
                )
                return None

            elapsed_ms = round((time.monotonic() - start) * 1000, 1)
            body = resp.text

            self._logger.info(
                "fetch completato",
                url=redacted[:120],
                status=resp.status_code,
                elapsed_ms=elapsed_ms,
                body_size=len(body),
            )

            if resp.status_code == 200:
                return body
            if resp.status_code in (403, 429):
                self._logger.warning(
                    "rate/blocked da Steam API",
                    status=resp.status_code,
                    url=redacted[:120],
                )
                return None
            self._logger.error(
                "status inatteso",
                status=resp.status_code,
                url=redacted[:120],
            )
            return None

    # ── Discovery: elenco top guide per un appid ─────────────────────────────

    async def discover_guides(
        self, appid: int, limit: int = _MAX_GUIDES_PER_GAME
    ) -> list[dict[str, Any]]:
        """Ritorna top guide filtrate (EN, views/votes soglia minima).

        Ogni elemento: {publishedfileid, title, views, votes_up, tags,
        appid, detail_url}. `detail_url` è già pronto per `collect()`.
        """
        if not settings.steam_api_key:
            self._logger.warning("STEAM_API_KEY assente, skip discovery")
            return []

        params = {
            "key": settings.steam_api_key,
            "appid": str(appid),
            "filetype": str(_FILETYPE_GUIDE),
            "query_type": str(_QUERY_TYPE_RANKED_BY_TREND),
            "numperpage": str(limit * 2),  # overfetch, filtreremo
            "language": str(_LANG_ENGLISH),
            "return_details": "true",
            "return_tags": "true",
            "return_vote_data": "true",
            "return_short_description": "true",
        }
        qs = "&".join(f"{k}={v}" for k, v in params.items())
        url = f"{_QUERY_URL}?{qs}"

        body = await self.fetch(url)
        if body is None:
            return []

        try:
            data = json.loads(body)
        except (ValueError, json.JSONDecodeError):
            self._logger.warning("Steam QueryFiles: JSON invalido", appid=appid)
            return []

        details = data.get("response", {}).get("publishedfiledetails", [])
        results: list[dict[str, Any]] = []
        for d in details:
            if d.get("result") != 1:
                continue
            pid = d.get("publishedfileid")
            if not pid:
                continue

            views = int(d.get("views", 0) or 0)
            vote_data = d.get("vote_data") or {}
            votes_up = int(vote_data.get("votes_up", 0) or 0)
            if views < _MIN_VIEWS or votes_up < _MIN_VOTES:
                continue

            tags = [
                (t.get("tag") or "").lower() for t in d.get("tags") or []
            ]
            detail_url = (
                f"{_DETAILS_URL}?key={settings.steam_api_key}"
                f"&publishedfileids[0]={pid}"
                f"&includetags=true"
                f"&includevotes=true"
            )
            results.append(
                {
                    "publishedfileid": pid,
                    "title": d.get("title", ""),
                    "views": views,
                    "votes_up": votes_up,
                    "tags": tags,
                    "appid": appid,
                    "detail_url": detail_url,
                }
            )
            if len(results) >= limit:
                break

        self._logger.info(
            "steam discover_guides ok",
            appid=appid,
            returned=len(results),
        )
        return results

    # ── Extract: parsa JSON GetDetails ───────────────────────────────────────

    async def extract(self, html: str, url: str) -> dict | None:
        """Parsa una risposta GetDetails.  `html` qui è JSON text.

        Ritorna dict standard collector o None se filtrato.
        """
        try:
            data = json.loads(html)
        except (ValueError, json.JSONDecodeError):
            self._logger.warning(
                "Steam GetDetails: JSON invalido", url=url[:80]
            )
            return None

        details = data.get("response", {}).get("publishedfiledetails", [])
        if not details:
            return None
        d = details[0]
        if d.get("result") != 1:
            return None

        pid = d.get("publishedfileid")
        if not pid:
            return None

        title = (d.get("title") or "").strip() or "Steam Community Guide"
        body_raw = (
            d.get("file_description") or d.get("description") or ""
        )
        body = _strip_steam_bbcode(body_raw)[:_MAX_CONTENT_CHARS]

        if len(body) < _MIN_CONTENT_CHARS:
            return None

        tags = [
            (t.get("tag") or "").lower() for t in d.get("tags") or []
        ]
        guide_type = _guide_type_from_tags(tags)

        # URL user-facing per attribuzione (non quello API).
        attrib_url = (
            f"https://steamcommunity.com/sharedfiles/filedetails/?id={pid}"
        )

        return {
            "title": title,
            "game_name": None,  # caller (pipeline) popola
            "trophy_name": None,
            "guide_type": guide_type,
            "topic": None,
            "raw_content": body,
            "source_url": attrib_url,
            "source_domain": "steamcommunity.com",
            "content_hash": compute_hash(body),
            "source_type": "community",
            "extra": {
                "steam_publishedfileid": pid,
                "steam_tags": tags,
                "steam_views": int(d.get("views", 0) or 0),
                "steam_votes_up": int(
                    (d.get("vote_data") or {}).get("votes_up", 0) or 0
                ),
            },
        }


# ── Helpers ──────────────────────────────────────────────────────────────────

# BBCode Steam: [h1]..[/h1], [b]..[/b], [url=...]..[/url], [img]..[/img], [list],
# [*], [quote], [noparse], ...
_BBCODE_URL_RE = re.compile(
    r"\[url=[^\]]+\](.*?)\[/url\]", re.DOTALL | re.IGNORECASE
)
_BBCODE_IMG_RE = re.compile(
    r"\[img\][^\[]*\[/img\]", re.IGNORECASE
)
_BBCODE_ANY_RE = re.compile(r"\[/?[a-zA-Z][^\]]*\]")
_MULTISPACE_RE = re.compile(r"[ \t]+")
_MULTILINE_RE = re.compile(r"\n\s*\n\s*\n+")


def _strip_steam_bbcode(text: str) -> str:
    """Rimuove BBCode Steam preservando il testo leggibile."""
    if not text:
        return ""
    # [url=...]label[/url] → label
    text = _BBCODE_URL_RE.sub(r"\1", text)
    # [img]url[/img] → vuoto (l'URL non serve al synthesizer)
    text = _BBCODE_IMG_RE.sub("", text)
    # Tutti gli altri tag generici
    text = _BBCODE_ANY_RE.sub("", text)
    # Normalizza spazi
    text = _MULTISPACE_RE.sub(" ", text)
    text = _MULTILINE_RE.sub("\n\n", text)
    return text.strip()


def _guide_type_from_tags(tags: list[str]) -> str:
    """Mappa tag Steam a guide_type DB. Default 'walkthrough' (sempre in CHECK)."""
    for t in tags:
        if t in _TAG_TO_GUIDE_TYPE:
            return _TAG_TO_GUIDE_TYPE[t]
    return "walkthrough"


# ruff: unused import shim (asyncio garantito presente per eventuali estensioni)
_ = asyncio

"""YouTubeCollector — guide video via YouTube Data API v3 + transcript.

Architettura
------------
Non usa `collect(url)` come flusso primario. Il flusso è:
  1. `search_videos(query, limit)` → lista video candidati (YouTube Data API search.list)
  2. `_get_video_details(ids)` → view count + duration (YouTube Data API videos.list)
  3. `get_transcript(video_id)` → testo del transcript (youtube-transcript-api, sync→thread)
  4. `extract(transcript_text, url)` → dict standard per pipeline._inject_synthetic

Il metodo `collect(url)` è comunque implementato per supportare seed file con URL YouTube
diretti (formato: youtube.com/watch?v=VIDEO_ID).

Quota YouTube Data API v3
--------------------------
- search.list  = 100 units/call
- videos.list  = 1 unit/call (indipendentemente dal numero di ID)
Limite giornaliero default: 8000 units (settings.daily_youtube_quota_limit).
Tracking in-process: si azzera a ogni restart del processo harvester.
Se la quota è esaurita, `search_videos` ritorna lista vuota con warning.

Sicurezza
---------
`YOUTUBE_API_KEY` compare nella query string. Override di `fetch()` redige la
chiave prima del logging (stesso pattern SteamCommunityGuidesCollector).

Compliance
----------
I transcript auto-generati sono parte del contenuto pubblico del video (stessa
visibilità del video stesso). Uso transformativo via LLM synthesizer +
attribuzione a youtube.com/watch?v=VIDEO_ID. Compatibile con YouTube ToS §III-E
(vietato scaricare video, non vietato accedere ai metadati/testi).
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

_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search"
_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos"

# ── Filtri qualità ───────────────────────────────────────────────────────────

_MIN_VIEW_COUNT = 10_000
_MIN_DURATION_SECONDS = 300  # 5 minuti
_MIN_TRANSCRIPT_CHARS = 500
_MAX_TRANSCRIPT_CHARS = 15_000

# ── Quota YouTube Data API v3 ────────────────────────────────────────────────

_QUOTA_SEARCH = 100   # units per search.list call
_QUOTA_VIDEOS = 1     # units per videos.list call (qualsiasi numero di ID)

# ── Regex ────────────────────────────────────────────────────────────────────

# Redige key= nei log
_KEY_REDACT_RE = re.compile(r"(key=)[^&\s]+")

# Estrae video_id da URL YouTube (youtube.com/watch?v=X o youtu.be/X)
_VIDEO_ID_RE = re.compile(
    r"(?:youtube\.com/watch\?(?:[^&]*&)*v=|youtu\.be/)([a-zA-Z0-9_-]{11})"
)

# Parsing durata ISO 8601 (PT4M13S, PT1H2M3S, PT30S).
# Il prefisso PT è obbligatorio per distinguere da match vuoti.
_DURATION_RE = re.compile(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?")


def _parse_duration(iso: str) -> int:
    """Converte durata ISO 8601 in secondi totali. Es: 'PT4M13S' → 253."""
    m = _DURATION_RE.search(iso or "")
    if not m or not any(m.groups()):
        return 0
    h, mn, s = (int(x or 0) for x in m.groups())
    return h * 3600 + mn * 60 + s


class YouTubeCollector(BaseCollector):
    """Collector per guide video da YouTube via Data API v3 + transcript."""

    domain = "youtube.com"
    reliability_score = 0.65  # transcript auto-generati, qualità variabile
    requires_js = False

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        # Contatore quota in-process. Si azzera al restart.
        self._quota_used: int = 0

    # ── Override fetch per redazione API key nei log ─────────────────────────

    async def fetch(self, url: str) -> str | None:
        """Fetch con redazione di `key=...` nei log."""
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
                self._logger.error("errore HTTP", url=redacted[:120], error=str(exc))
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
            if resp.status_code == 403:
                self._logger.warning(
                    "YouTube API: 403 — quota esaurita o key non valida",
                    url=redacted[:80],
                )
                return None
            if resp.status_code == 429:
                self._logger.warning("YouTube API: 429 rate limit", url=redacted[:80])
                return None
            self._logger.error(
                "status inatteso", status=resp.status_code, url=redacted[:80]
            )
            return None

    # ── Discovery: ricerca video ─────────────────────────────────────────────

    async def search_videos(
        self, query: str, limit: int = 5
    ) -> list[dict[str, Any]]:
        """Cerca video su YouTube e ritorna quelli che passano i filtri qualità.

        Ogni elemento: {video_id, title, channel_title, channel_id,
        view_count, duration_seconds, published_at}.

        Usa 100 + 1 units di quota YouTube.
        """
        if not settings.youtube_api_key:
            self._logger.warning("YOUTUBE_API_KEY assente, skip search")
            return []

        if self._quota_used + _QUOTA_SEARCH + _QUOTA_VIDEOS > settings.daily_youtube_quota_limit:
            self._logger.warning(
                "quota YouTube giornaliera esaurita",
                quota_used=self._quota_used,
                limit=settings.daily_youtube_quota_limit,
            )
            return []

        # ── Step 1: search.list ───────────────────────────────────────────────
        search_params = (
            f"part=snippet"
            f"&type=video"
            f"&q={query.replace(' ', '+')}"
            f"&maxResults={limit * 2}"  # overfetch per filtrare dopo
            f"&relevanceLanguage=en"
            f"&videoEmbeddable=true"
            f"&key={settings.youtube_api_key}"
        )
        body = await self.fetch(f"{_SEARCH_URL}?{search_params}")
        self._quota_used += _QUOTA_SEARCH

        if body is None:
            return []

        try:
            data = json.loads(body)
        except (ValueError, json.JSONDecodeError):
            self._logger.warning("YouTube search: JSON invalido")
            return []

        items = data.get("items") or []
        if not items:
            return []

        # Estrai video ID e snippet base
        candidates: list[dict[str, Any]] = []
        for item in items:
            vid = (item.get("id") or {}).get("videoId")
            snippet = item.get("snippet") or {}
            if not vid:
                continue
            candidates.append(
                {
                    "video_id": vid,
                    "title": snippet.get("title", ""),
                    "channel_title": snippet.get("channelTitle", ""),
                    "channel_id": snippet.get("channelId", ""),
                    "published_at": snippet.get("publishedAt", ""),
                }
            )

        if not candidates:
            return []

        # ── Step 2: videos.list per view count + duration ─────────────────────
        ids_str = ",".join(c["video_id"] for c in candidates)
        videos_params = (
            f"part=contentDetails,statistics"
            f"&id={ids_str}"
            f"&key={settings.youtube_api_key}"
        )
        details_body = await self.fetch(f"{_VIDEOS_URL}?{videos_params}")
        self._quota_used += _QUOTA_VIDEOS

        details_by_id: dict[str, dict] = {}
        if details_body:
            try:
                d = json.loads(details_body)
                for item in d.get("items") or []:
                    vid = item.get("id")
                    if not vid:
                        continue
                    stats = item.get("statistics") or {}
                    cd = item.get("contentDetails") or {}
                    details_by_id[vid] = {
                        "view_count": int(stats.get("viewCount") or 0),
                        "duration_seconds": _parse_duration(
                            cd.get("duration") or ""
                        ),
                    }
            except (ValueError, json.JSONDecodeError):
                self._logger.warning("YouTube videos.list: JSON invalido")

        # ── Step 3: filtri qualità ────────────────────────────────────────────
        results: list[dict[str, Any]] = []
        for c in candidates:
            vid = c["video_id"]
            det = details_by_id.get(vid, {})
            view_count = det.get("view_count", 0)
            duration = det.get("duration_seconds", 0)

            if view_count < _MIN_VIEW_COUNT:
                continue
            if duration < _MIN_DURATION_SECONDS:
                continue

            results.append(
                {
                    **c,
                    "view_count": view_count,
                    "duration_seconds": duration,
                }
            )
            if len(results) >= limit:
                break

        self._logger.info(
            "youtube search_videos ok",
            query=query[:80],
            candidates=len(candidates),
            returned=len(results),
            quota_used=self._quota_used,
        )
        return results

    # ── Transcript ───────────────────────────────────────────────────────────

    async def get_transcript(self, video_id: str) -> str | None:
        """Ritorna il testo del transcript EN, o None se non disponibile.

        youtube-transcript-api è sync → eseguita in thread per non bloccare
        l'event loop (pattern feedback_sync_sdk_in_async.md).
        """
        try:
            from youtube_transcript_api import (  # type: ignore[import-untyped]
                NoTranscriptFound,
                TranscriptsDisabled,
                YouTubeTranscriptApi,
            )
        except ImportError:
            self._logger.error(
                "youtube-transcript-api non installato. "
                "Eseguire: pip install youtube-transcript-api"
            )
            return None

        def _fetch_sync() -> str | None:
            try:
                # v1.x: instance method fetch() invece del vecchio get_transcript()
                fetched = YouTubeTranscriptApi().fetch(
                    video_id, languages=["en", "en-US", "en-GB"]
                )
                return " ".join(seg.text for seg in fetched)
            except (NoTranscriptFound, TranscriptsDisabled):
                return None
            except Exception:
                return None

        try:
            raw = await asyncio.to_thread(_fetch_sync)
        except Exception as exc:
            self._logger.warning(
                "get_transcript fallito",
                video_id=video_id,
                error=str(exc),
            )
            return None

        if not raw:
            return None

        # Normalizza spazi e newline (transcript auto ha \n interni nei segmenti)
        text = re.sub(r"\s+", " ", raw).strip()
        return text if len(text) >= _MIN_TRANSCRIPT_CHARS else None

    # ── collect() override per dispatch diretto da URL ───────────────────────

    async def collect(self, url: str) -> dict | None:  # type: ignore[override]
        """Supporta dispatch da seed file con URL youtube.com/watch?v=VIDEO_ID."""
        m = _VIDEO_ID_RE.search(url)
        if not m:
            self._logger.warning(
                "collect YouTube: impossibile estrarre video_id", url=url[:100]
            )
            return None

        video_id = m.group(1)
        transcript = await self.get_transcript(video_id)
        if transcript is None:
            self._logger.warning(
                "collect YouTube: transcript non disponibile", video_id=video_id
            )
            return None

        attrib_url = f"https://www.youtube.com/watch?v={video_id}"
        return await self.extract(transcript, attrib_url)

    # ── extract() ────────────────────────────────────────────────────────────

    async def extract(  # type: ignore[override]
        self, transcript: str, url: str, extra: dict | None = None
    ) -> dict | None:
        """Parsa transcript + URL e ritorna dict standard collector.

        `extra` opzionale: metadata video (channel_title, view_count, ecc.) da
        includere in `extra` per harvest_sources.metadata.
        """
        if not transcript or len(transcript) < _MIN_TRANSCRIPT_CHARS:
            return None

        # Estrai video_id dall'URL per il content hash stabile
        m = _VIDEO_ID_RE.search(url)
        video_id = m.group(1) if m else url

        body = transcript[:_MAX_TRANSCRIPT_CHARS]

        return {
            "title": _title_from_extra(extra),
            "game_name": None,  # caller (pipeline) popola
            "trophy_name": None,
            "guide_type": "walkthrough",  # pipeline può override
            "topic": None,
            "raw_content": body,
            "source_url": url if "youtube.com" in url else f"https://www.youtube.com/watch?v={video_id}",
            "source_domain": "youtube.com",
            "content_hash": compute_hash(body),
            "source_type": "community",
            "extra": extra or {},
        }


# ── Helpers ──────────────────────────────────────────────────────────────────


def _title_from_extra(extra: dict | None) -> str:
    if not extra:
        return "YouTube Video Guide"
    # Accetta sia "youtube_title" (chiave pipeline) sia "title" (generico).
    title = extra.get("youtube_title") or extra.get("title", "")
    if title:
        return title
    channel = extra.get("youtube_channel_title") or extra.get("channel_title", "")
    if channel:
        return f"YouTube Guide — {channel}"
    return "YouTube Video Guide"

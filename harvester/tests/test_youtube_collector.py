"""Test YouTubeCollector — tutto mockato, zero rete reale, zero API key.

I JSON/transcript sono tutti inventati.
"""

from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.collectors.youtube import (
    YouTubeCollector,
    _parse_duration,
    _title_from_extra,
)


@pytest.fixture
def yt() -> YouTubeCollector:
    return YouTubeCollector(global_semaphore=asyncio.Semaphore(5))


# ── _parse_duration ──────────────────────────────────────────────────────────


def test_parse_duration_minutes_seconds() -> None:
    assert _parse_duration("PT4M13S") == 253


def test_parse_duration_hours() -> None:
    assert _parse_duration("PT1H2M3S") == 3723


def test_parse_duration_seconds_only() -> None:
    assert _parse_duration("PT30S") == 30


def test_parse_duration_empty() -> None:
    assert _parse_duration("") == 0


def test_parse_duration_minutes_only() -> None:
    assert _parse_duration("PT7M") == 420


# ── _title_from_extra ────────────────────────────────────────────────────────


def test_title_from_extra_with_title() -> None:
    result = _title_from_extra({"title": "Elden Ring All Trophies Guide"})
    assert result == "Elden Ring All Trophies Guide"


def test_title_from_extra_channel_fallback() -> None:
    assert "FightinCowboy" in _title_from_extra({"channel_title": "FightinCowboy"})


def test_title_from_extra_none() -> None:
    assert _title_from_extra(None) == "YouTube Video Guide"


# ── extract() ────────────────────────────────────────────────────────────────


def test_extract_valid_transcript(yt: YouTubeCollector) -> None:
    transcript = (
        "Welcome to this guide for the Invented Game trophy. "
        "To unlock this fictional achievement you need to defeat the made-up boss "
        "at least once on any difficulty. "
    ) * 20  # sufficiently long

    result = asyncio.run(
        yt.extract(
            transcript,
            "https://www.youtube.com/watch?v=ABCDE12345F",
            extra={
                "youtube_video_id": "ABCDE12345F",
                "youtube_title": "Invented Game — All Trophies",
                "youtube_channel_title": "FakeChannel",
                "youtube_view_count": 50000,
                "youtube_duration_seconds": 720,
            },
        )
    )
    assert result is not None
    assert result["source_domain"] == "youtube.com"
    assert "ABCDE12345F" in result["source_url"]
    assert result["source_type"] == "community"
    assert result["extra"]["youtube_view_count"] == 50000
    assert result["extra"]["youtube_channel_title"] == "FakeChannel"
    assert result["title"] == "Invented Game — All Trophies"
    assert len(result["content_hash"]) == 64
    assert "fictional achievement" in result["raw_content"]


def test_extract_too_short_returns_none(yt: YouTubeCollector) -> None:
    result = asyncio.run(
        yt.extract("too short", "https://www.youtube.com/watch?v=ABCDE12345F")
    )
    assert result is None


def test_extract_empty_returns_none(yt: YouTubeCollector) -> None:
    result = asyncio.run(yt.extract("", "https://www.youtube.com/watch?v=X"))
    assert result is None


# ── search_videos() — mocked fetch ──────────────────────────────────────────

_SEARCH_RESPONSE = json.dumps(
    {
        "items": [
            {
                "id": {"videoId": "VID001FAKEXX"},
                "snippet": {
                    "title": "Invented Game Full Trophy Guide",
                    "channelTitle": "FakeChannel",
                    "channelId": "UC_fake_001",
                    "publishedAt": "2024-01-15T00:00:00Z",
                },
            },
            {
                "id": {"videoId": "VID002FAKEXX"},
                "snippet": {
                    "title": "Short Clip",
                    "channelTitle": "RandomUser",
                    "channelId": "UC_fake_002",
                    "publishedAt": "2024-03-01T00:00:00Z",
                },
            },
        ]
    }
)

_VIDEOS_RESPONSE = json.dumps(
    {
        "items": [
            {
                "id": "VID001FAKEXX",
                "statistics": {"viewCount": "150000"},
                "contentDetails": {"duration": "PT18M30S"},
            },
            {
                "id": "VID002FAKEXX",
                "statistics": {"viewCount": "500"},  # troppo basso → filtrato
                "contentDetails": {"duration": "PT2M"},  # troppo corto → filtrato
            },
        ]
    }
)


@pytest.mark.asyncio
async def test_search_videos_returns_filtered_results(yt: YouTubeCollector) -> None:
    """search_videos deve filtrare per view count e duration."""
    call_count = 0

    async def _mock_fetch(url: str) -> str:
        nonlocal call_count
        call_count += 1
        if "search" in url:
            return _SEARCH_RESPONSE
        return _VIDEOS_RESPONSE

    with (
        patch.object(yt, "fetch", side_effect=_mock_fetch),
        patch("src.collectors.youtube.settings") as mock_settings,
    ):
        mock_settings.youtube_api_key = "FAKE_KEY_TEST"
        mock_settings.daily_youtube_quota_limit = 8000

        results = await yt.search_videos("Invented Game trophy guide", limit=5)

    # Solo VID001 passa i filtri (views ≥ 10k, duration ≥ 300s)
    assert len(results) == 1
    assert results[0]["video_id"] == "VID001FAKEXX"
    assert results[0]["view_count"] == 150_000
    assert results[0]["duration_seconds"] == 1110  # 18*60+30


@pytest.mark.asyncio
async def test_search_videos_returns_empty_when_no_key(yt: YouTubeCollector) -> None:
    with patch("src.collectors.youtube.settings") as mock_settings:
        mock_settings.youtube_api_key = ""
        mock_settings.daily_youtube_quota_limit = 8000
        results = await yt.search_videos("any query")
    assert results == []


@pytest.mark.asyncio
async def test_search_videos_returns_empty_when_quota_exceeded(yt: YouTubeCollector) -> None:
    yt._quota_used = 8000  # già al limite
    with patch("src.collectors.youtube.settings") as mock_settings:
        mock_settings.youtube_api_key = "FAKE_KEY"
        mock_settings.daily_youtube_quota_limit = 8000
        results = await yt.search_videos("any query")
    assert results == []


# ── get_transcript() — mocked youtube-transcript-api ────────────────────────


@pytest.mark.asyncio
async def test_get_transcript_returns_text(yt: YouTubeCollector) -> None:
    # v1.x: i segmenti hanno attributo .text (non dict)
    def _seg(t: str) -> MagicMock:
        s = MagicMock()
        s.text = t
        return s

    mock_segments = [
        _seg("Welcome to the guide."),
        _seg("Today we cover the invented trophy."),
    ] * 50  # rende il testo lungo a sufficienza

    # v1.x: YouTubeTranscriptApi() è istanza con .fetch()
    mock_instance = MagicMock()
    mock_instance.fetch.return_value = mock_segments
    mock_yta_class = MagicMock(return_value=mock_instance)

    with patch.dict(
        "sys.modules",
        {
            "youtube_transcript_api": MagicMock(
                YouTubeTranscriptApi=mock_yta_class,
                NoTranscriptFound=Exception,
                TranscriptsDisabled=Exception,
            )
        },
    ):
        result = await yt.get_transcript("ABCDE12345F")

    assert result is not None
    assert "invented trophy" in result


@pytest.mark.asyncio
async def test_get_transcript_returns_none_when_disabled(yt: YouTubeCollector) -> None:
    class _NoTranscriptError(Exception):
        pass

    mock_module = MagicMock()
    mock_module.NoTranscriptFound = _NoTranscriptError
    mock_module.TranscriptsDisabled = _NoTranscriptError
    mock_module.YouTubeTranscriptApi.get_transcript.side_effect = _NoTranscriptError()

    with patch.dict("sys.modules", {"youtube_transcript_api": mock_module}):
        result = await yt.get_transcript("DISABLED_VID")

    assert result is None


# ── collect() url dispatch ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_collect_extracts_video_id_from_url(yt: YouTubeCollector) -> None:
    long_transcript = "Trophy guide content for the invented game. " * 30

    with (
        patch.object(yt, "get_transcript", new=AsyncMock(return_value=long_transcript)),
    ):
        result = await yt.collect("https://www.youtube.com/watch?v=ABCDE12345F")

    assert result is not None
    assert "ABCDE12345F" in result["source_url"]
    assert result["source_type"] == "community"


@pytest.mark.asyncio
async def test_collect_invalid_url_returns_none(yt: YouTubeCollector) -> None:
    result = await yt.collect("https://www.youtube.com/channel/UC_fake")
    assert result is None

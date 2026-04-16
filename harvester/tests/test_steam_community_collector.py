"""Test SteamCommunityGuidesCollector — JSON inventato, zero rete reale."""

from __future__ import annotations

import asyncio
import json

import pytest

from src.collectors.steam_community import (
    _KEY_REDACT_RE,
    SteamCommunityGuidesCollector,
    _guide_type_from_tags,
    _strip_steam_bbcode,
)


@pytest.fixture
def steam() -> SteamCommunityGuidesCollector:
    return SteamCommunityGuidesCollector(global_semaphore=asyncio.Semaphore(5))


# ── BBCode stripping ─────────────────────────────────────────────────────────


def test_strip_bbcode_url_keeps_label() -> None:
    out = _strip_steam_bbcode("see [url=https://example.com]this guide[/url] now")
    assert "this guide" in out
    assert "https://example.com" not in out
    assert "[url" not in out


def test_strip_bbcode_img_removes_entirely() -> None:
    out = _strip_steam_bbcode("text [img]http://fake.png[/img] more")
    assert "fake.png" not in out
    assert "[img" not in out
    assert "text" in out and "more" in out


def test_strip_bbcode_generic_tags() -> None:
    out = _strip_steam_bbcode("[h1]Title[/h1]\n[b]bold[/b] and [i]italic[/i]")
    assert "Title" in out
    assert "bold" in out and "italic" in out
    assert "[" not in out and "]" not in out


def test_strip_bbcode_empty() -> None:
    assert _strip_steam_bbcode("") == ""


# ── Tag → guide_type ─────────────────────────────────────────────────────────


def test_guide_type_walkthrough() -> None:
    assert _guide_type_from_tags(["walkthrough", "english"]) == "walkthrough"


def test_guide_type_achievements_to_trophy() -> None:
    assert _guide_type_from_tags(["achievements"]) == "trophy"


def test_guide_type_strategy_to_meta() -> None:
    assert _guide_type_from_tags(["strategy"]) == "meta"


def test_guide_type_default_walkthrough() -> None:
    assert _guide_type_from_tags(["unknown_tag_xyz"]) == "walkthrough"
    assert _guide_type_from_tags([]) == "walkthrough"


# ── Key redaction regex ──────────────────────────────────────────────────────


def test_key_redact_regex() -> None:
    url = "https://api.steampowered.com/x?key=ABC123SECRET&appid=1"
    redacted = _KEY_REDACT_RE.sub(r"\1***", url)
    assert "ABC123SECRET" not in redacted
    assert "key=***" in redacted
    assert "appid=1" in redacted


# ── extract() ────────────────────────────────────────────────────────────────


def _details_payload(
    body_text: str = "x" * 500,
    tags: list[str] | None = None,
    views: int = 1000,
    votes_up: int = 50,
    pid: str = "111222333",
    result: int = 1,
) -> str:
    return json.dumps(
        {
            "response": {
                "publishedfiledetails": [
                    {
                        "result": result,
                        "publishedfileid": pid,
                        "title": "Made-Up Build Guide",
                        "file_description": body_text,
                        "views": views,
                        "vote_data": {"votes_up": votes_up},
                        "tags": [{"tag": t} for t in (tags or ["strategy"])],
                    }
                ]
            }
        }
    )


def test_extract_valid_guide(steam: SteamCommunityGuidesCollector) -> None:
    body = (
        "[h1]Build Guide[/h1]\n"
        "Use the [b]Invented Sword[/b] for max DPS. "
        + ("Filler. " * 100)
    )
    payload = _details_payload(body_text=body, tags=["strategy"])
    result = asyncio.run(
        steam.extract(payload, "https://api.steampowered.com/x?key=K&publishedfileids[0]=111")
    )
    assert result is not None
    assert result["title"] == "Made-Up Build Guide"
    assert result["guide_type"] == "meta"  # "strategy" → meta
    assert result["source_domain"] == "steamcommunity.com"
    assert "steamcommunity.com/sharedfiles/filedetails/?id=111222333" in result["source_url"]
    assert "[h1]" not in result["raw_content"]
    assert "Invented Sword" in result["raw_content"]
    assert result["extra"]["steam_publishedfileid"] == "111222333"
    assert result["extra"]["steam_views"] == 1000
    assert len(result["content_hash"]) == 64


def test_extract_too_short_returns_none(steam: SteamCommunityGuidesCollector) -> None:
    payload = _details_payload(body_text="too short")
    result = asyncio.run(steam.extract(payload, "https://x"))
    assert result is None


def test_extract_invalid_json_returns_none(steam: SteamCommunityGuidesCollector) -> None:
    result = asyncio.run(steam.extract("not json {{", "https://x"))
    assert result is None


def test_extract_result_not_ok_returns_none(steam: SteamCommunityGuidesCollector) -> None:
    payload = _details_payload(result=9)  # non-1 = errore Steam
    result = asyncio.run(steam.extract(payload, "https://x"))
    assert result is None


def test_extract_empty_response_returns_none(steam: SteamCommunityGuidesCollector) -> None:
    payload = json.dumps({"response": {"publishedfiledetails": []}})
    result = asyncio.run(steam.extract(payload, "https://x"))
    assert result is None

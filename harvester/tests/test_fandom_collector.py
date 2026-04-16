"""Test FandomCollector — tutto mockato, zero rete reale.

Copre: HTML stripping, guide_type inference, extract, fetch_page, search_wiki,
collect URL dispatch.
"""

from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock, patch

import pytest

from src.collectors.fandom import (
    FandomCollector,
    _infer_guide_type,
    _strip_html,
)


@pytest.fixture
def fandom() -> FandomCollector:
    return FandomCollector(global_semaphore=asyncio.Semaphore(5))


# ── _strip_html ──────────────────────────────────────────────────────────────


def test_strip_html_removes_tags() -> None:
    raw = "<p>Hello <strong>world</strong></p>"
    assert _strip_html(raw) == "Hello world"


def test_strip_html_decodes_entities() -> None:
    raw = "<p>Sword &amp; Shield</p>"
    result = _strip_html(raw)
    assert "Sword & Shield" in result


def test_strip_html_collapses_whitespace() -> None:
    raw = "<p>a</p>   <p>b</p>"
    result = _strip_html(raw)
    assert "  " not in result


def test_strip_html_empty() -> None:
    assert _strip_html("") == ""


# ── _infer_guide_type ────────────────────────────────────────────────────────


def test_infer_guide_type_boss_from_category() -> None:
    assert _infer_guide_type(["Bosses", "Enemies"]) == "boss"


def test_infer_guide_type_lore_from_category() -> None:
    assert _infer_guide_type(["Lore", "Story"]) == "lore"


def test_infer_guide_type_build_from_category() -> None:
    assert _infer_guide_type(["Builds", "Classes"]) == "build"


def test_infer_guide_type_collectible_from_category() -> None:
    assert _infer_guide_type(["Weapons", "Items"]) == "collectible"


def test_infer_guide_type_trophy_from_category() -> None:
    assert _infer_guide_type(["Trophies", "Achievements"]) == "trophy_guide"


def test_infer_guide_type_walkthrough_from_title() -> None:
    assert _infer_guide_type([], title="Complete Game Walkthrough") == "walkthrough"


def test_infer_guide_type_default_when_no_match() -> None:
    assert _infer_guide_type([], title="Random Page") == "walkthrough"


def test_infer_guide_type_boss_from_title() -> None:
    assert _infer_guide_type([], title="Malenia, Blade of Miquella Boss Fight") == "boss"


# ── extract() ────────────────────────────────────────────────────────────────


_LONG_HTML = (
    "<p>Malenia is one of the most challenging bosses in Elden Ring. "
    "She has two phases and heals on every hit. "
    "The recommended strategy is to use a fast weapon and dodge her attacks. "
    "Bring Scarlet Rot resistance and use Bloodhound's Step for phase two. </p>"
) * 5  # >300 chars


def test_extract_valid(fandom: FandomCollector) -> None:
    result = asyncio.run(
        fandom.extract(
            _LONG_HTML,
            "https://eldenring.fandom.com/wiki/Malenia",
            categories=["Bosses", "Enemies"],
            page_title="Malenia",
        )
    )
    assert result is not None
    assert result["guide_type"] == "boss"
    assert result["topic"] == "Malenia"
    assert result["source_domain"] == "eldenring.fandom.com"
    assert result["source_type"] == "supplementary"
    assert len(result["content_hash"]) == 64
    assert "eldenring.fandom.com" in result["source_url"]
    assert result["extra"]["fandom_page_title"] == "Malenia"
    assert "Bosses" in result["extra"]["fandom_categories"]


def test_extract_too_short_returns_none(fandom: FandomCollector) -> None:
    result = asyncio.run(
        fandom.extract(
            "<p>Short text.</p>",
            "https://eldenring.fandom.com/wiki/Test",
        )
    )
    assert result is None


def test_extract_empty_returns_none(fandom: FandomCollector) -> None:
    result = asyncio.run(fandom.extract("", "https://test.fandom.com/wiki/X"))
    assert result is None


def test_extract_topic_none_when_no_title(fandom: FandomCollector) -> None:
    result = asyncio.run(
        fandom.extract(_LONG_HTML, "https://test.fandom.com/wiki/X", page_title="")
    )
    assert result is not None
    assert result["topic"] is None


# ── fetch_page() — mocked ────────────────────────────────────────────────────

_PARSE_RESPONSE = json.dumps(
    {
        "parse": {
            "title": "Malenia",
            "text": {"*": _LONG_HTML},
            "categories": [{"*": "Bosses"}, {"*": "Enemies"}],
        }
    }
)

_PARSE_ERROR_RESPONSE = json.dumps(
    {"error": {"code": "missingtitle", "info": "The page you requested doesn't exist"}}
)


@pytest.mark.asyncio
async def test_fetch_page_returns_data(fandom: FandomCollector) -> None:
    with patch.object(fandom, "fetch", new=AsyncMock(return_value=_PARSE_RESPONSE)):
        result = await fandom.fetch_page("eldenring", "Malenia")

    assert result is not None
    assert result["page_title"] == "Malenia"
    assert "Bosses" in result["categories"]
    assert "eldenring.fandom.com" in result["page_url"]
    assert len(result["html_text"]) > 0


@pytest.mark.asyncio
async def test_fetch_page_returns_none_on_api_error(fandom: FandomCollector) -> None:
    with patch.object(fandom, "fetch", new=AsyncMock(return_value=_PARSE_ERROR_RESPONSE)):
        result = await fandom.fetch_page("eldenring", "NonExistentPage")
    assert result is None


@pytest.mark.asyncio
async def test_fetch_page_returns_none_on_fetch_failure(fandom: FandomCollector) -> None:
    with patch.object(fandom, "fetch", new=AsyncMock(return_value=None)):
        result = await fandom.fetch_page("eldenring", "Malenia")
    assert result is None


@pytest.mark.asyncio
async def test_fetch_page_returns_none_on_invalid_json(fandom: FandomCollector) -> None:
    with patch.object(fandom, "fetch", new=AsyncMock(return_value="not json{")):
        result = await fandom.fetch_page("eldenring", "Malenia")
    assert result is None


# ── search_wiki() — mocked ───────────────────────────────────────────────────

_SEARCH_RESPONSE = json.dumps(
    {
        "query": {
            "search": [
                {"title": "Malenia"},
                {"title": "Malenia/Strategies"},
                {"title": "Bosses"},
            ]
        }
    }
)


@pytest.mark.asyncio
async def test_search_wiki_returns_titles(fandom: FandomCollector) -> None:
    with patch.object(fandom, "fetch", new=AsyncMock(return_value=_SEARCH_RESPONSE)):
        titles = await fandom.search_wiki("eldenring", "Malenia boss guide", limit=3)

    assert "Malenia" in titles
    assert len(titles) == 3


@pytest.mark.asyncio
async def test_search_wiki_returns_empty_on_failure(fandom: FandomCollector) -> None:
    with patch.object(fandom, "fetch", new=AsyncMock(return_value=None)):
        titles = await fandom.search_wiki("eldenring", "query")
    assert titles == []


@pytest.mark.asyncio
async def test_search_wiki_returns_empty_on_invalid_json(fandom: FandomCollector) -> None:
    with patch.object(fandom, "fetch", new=AsyncMock(return_value="bad json")):
        titles = await fandom.search_wiki("eldenring", "query")
    assert titles == []


# ── collect() URL dispatch ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_collect_valid_url(fandom: FandomCollector) -> None:
    page_data = {
        "html_text": _LONG_HTML,
        "categories": ["Bosses"],
        "page_url": "https://eldenring.fandom.com/wiki/Malenia",
        "page_title": "Malenia",
    }
    with patch.object(fandom, "fetch_page", new=AsyncMock(return_value=page_data)):
        result = await fandom.collect("https://eldenring.fandom.com/wiki/Malenia")

    assert result is not None
    assert result["guide_type"] == "boss"
    assert result["topic"] == "Malenia"
    assert result["source_type"] == "supplementary"


@pytest.mark.asyncio
async def test_collect_invalid_url_returns_none(fandom: FandomCollector) -> None:
    result = await fandom.collect("https://www.google.com/search?q=elden+ring")
    assert result is None


@pytest.mark.asyncio
async def test_collect_fetch_page_failure_returns_none(fandom: FandomCollector) -> None:
    with patch.object(fandom, "fetch_page", new=AsyncMock(return_value=None)):
        result = await fandom.collect("https://eldenring.fandom.com/wiki/Malenia")
    assert result is None

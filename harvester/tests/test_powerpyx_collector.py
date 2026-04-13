"""Test per PowerPyxCollector — extract, URL slug parsing, pulizia HTML."""

from __future__ import annotations

import asyncio

import pytest

from src.collectors.base import compute_hash
from src.collectors.powerpyx import PowerPyxCollector

# ── Fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture
def collector() -> PowerPyxCollector:
    return PowerPyxCollector(global_semaphore=asyncio.Semaphore(5))


# HTML di esempio realistico ma inventato.
_VALID_HTML = """
<!DOCTYPE html>
<html>
<head>
    <title>Elden Ring Trophy Guide - PowerPyx</title>
    <style>.x { color: red; }</style>
    <script>alert('tracker');</script>
</head>
<body>
    <nav><a href="/">Home</a><a href="/guides">Guides</a></nav>
    <aside class="sidebar">Sidebar ads</aside>
    <article>
        <div class="entry-content">
            <h1>Elden Ring Trophy Guide & Roadmap</h1>
            <p>Welcome to the complete trophy guide for Elden Ring. This guide
            will walk you through every trophy needed for the platinum.</p>
            <h2>Step 1: Play through the game</h2>
            <p>Explore the Lands Between and defeat all main bosses. Make sure
            to collect all Great Runes along the way. There are multiple endings
            so plan your route carefully before committing to one.</p>
            <h2>Step 2: Missable trophies</h2>
            <p>Some NPC quests are missable. Follow a checklist to avoid
            having to do a second playthrough for trophies like Volcano Manor
            questline and Ranni's quest.</p>
            <script>trackPageView();</script>
        </div>
        <div class="comments">
            <p>User comment that should be removed</p>
        </div>
    </article>
    <footer>Copyright PowerPyx</footer>
</body>
</html>
"""

_EMPTY_HTML = """
<!DOCTYPE html>
<html>
<head><title>404</title></head>
<body>
    <article>
        <div class="entry-content">
            <p>Hi.</p>
        </div>
    </article>
</body>
</html>
"""


# ── Test extract ─────────────────────────────────────────────────────────────


class TestExtract:
    @pytest.mark.asyncio
    async def test_valid_html_returns_full_dict(
        self, collector: PowerPyxCollector
    ) -> None:
        """HTML valido → dict con tutti i campi richiesti."""
        result = await collector.extract(
            _VALID_HTML, "https://powerpyx.com/elden-ring-trophy-guide/"
        )
        assert result is not None
        assert set(result.keys()) == {
            "title",
            "game_name",
            "trophy_name",
            "guide_type",
            "raw_content",
            "source_url",
            "source_domain",
            "content_hash",
        }
        assert "Elden Ring" in result["title"]
        assert result["source_domain"] == "powerpyx.com"
        assert result["guide_type"] == "walkthrough"
        assert len(result["content_hash"]) == 64
        assert len(result["raw_content"]) >= 200

    @pytest.mark.asyncio
    async def test_empty_content_returns_none(
        self, collector: PowerPyxCollector
    ) -> None:
        """HTML con contenuto < 200 char → None."""
        result = await collector.extract(
            _EMPTY_HTML, "https://powerpyx.com/whatever/"
        )
        assert result is None

    @pytest.mark.asyncio
    async def test_game_name_from_url(self, collector: PowerPyxCollector) -> None:
        """game_name estratto correttamente dallo slug URL."""
        result = await collector.extract(
            _VALID_HTML, "https://powerpyx.com/elden-ring-trophy-guide/"
        )
        assert result is not None
        assert result["game_name"] == "Elden Ring"

    @pytest.mark.asyncio
    async def test_script_style_nav_removed(
        self, collector: PowerPyxCollector
    ) -> None:
        """I tag script, style, nav non devono comparire nel raw_content."""
        result = await collector.extract(
            _VALID_HTML, "https://powerpyx.com/elden-ring-trophy-guide/"
        )
        assert result is not None
        content = result["raw_content"]
        assert "alert(" not in content
        assert "trackPageView" not in content
        assert "color: red" not in content
        assert "Sidebar ads" not in content
        assert "User comment that should be removed" not in content
        assert "Copyright PowerPyx" not in content

    @pytest.mark.asyncio
    async def test_content_hash_deterministic(
        self, collector: PowerPyxCollector
    ) -> None:
        """Stesso input HTML+URL → stesso content_hash."""
        url = "https://powerpyx.com/elden-ring-trophy-guide/"
        r1 = await collector.extract(_VALID_HTML, url)
        r2 = await collector.extract(_VALID_HTML, url)
        assert r1 is not None and r2 is not None
        assert r1["content_hash"] == r2["content_hash"]
        # Coerenza con compute_hash sul raw_content.
        assert r1["content_hash"] == compute_hash(r1["raw_content"])

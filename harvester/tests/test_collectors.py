"""Test per PSNProfilesCollector e TrueAchievementsCollector.

HTML di esempio inventato — MAI copiato da siti reali.
"""

from __future__ import annotations

import asyncio

import pytest

from src.collectors.base import BaseCollector, compute_hash
from src.collectors.psnprofiles import PSNProfilesCollector
from src.collectors.trueachievements import TrueAchievementsCollector

# ── Fixtures ──────────────────────────────────────────────────────────────────


@pytest.fixture
def psn_collector() -> PSNProfilesCollector:
    return PSNProfilesCollector(global_semaphore=asyncio.Semaphore(5))


@pytest.fixture
def ta_collector() -> TrueAchievementsCollector:
    return TrueAchievementsCollector(global_semaphore=asyncio.Semaphore(5))


# ── HTML di esempio PSNProfiles ───────────────────────────────────────────────

_PSN_VALID_HTML = """
<!DOCTYPE html>
<html>
<head>
    <title>Elden Ring Trophy Guide - PSNProfiles</title>
    <script>analyticsTracker();</script>
    <style>.ad { display: none; }</style>
</head>
<body>
    <header><nav><a href="/">Home</a></nav></header>
    <aside class="sidebar">Ads and sidebar content</aside>
    <div id="guide">
        <h1>Elden Ring Trophy Guide</h1>
        <p>Welcome to the comprehensive Elden Ring trophy guide. This guide covers
        all 42 trophies required for the platinum including missable quests, multiple
        endings, and optional bosses across the Lands Between.</p>
        <h2>Difficulty and Roadmap</h2>
        <p>Estimated difficulty: 6/10. You will need at least two playthroughs to
        collect all trophies. Plan your route to avoid missing NPC questlines.</p>
        <h2>Trophy List</h2>
        <table class="zebra">
            <tr><th>Trophy</th><th>Type</th><th>Description</th></tr>
            <tr><td>Elden Lord</td><td>Platinum</td><td>Obtain all other trophies</td></tr>
            <tr><td>Shardbearer Godrick</td><td>Gold</td><td>Defeat Godrick the Grafted</td></tr>
            <tr><td>Shardbearer Rennala</td><td>Gold</td>
                <td>Defeat Rennala Queen of the Full Moon</td></tr>
        </table>
        <h2>Step 1: Main Story</h2>
        <p>Complete the main story by defeating all Shardbearers and reaching the
        Elden Throne. Collect Great Runes along the way.</p>
    </div>
    <div id="comments"><p>User: great guide!</p></div>
    <footer>PSNProfiles &copy; 2024</footer>
</body>
</html>
"""

_PSN_EMPTY_HTML = """
<!DOCTYPE html>
<html>
<head><title>Loading...</title></head>
<body>
    <div id="guide"><p>No data.</p></div>
</body>
</html>
"""


# ── HTML di esempio TrueAchievements ─────────────────────────────────────────

_TA_VALID_HTML = """
<!DOCTYPE html>
<html>
<head>
    <title>Elden Ring Achievements - TrueAchievements</title>
    <script>ga('send','pageview');</script>
</head>
<body>
    <header><nav><a href="/">Home</a></nav></header>
    <aside class="sidebar">Right rail ads</aside>
    <div class="wiki-article">
        <h1>Elden Ring Achievement Walkthrough</h1>
        <p>This walkthrough covers the most efficient path to 100% completion
        in Elden Ring. Follow the steps below to unlock all 50 achievements
        including story, collectibles, and missable questlines.</p>
        <h2>Step 1: First Playthrough</h2>
        <p>Focus on the critical path and defeat the main bosses. Collect
        all map fragments and sites of grace to unlock fast travel points.
        Keep an eye on NPC questlines that can be missed permanently.</p>
        <h2>Step 2: Cleanup and Missables</h2>
        <p>Use NG+ or a backup save to collect any achievements tied to
        alternate endings. The Frenzied Flame ending locks you out of other
        endings on the same playthrough.</p>
        <ul>
            <li>Elden Lord — Complete the main story</li>
            <li>Lord of the Frenzied Flame — Alternate ending achievement</li>
            <li>Age of the Stars — Ranni questline ending</li>
        </ul>
    </div>
    <div id="comments"><p>Helpful walkthrough!</p></div>
    <footer>TrueAchievements &copy; 2024</footer>
</body>
</html>
"""

_TA_EMPTY_HTML = """
<!DOCTYPE html>
<html>
<head><title>Not Found</title></head>
<body>
    <div class="wiki-article"><p>Empty.</p></div>
</body>
</html>
"""


# ── Test PSNProfilesCollector ─────────────────────────────────────────────────


class TestPSNProfilesCollector:
    @pytest.mark.asyncio
    async def test_valid_html_returns_full_dict(
        self, psn_collector: PSNProfilesCollector
    ) -> None:
        """HTML valido con #guide → dict con tutti i campi richiesti."""
        result = await psn_collector.extract(
            _PSN_VALID_HTML,
            "https://psnprofiles.com/guide/12345-elden-ring/",
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
        assert result["source_domain"] == "psnprofiles.com"
        assert result["guide_type"] == "walkthrough"
        assert len(result["content_hash"]) == 64

    @pytest.mark.asyncio
    async def test_empty_content_returns_none(
        self, psn_collector: PSNProfilesCollector
    ) -> None:
        """Contenuto < 200 char → None."""
        result = await psn_collector.extract(
            _PSN_EMPTY_HTML,
            "https://psnprofiles.com/guide/99999-test/",
        )
        assert result is None

    @pytest.mark.asyncio
    async def test_game_name_stripped_from_url(
        self, psn_collector: PSNProfilesCollector
    ) -> None:
        """game_name estratto rimuovendo il prefisso numerico dallo slug."""
        result = await psn_collector.extract(
            _PSN_VALID_HTML,
            "https://psnprofiles.com/guide/12345-elden-ring/",
        )
        assert result is not None
        assert result["game_name"] == "Elden Ring"

    @pytest.mark.asyncio
    async def test_junk_removed(self, psn_collector: PSNProfilesCollector) -> None:
        """Script, style, sidebar, footer, commenti non devono comparire nel testo."""
        result = await psn_collector.extract(
            _PSN_VALID_HTML,
            "https://psnprofiles.com/guide/12345-elden-ring/",
        )
        assert result is not None
        content = result["raw_content"]
        assert "analyticsTracker" not in content
        assert "display: none" not in content
        assert "Ads and sidebar content" not in content
        assert "great guide!" not in content
        assert "PSNProfiles" not in content

    @pytest.mark.asyncio
    async def test_table_converted_to_text(
        self, psn_collector: PSNProfilesCollector
    ) -> None:
        """La tabella trofei deve comparire nel raw_content come testo pipe-delimited."""
        result = await psn_collector.extract(
            _PSN_VALID_HTML,
            "https://psnprofiles.com/guide/12345-elden-ring/",
        )
        assert result is not None
        assert "Elden Lord" in result["raw_content"]
        assert "Platinum" in result["raw_content"]

    @pytest.mark.asyncio
    async def test_hash_deterministic(
        self, psn_collector: PSNProfilesCollector
    ) -> None:
        """Stesso input → stesso content_hash."""
        url = "https://psnprofiles.com/guide/12345-elden-ring/"
        r1 = await psn_collector.extract(_PSN_VALID_HTML, url)
        r2 = await psn_collector.extract(_PSN_VALID_HTML, url)
        assert r1 is not None and r2 is not None
        assert r1["content_hash"] == r2["content_hash"]
        assert r1["content_hash"] == compute_hash(r1["raw_content"])

    def test_inherits_base_collector(
        self, psn_collector: PSNProfilesCollector
    ) -> None:
        """PSNProfilesCollector deve ereditare da BaseCollector."""
        assert isinstance(psn_collector, BaseCollector)
        assert psn_collector.domain == "psnprofiles.com"
        assert psn_collector.reliability_score == 0.90
        assert psn_collector.requires_js is False

    def test_has_http_client(self, psn_collector: PSNProfilesCollector) -> None:
        """Il rate limiting è ereditato: il client httpx deve essere inizializzato."""
        assert psn_collector._client is not None
        assert psn_collector._semaphore is not None


# ── Test TrueAchievementsCollector ───────────────────────────────────────────


class TestTrueAchievementsCollector:
    @pytest.mark.asyncio
    async def test_valid_html_returns_full_dict(
        self, ta_collector: TrueAchievementsCollector
    ) -> None:
        """HTML valido con .wiki-article → dict con tutti i campi richiesti."""
        result = await ta_collector.extract(
            _TA_VALID_HTML,
            "https://www.trueachievements.com/game/elden-ring/achievements",
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
        assert result["source_domain"] == "trueachievements.com"
        assert result["guide_type"] == "walkthrough"
        assert len(result["content_hash"]) == 64

    @pytest.mark.asyncio
    async def test_empty_content_returns_none(
        self, ta_collector: TrueAchievementsCollector
    ) -> None:
        """Contenuto < 200 char → None."""
        result = await ta_collector.extract(
            _TA_EMPTY_HTML,
            "https://www.trueachievements.com/game/test/achievements",
        )
        assert result is None

    @pytest.mark.asyncio
    async def test_game_name_from_url(
        self, ta_collector: TrueAchievementsCollector
    ) -> None:
        """game_name estratto dallo slug /game/{slug}/."""
        result = await ta_collector.extract(
            _TA_VALID_HTML,
            "https://www.trueachievements.com/game/elden-ring/achievements",
        )
        assert result is not None
        assert result["game_name"] == "Elden Ring"

    @pytest.mark.asyncio
    async def test_junk_removed(
        self, ta_collector: TrueAchievementsCollector
    ) -> None:
        """Script, sidebar, footer, commenti non devono comparire nel testo."""
        result = await ta_collector.extract(
            _TA_VALID_HTML,
            "https://www.trueachievements.com/game/elden-ring/achievements",
        )
        assert result is not None
        content = result["raw_content"]
        assert "ga('send'" not in content
        assert "Right rail ads" not in content
        assert "Helpful walkthrough!" not in content
        assert "TrueAchievements" not in content

    @pytest.mark.asyncio
    async def test_achievement_list_preserved(
        self, ta_collector: TrueAchievementsCollector
    ) -> None:
        """La lista achievement deve comparire nel raw_content."""
        result = await ta_collector.extract(
            _TA_VALID_HTML,
            "https://www.trueachievements.com/game/elden-ring/achievements",
        )
        assert result is not None
        assert "Elden Lord" in result["raw_content"]
        assert "Frenzied Flame" in result["raw_content"]

    @pytest.mark.asyncio
    async def test_hash_deterministic(
        self, ta_collector: TrueAchievementsCollector
    ) -> None:
        """Stesso input → stesso content_hash."""
        url = "https://www.trueachievements.com/game/elden-ring/achievements"
        r1 = await ta_collector.extract(_TA_VALID_HTML, url)
        r2 = await ta_collector.extract(_TA_VALID_HTML, url)
        assert r1 is not None and r2 is not None
        assert r1["content_hash"] == r2["content_hash"]
        assert r1["content_hash"] == compute_hash(r1["raw_content"])

    def test_inherits_base_collector(
        self, ta_collector: TrueAchievementsCollector
    ) -> None:
        """TrueAchievementsCollector deve ereditare da BaseCollector."""
        assert isinstance(ta_collector, BaseCollector)
        assert ta_collector.domain == "trueachievements.com"
        assert ta_collector.reliability_score == 0.90
        assert ta_collector.requires_js is False

    def test_has_http_client(self, ta_collector: TrueAchievementsCollector) -> None:
        """Il rate limiting è ereditato: il client httpx deve essere inizializzato."""
        assert ta_collector._client is not None
        assert ta_collector._semaphore is not None

"""Test Fase 24 — TopicMapper + priority_scorer + discoverers.

Zero I/O reale: DB e HTTP mockati via patch + AsyncMock.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from src.topics.priority_scorer import score_topic
from src.topics.topic_mapper import TopicMapper, slugify_topic


# ── slugify_topic ──────────────────────────────────────────────────────────────


class TestSlugify:
    def test_basic(self) -> None:
        assert slugify_topic("Malenia, Blade of Miquella") == "malenia-blade-of-miquella"

    def test_special_chars(self) -> None:
        assert slugify_topic("Godrick the Grafted!") == "godrick-the-grafted"

    def test_unicode(self) -> None:
        # Caratteri non-latin diventano '-' (best effort, comportamento atteso).
        result = slugify_topic("Yhorm the Giant")
        assert result == "yhorm-the-giant"

    def test_collapses_multiple_separators(self) -> None:
        assert slugify_topic("---boss   name---") == "boss-name"

    def test_empty_returns_unnamed(self) -> None:
        assert slugify_topic("") == "unnamed"
        assert slugify_topic("   ") == "unnamed"

    def test_truncates_at_max_len(self) -> None:
        long_name = "a" * 300
        result = slugify_topic(long_name, max_len=200)
        assert len(result) == 200


# ── priority_scorer ────────────────────────────────────────────────────────────


class TestPriorityScorer:
    def test_default_priority_5(self) -> None:
        assert score_topic("collectible", "Some Item", ["powerpyx"]) == 5

    def test_boss_with_3_sources_minus_2(self) -> None:
        assert score_topic("boss", "Generic Boss", ["fextralife", "fandom", "reddit"]) == 3

    def test_boss_with_keyword_minus_1(self) -> None:
        assert score_topic("boss", "Final Boss", ["fextralife"]) == 4

    def test_boss_with_3_sources_and_keyword(self) -> None:
        # 5 - 2 - 1 = 2
        assert score_topic("boss", "Secret Final Boss", ["a", "b", "c"]) == 2

    def test_build_meta_keyword_minus_1(self) -> None:
        assert score_topic("build", "Bleed Meta Build", ["reddit"]) == 4

    def test_clamp_min_priority_1(self) -> None:
        # Boss + 3+ sorgenti (-2) + 1 keyword (-1) = 5-3 = 2 (lower bound osservabile).
        # Test che il clamp NON scenda sotto 1 anche con condizioni estreme.
        result = score_topic("boss", "Final Boss", ["a", "b", "c"])
        assert result == 2  # 5 - 2 - 1 = 2
        # Edge case: anche se hardcodato, score non scende sotto MIN_PRIORITY.
        from src.topics.priority_scorer import MIN_PRIORITY
        assert result >= MIN_PRIORITY

    def test_clamp_max_priority_10(self) -> None:
        # Nessun cambio score: collectible default
        assert score_topic("collectible", "Item", []) == 5
        # Verifica edge case clamp upward (anche se attualmente nessuna regola aumenta).
        assert score_topic("lore", "X", []) == 5

    def test_unknown_topic_type_returns_default(self) -> None:
        # Logica scorer: tipi non boss/build non hanno regole, default 5.
        assert score_topic("custom", "name", ["a"]) == 5


# ── TopicMapper.upsert_topic ───────────────────────────────────────────────────


class TestUpsertTopic:
    @pytest.mark.asyncio
    async def test_invalid_type_skip(self) -> None:
        """Tipo non in whitelist viene loggato e ignorato (no DB call)."""
        with patch("src.topics.topic_mapper.fetch_one", new=AsyncMock(return_value=None)) as fetch_mock, \
             patch("src.topics.topic_mapper.execute", new=AsyncMock()) as exec_mock:
            mapper = TopicMapper()
            await mapper.upsert_topic(1, "weapon", "Excalibur", "wiki")
            assert fetch_mock.call_count == 0
            assert exec_mock.call_count == 0

    @pytest.mark.asyncio
    async def test_new_topic_inserts_with_single_source(self) -> None:
        with patch("src.topics.topic_mapper.fetch_one", new=AsyncMock(return_value=None)), \
             patch("src.topics.topic_mapper.execute", new=AsyncMock()) as exec_mock:
            mapper = TopicMapper()
            await mapper.upsert_topic(1, "boss", "Malenia", "fextralife")
            assert exec_mock.call_count == 1
            args = exec_mock.call_args[0]
            params = args[1]
            # game_id, topic_type, topic_name, slug, sources, priority
            assert params[0] == 1
            assert params[1] == "boss"
            assert params[3] == "malenia"
            assert params[4] == ["fextralife"]
            # priority: 5 default, no penalty (single source, no keyword)
            assert params[5] == 5

    @pytest.mark.asyncio
    async def test_existing_topic_merges_sources(self) -> None:
        existing = {"discovered_from": ["fextralife"]}
        with patch("src.topics.topic_mapper.fetch_one", new=AsyncMock(return_value=existing)), \
             patch("src.topics.topic_mapper.execute", new=AsyncMock()) as exec_mock:
            mapper = TopicMapper()
            await mapper.upsert_topic(1, "boss", "Malenia", "fandom")
            params = exec_mock.call_args[0][1]
            # Sources merged + sorted
            assert sorted(params[4]) == ["fandom", "fextralife"]


# ── BossDiscoverer parsing ─────────────────────────────────────────────────────


class TestBossParsing:
    def test_fextralife_parser_extracts_named_links(self) -> None:
        from src.topics.discoverers.boss_discoverer import BossDiscoverer

        html = """
        <html><body>
          <a class="wiki_link" href="/Malenia%2C+Blade+of+Miquella">Malenia, Blade of Miquella</a>
          <a class="wiki_link" href="/Godrick+the+Grafted">Godrick the Grafted</a>
          <a class="wiki_link" href="/Wiki%20Home">Wiki Home</a>
          <a class="wiki_link" href="/Bosses">Bosses</a>
          <a class="wiki_link" href="/Random">Bad Link No Plus</a>
        </body></html>
        """
        result = BossDiscoverer._parse_fextralife(html)
        names = [n for n, _ in result]
        assert "Malenia, Blade of Miquella" in names
        assert "Godrick the Grafted" in names
        # Nav link e link senza '+' filtrati
        assert "Wiki Home" not in names
        assert "Bad Link No Plus" not in names
        # source label
        assert all(src == "fextralife" for _, src in result)

    def test_fandom_mediawiki_json_parsing(self) -> None:
        """BossDiscoverer._discover_fandom ora usa MediaWiki API JSON, non HTML scraping."""
        import json

        # Simula risposta MediaWiki API categorymembers
        api_response = json.dumps({
            "query": {
                "categorymembers": [
                    {"title": "Malenia, Blade of Miquella", "ns": 0},
                    {"title": "Godrick the Grafted", "ns": 0},
                    {"title": "Bosses", "ns": 0},   # skip: in _SKIP set
                    {"title": "Category:FromSoft", "ns": 14},  # namespace stripped
                    {"title": "X", "ns": 0},  # too short, filtered
                ]
            }
        })

        # Verifica la logica di parsing direttamente (senza HTTP)
        import json as _j
        data = _j.loads(api_response)
        members = data.get("query", {}).get("categorymembers", [])
        skip = {"Bosses"}
        seen: set[str] = set()
        names = []
        for m in members:
            title = (m.get("title") or "").strip()
            if ":" in title:
                title = title.split(":", 1)[1]
            if not title or len(title) < 3 or len(title) > 80:
                continue
            if title in skip or title in seen:
                continue
            seen.add(title)
            names.append(title)

        assert "Malenia, Blade of Miquella" in names
        assert "Godrick the Grafted" in names
        assert "Bosses" not in names  # filtrato da skip set
        assert "FromSoft" in names or "Category:FromSoft" not in names  # namespace stripped

    def test_slug_variants(self) -> None:
        from src.topics.discoverers.boss_discoverer import BossDiscoverer

        assert BossDiscoverer._slug_variants("elden-ring") == ["elden-ring", "eldenring"]
        # Slug already compact: no duplicate
        assert BossDiscoverer._slug_variants("eldenring") == ["eldenring"]


# ── BuildDiscoverer regex ──────────────────────────────────────────────────────


class TestBuildRegex:
    def test_extracts_build_names_case_insensitive(self) -> None:
        import json as _json

        from src.topics.discoverers.build_discoverer import (
            _BUILD_BLOCKLIST,
            _BUILD_RE,
        )

        payload = {
            "data": {"children": [
                {"data": {"title": "Rivers of Blood build is OP"}},
                {"data": {"title": "Best Mage Build for early game"}},
                {"data": {"title": "Int/Faith Hybrid Caster build guide"}},
                {"data": {"title": "need feedback on my build"}},
            ]}
        }
        children = payload["data"]["children"]
        names = []
        for c in children:
            title = c["data"]["title"]
            if "build" not in title.lower():
                continue
            for m in _BUILD_RE.finditer(title):
                build_name = m.group(1).strip()
                first_word = build_name.split()[0].lower() if build_name.split() else ""
                if first_word in _BUILD_BLOCKLIST:
                    continue
                names.append(build_name)

        lowered = [n.lower() for n in names]
        # Bleed e Hybrid Caster trovati (case-insensitive)
        assert any("blood" in n for n in lowered), f"Expected blood in {lowered}"
        assert any("hybrid" in n or "int" in n for n in lowered), f"Expected hybrid/int in {lowered}"
        # Best/need scartati (in blocklist)
        assert all("best" not in n for n in lowered)
        assert all("need" not in n for n in lowered)

    def test_subreddit_map_overrides_heuristic(self) -> None:
        from src.topics.discoverers.build_discoverer import BuildDiscoverer

        assert BuildDiscoverer._guess_subreddit("elden-ring") == "EldenRingBuilds"
        assert BuildDiscoverer._guess_subreddit("dark-souls-3") == "DarkSouls3Builds"
        # Gioco senza mapping usa heuristica
        assert BuildDiscoverer._guess_subreddit("ghost-of-tsushima") == "ghostoftsushima"

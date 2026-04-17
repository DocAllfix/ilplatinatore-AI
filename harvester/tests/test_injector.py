"""Test per Injector: chunker, slug, deduplicator — DB mockato, zero connessioni reali."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from src.injector.chunker import chunk_content
from src.injector.deduplicator import Deduplicator
from src.injector.upserter import generate_slug

# ── Chunker ──────────────────────────────────────────────────────────────────


class TestChunker:
    def test_short_content_single_chunk(self) -> None:
        """Contenuto breve → un solo chunk con prefisso titolo."""
        chunks = chunk_content("Breve testo.", title="Elden Ring", max_tokens=800)
        assert len(chunks) == 1
        assert chunks[0].startswith("Guida: Elden Ring")
        assert "Breve testo." in chunks[0]

    def test_splits_on_markdown_headings(self) -> None:
        """Contenuto lungo con heading ## → multi chunk."""
        big_section = "Corpo sezione. " * 300  # ~4500 char → supera 800 tok
        content = (
            "## Intro\nIntroduzione breve.\n\n"
            f"## Parte 1\n{big_section}\n\n"
            f"## Parte 2\n{big_section}"
        )
        chunks = chunk_content(content, title="Test Guide", max_tokens=800)
        assert len(chunks) >= 2
        # Ogni chunk ha il prefisso.
        assert all(c.startswith("Guida: Test Guide") for c in chunks)

    def test_title_prefix_on_every_chunk(self) -> None:
        content = "## A\n" + ("x " * 2000) + "\n\n## B\n" + ("y " * 2000)
        chunks = chunk_content(content, title="Zelda", max_tokens=400)
        assert len(chunks) >= 2
        for c in chunks:
            assert c.startswith("Guida: Zelda\n\n")


# ── Slug ─────────────────────────────────────────────────────────────────────


class TestSlug:
    def test_no_special_chars(self) -> None:
        s = generate_slug("God of War: Ragnarök!", "The King's Trophy", "trophy")
        # Solo [a-z0-9-]
        assert all(c.isalnum() or c == "-" for c in s)
        assert s.startswith("guida-")
        assert "king" in s
        assert "--" not in s

    def test_without_trophy(self) -> None:
        s = generate_slug("Elden Ring", None, "walkthrough")
        assert s == "guida-elden-ring-walkthrough"


# ── Deduplicator ─────────────────────────────────────────────────────────────


class TestShouldUpsert:
    def test_new_guide_upserts(self) -> None:
        assert Deduplicator.should_upsert(None, 0.5) is True

    def test_verified_never_overwritten(self) -> None:
        existing = {"id": 1, "confidence_level": "verified", "quality_score": 0.3}
        assert Deduplicator.should_upsert(existing, 0.99) is False

    def test_higher_quality_overwrites(self) -> None:
        existing = {"id": 1, "confidence_level": "harvested", "quality_score": 0.4}
        assert Deduplicator.should_upsert(existing, 0.7) is True

    def test_lower_quality_skips(self) -> None:
        existing = {"id": 1, "confidence_level": "harvested", "quality_score": 0.8}
        assert Deduplicator.should_upsert(existing, 0.4) is False

    def test_equal_quality_does_upsert(self) -> None:
        """Qualità uguale → upsert consentito.

        Necessario perché il LLM produce sempre quality=1.0 per guide ben formate.
        Senza questo, una guida con label italiane non potrebbe mai essere rigenerata
        in inglese, poiché il confronto 1.0 > 1.0 sarebbe sempre False.
        """
        existing = {"id": 1, "confidence_level": "harvested", "quality_score": 1.0}
        assert Deduplicator.should_upsert(existing, 1.0) is True


class TestSourceAlreadyProcessed:
    @pytest.mark.asyncio
    async def test_returns_true_on_hash_match(self) -> None:
        """Stesso URL + stesso hash → True (già processato)."""
        dedup = Deduplicator()
        with patch(
            "src.injector.deduplicator.fetch_one",
            new_callable=AsyncMock,
            return_value={"?column?": 1},
        ):
            assert (
                await dedup.source_already_processed(
                    "https://powerpyx.com/x/", "abc123"
                )
                is True
            )

    @pytest.mark.asyncio
    async def test_returns_false_on_no_match(self) -> None:
        dedup = Deduplicator()
        with patch(
            "src.injector.deduplicator.fetch_one",
            new_callable=AsyncMock,
            return_value=None,
        ):
            assert (
                await dedup.source_already_processed(
                    "https://powerpyx.com/x/", "abc123"
                )
                is False
            )

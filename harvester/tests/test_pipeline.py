"""Test per HarvestPipeline — tutto mockato, zero connessioni reali."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.orchestrator.pipeline import HarvestPipeline


def _make_pipeline() -> HarvestPipeline:
    """Crea una pipeline con tutti i componenti mockati."""
    p = HarvestPipeline.__new__(HarvestPipeline)
    p._seed_loader = MagicMock()
    p._collector = MagicMock()
    p._collector.collect = AsyncMock()
    p._collector.close = AsyncMock()
    p._synthesizer = MagicMock()
    p._synthesizer.transform = AsyncMock()
    p._deduplicator = MagicMock()
    p._deduplicator.source_already_processed = AsyncMock()
    p._embedder = MagicMock()
    p._embedder.embed_batch = AsyncMock()
    p._upserter = MagicMock()
    p._upserter.upsert_guide = AsyncMock()
    p._logger = MagicMock()
    p.guides_processed = 0
    p.guides_injected = 0
    p.guides_skipped = 0
    p.guides_failed = 0
    return p


class TestProcessSingleGuide:
    @pytest.mark.asyncio
    async def test_returns_false_when_all_collectors_return_none(self) -> None:
        """Se tutti i collect ritornano None → False."""
        p = _make_pipeline()
        p._collector.collect.return_value = None

        result = await p.process_single_guide(
            "Elden Ring", None, ["https://powerpyx.com/elden-ring/"]
        )

        assert result is False
        assert p.guides_failed == 1

    @pytest.mark.asyncio
    async def test_returns_false_when_quality_below_threshold(self) -> None:
        """Se quality_score < 0.4 → skip."""
        p = _make_pipeline()
        # Collector ritorna contenuto valido.
        p._collector.collect.return_value = {
            "raw_content": "short",
            "source_url": "https://powerpyx.com/x/",
            "source_domain": "powerpyx.com",
            "content_hash": "abc",
        }
        # Non già processato.
        p._deduplicator.source_already_processed.return_value = False
        # Transformer ritorna guida quasi vuota → quality bassa (< 0.4).
        # Solo 2/6 campi presenti = 0.40*(2/6)=0.13, content corto, no steps, no tips.
        p._synthesizer.transform.return_value = {
            "title": "Test",
            "content": "short",
            "game_name": "",
            "trophy_name": None,
            "guide_type": "",
            "language": "en",
        }

        result = await p.process_single_guide("X", None, ["https://powerpyx.com/x/"])

        assert result is False
        assert p.guides_skipped == 1

    @pytest.mark.asyncio
    async def test_calls_upsert_on_success(self) -> None:
        """Pipeline completa: collect → transform → quality OK → upsert."""
        p = _make_pipeline()
        p._collector.collect.return_value = {
            "raw_content": "contenuto completo " * 100,
            "source_url": "https://powerpyx.com/elden-ring/",
            "source_domain": "powerpyx.com",
            "content_hash": "hash123",
        }
        p._deduplicator.source_already_processed.return_value = False
        p._synthesizer.transform.return_value = {
            "title": "Guida Elden Ring",
            "content": (
                "## Guida completa\n\n**Gioco:** Elden Ring\n\n"
                "1. Primo step della guida\n"
                "2. Secondo step della guida\n"
                "3. Terzo step della guida\n\n"
                "Ecco alcuni consigli e strategie per completare il gioco."
            ),
            "game_name": "Elden Ring",
            "trophy_name": None,
            "guide_type": "trophy_guide",
            "language": "it",
        }
        p._embedder.embed_batch.return_value = [[0.1, 0.2, 0.3]]
        p._upserter.upsert_guide.return_value = 42

        result = await p.process_single_guide(
            "Elden Ring", None, ["https://powerpyx.com/elden-ring/"]
        )

        assert result is True
        assert p.guides_injected == 1
        p._upserter.upsert_guide.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_returns_false_when_already_processed(self) -> None:
        """Se tutte le sorgenti sono già processate → skip."""
        p = _make_pipeline()
        p._collector.collect.return_value = {
            "raw_content": "content",
            "source_url": "https://powerpyx.com/x/",
            "source_domain": "powerpyx.com",
            "content_hash": "same_hash",
        }
        p._deduplicator.source_already_processed.return_value = True

        result = await p.process_single_guide("X", None, ["https://powerpyx.com/x/"])

        assert result is False
        assert p.guides_skipped == 1


class TestRunSeedBatch:
    @pytest.mark.asyncio
    async def test_returns_stats_dict(self) -> None:
        """run_seed_batch ritorna dizionario con tutte le statistiche."""
        p = _make_pipeline()
        p._seed_loader.load_seed_file.return_value = [
            {"title": "Elden Ring", "slug": "elden-ring"},
            {"title": "God of War", "slug": "god-of-war-ragnarok"},
        ]

        # Mock advisory lock: acquisito.
        mock_conn = AsyncMock()
        mock_result = AsyncMock()
        mock_result.fetchone.return_value = (True,)
        mock_conn.execute.return_value = mock_result

        mock_pool = AsyncMock()
        mock_pool.getconn.return_value = mock_conn
        mock_pool.putconn = AsyncMock()

        with (
            patch(
                "src.orchestrator.pipeline._get_pool",
                new_callable=AsyncMock,
                return_value=mock_pool,
            ),
            patch.object(
                p,
                "_get_last_processed_slug",
                new_callable=AsyncMock,
                return_value=None,
            ),
            patch.object(p, "process_single_guide", new_callable=AsyncMock, return_value=True),
            patch.object(p, "_save_progress", new_callable=AsyncMock),
            patch.object(p, "_reset_progress", new_callable=AsyncMock),
        ):
            stats = await p.run_seed_batch("seeds/top_games.json")

        assert "processed" in stats
        assert "injected" in stats
        assert "skipped" in stats
        assert "failed" in stats
        assert "resumed_from" in stats
        assert "duration_seconds" in stats
        assert stats["resumed_from"] is None

    @pytest.mark.asyncio
    async def test_exits_gracefully_when_lock_busy(self) -> None:
        """Se advisory lock non acquisito → ritorna subito con skipped_reason."""
        p = _make_pipeline()

        mock_conn = AsyncMock()
        mock_result = AsyncMock()
        mock_result.fetchone.return_value = (False,)
        mock_conn.execute.return_value = mock_result

        mock_pool = AsyncMock()
        mock_pool.getconn.return_value = mock_conn
        mock_pool.putconn = AsyncMock()

        with patch(
            "src.orchestrator.pipeline._get_pool",
            new_callable=AsyncMock,
            return_value=mock_pool,
        ):
            stats = await p.run_seed_batch("seeds/top_games.json")

        assert stats["skipped_reason"] == "another_instance_running"
        assert stats["processed"] == 0


class TestCleanup:
    @pytest.mark.asyncio
    async def test_closes_collector(self) -> None:
        """cleanup() chiama collector.close()."""
        p = _make_pipeline()
        await p.cleanup()
        p._collector.close.assert_awaited_once()

"""Test per il modulo Transformer — prompts, quality score, daily limit.

NON chiama Gemini reale: il client viene mockato.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from src.transformer.prompts import FACT_EXTRACTION_PROMPT, GUIDE_SYNTHESIS_PROMPT
from src.transformer.quality import calculate_quality_score

# ── Prompts ──────────────────────────────────────────────────────────────────


class TestPrompts:
    def test_fact_extraction_mentions_json_array(self) -> None:
        assert "JSON array" in FACT_EXTRACTION_PROMPT

    def test_synthesis_mentions_platinatore_and_english(self) -> None:
        assert "Il Platinatore" in GUIDE_SYNTHESIS_PROMPT
        assert "English" in GUIDE_SYNTHESIS_PROMPT


# ── Quality score ────────────────────────────────────────────────────────────


_COMPLETE_CONTENT = """## Platino — Elden Ring

**Gioco:** Elden Ring
**Tipo:** Platino
**Difficoltà:** 7/10
**Tempo stimato:** 80 ore
**Missabile:** No

### Descrizione
Guida completa per ottenere il platino di Elden Ring.

### Come Ottenere Questo Trofeo
1. Completa la storia principale.
2. Ottieni tutti i Great Runes.
3. Completa le quest di Ranni e Volcano Manor.
4. Sblocca tutti i finali in new game plus.

### Consigli e Strategie
Porta sempre una build magica di backup. Fai save manuali prima di scelte irreversibili.

### Prerequisiti e Avvertenze
Alcune quest sono missabili: segui una checklist affidabile."""

_COMPLETE_GUIDE = {
    "title": "Platino — Elden Ring",
    "content": _COMPLETE_CONTENT,
    "game_name": "Elden Ring",
    "trophy_name": "Platino",
    "guide_type": "trophy",
    "language": "en",
    "source": "harvested",
    "confidence_level": "harvested",
}


class TestQualityScore:
    def test_complete_guide_scores_above_threshold(self) -> None:
        score = calculate_quality_score(_COMPLETE_GUIDE)
        assert score >= 0.7, f"expected >=0.7, got {score}"
        assert score <= 1.0

    def test_empty_guide_scores_low(self) -> None:
        assert calculate_quality_score({}) < 0.4

    def test_returns_float_two_decimals(self) -> None:
        score = calculate_quality_score(_COMPLETE_GUIDE)
        # Massimo 2 decimali
        assert round(score, 2) == score


# ── Daily limit ──────────────────────────────────────────────────────────────


class TestDailyLimit:
    @pytest.mark.asyncio
    async def test_returns_false_when_limit_reached(self) -> None:
        """Se _gemini_calls_today >= settings.daily_gemini_limit → False."""
        # Forza provider deepseek e mocka OpenAI per evitare chiamate reali.
        with (
            patch("src.transformer.synthesizer.settings") as mock_settings,
            patch("openai.OpenAI", return_value=MagicMock()),
        ):
            mock_settings.transformer_provider = "deepseek"
            mock_settings.deepseek_api_key = "test-key"
            mock_settings.daily_gemini_limit = 10

            from src.transformer.synthesizer import GuideSynthesizer

            synth = GuideSynthesizer()
            synth._gemini_calls_today = 10

            assert await synth._check_daily_limit() is False

    @pytest.mark.asyncio
    async def test_returns_true_below_limit(self) -> None:
        with (
            patch("src.transformer.synthesizer.settings") as mock_settings,
            patch("openai.OpenAI", return_value=MagicMock()),
        ):
            mock_settings.transformer_provider = "deepseek"
            mock_settings.deepseek_api_key = "test-key"
            mock_settings.daily_gemini_limit = 100

            from src.transformer.synthesizer import GuideSynthesizer

            synth = GuideSynthesizer()
            synth._gemini_calls_today = 5

            assert await synth._check_daily_limit() is True

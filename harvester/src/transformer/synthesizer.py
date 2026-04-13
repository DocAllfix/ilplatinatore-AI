"""GuideSynthesizer — pipeline Gemini 2.5 Flash: extract_facts → synthesize_guide.

Gestisce quota giornaliera (settings.daily_gemini_limit), parsing JSON robusto
(con strip di markdown fences), logging strutturato.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from datetime import date

from google import genai
from google.genai import types as genai_types

from src.config.logger import get_logger
from src.config.settings import settings
from src.transformer.prompts import FACT_EXTRACTION_PROMPT, GUIDE_SYNTHESIS_PROMPT

_MODEL = "gemini-2.5-flash"
_TEMPERATURE = 0.3
_MAX_OUTPUT_TOKENS = 4096

# Regex per strippare ```json ... ``` fences eventualmente restituite da Gemini.
_JSON_FENCE_RE = re.compile(r"^\s*```(?:json)?\s*\n?(.*?)\n?```\s*$", re.DOTALL)

# Regex per il titolo della guida: prima riga ## ...
_TITLE_RE = re.compile(r"^\s*##\s+(.+?)\s*$", re.MULTILINE)


class GuideSynthesizer:
    """Wrapper Gemini per estrazione fatti + sintesi guide."""

    def __init__(self) -> None:
        self._client = genai.Client(api_key=settings.gemini_api_key)
        self._gemini_calls_today: int = 0
        self._last_reset_date: date = date.today()
        self._logger = get_logger(self.__class__.__name__)

    # ── Quota ────────────────────────────────────────────────────────────────

    async def _check_daily_limit(self) -> bool:
        """Reset del contatore se cambia giorno; False se limite superato."""
        today = date.today()
        if today != self._last_reset_date:
            self._gemini_calls_today = 0
            self._last_reset_date = today

        if self._gemini_calls_today >= settings.daily_gemini_limit:
            self._logger.warning(
                "quota Gemini giornaliera esaurita",
                calls=self._gemini_calls_today,
                limit=settings.daily_gemini_limit,
            )
            return False
        return True

    # ── Gemini call helper ───────────────────────────────────────────────────

    def _call_gemini(self, system_instruction: str, user_prompt: str) -> str:
        """Chiamata Gemini sincrona (SDK è sync).  Ritorna response.text."""
        config = genai_types.GenerateContentConfig(
            system_instruction=system_instruction,
            temperature=_TEMPERATURE,
            max_output_tokens=_MAX_OUTPUT_TOKENS,
        )
        response = self._client.models.generate_content(
            model=_MODEL,
            contents=[user_prompt],
            config=config,
        )
        return response.text or ""

    # ── Extract facts ────────────────────────────────────────────────────────

    async def extract_facts(
        self,
        raw_contents: list[str],
        game_name: str,
        trophy_name: str,
    ) -> list[dict] | None:
        """Estrae fatti atomici dai testi grezzi via Gemini.  None se quota o parsing KO."""
        if not await self._check_daily_limit():
            return None

        concatenated = "\n---FONTE SUCCESSIVA---\n".join(raw_contents)
        user_prompt = (
            f"Gioco: {game_name}\n"
            f"Trofeo: {trophy_name}\n\n"
            f"Testi grezzi:\n{concatenated}"
        )

        start = time.monotonic()
        try:
            raw_text = await asyncio.to_thread(
                self._call_gemini, FACT_EXTRACTION_PROMPT, user_prompt
            )
        except Exception as exc:  # noqa: BLE001 — SDK può lanciare qualsiasi errore
            self._logger.error(
                "Gemini extract_facts failed",
                error=str(exc),
                game=game_name,
                trophy=trophy_name,
            )
            return None
        finally:
            self._gemini_calls_today += 1

        elapsed_ms = round((time.monotonic() - start) * 1000, 1)

        cleaned = _strip_json_fences(raw_text)
        try:
            facts = json.loads(cleaned)
        except json.JSONDecodeError as exc:
            self._logger.error(
                "Gemini ha restituito JSON non valido",
                error=str(exc),
                preview=cleaned[:200],
            )
            return None

        if not isinstance(facts, list):
            self._logger.error(
                "Gemini facts non è una lista",
                type=type(facts).__name__,
            )
            return None

        self._logger.info(
            "fatti estratti",
            count=len(facts),
            elapsed_ms=elapsed_ms,
            game=game_name,
            trophy=trophy_name,
        )
        return facts

    # ── Synthesize guide ─────────────────────────────────────────────────────

    async def synthesize_guide(
        self,
        facts: list[dict],
        game_name: str,
        trophy_name: str,
    ) -> dict | None:
        """Sintetizza una guida markdown dai fatti.  None se quota o formato KO."""
        if not await self._check_daily_limit():
            return None

        user_prompt = (
            f"Gioco: {game_name}\n"
            f"Trofeo: {trophy_name}\n\n"
            f"Fatti verificati:\n{json.dumps(facts, ensure_ascii=False, indent=2)}"
        )

        start = time.monotonic()
        try:
            markdown = await asyncio.to_thread(
                self._call_gemini, GUIDE_SYNTHESIS_PROMPT, user_prompt
            )
        except Exception as exc:  # noqa: BLE001
            self._logger.error(
                "Gemini synthesize_guide failed",
                error=str(exc),
                game=game_name,
                trophy=trophy_name,
            )
            return None
        finally:
            self._gemini_calls_today += 1

        elapsed_ms = round((time.monotonic() - start) * 1000, 1)

        if "##" not in markdown or "**Gioco:**" not in markdown:
            self._logger.error(
                "output Gemini non rispetta il template",
                preview=markdown[:300],
                game=game_name,
                trophy=trophy_name,
            )
            return None

        title_match = _TITLE_RE.search(markdown)
        title = title_match.group(1).strip() if title_match else trophy_name

        guide = {
            "title": title,
            "content": markdown,
            "game_name": game_name,
            "trophy_name": trophy_name,
            "guide_type": "trophy_guide",
            "language": "en",
            "source": "harvested",
            "confidence_level": "harvested",
        }

        self._logger.info(
            "guida sintetizzata",
            title=title[:80],
            elapsed_ms=elapsed_ms,
            content_length=len(markdown),
        )
        return guide

    # ── Full pipeline ────────────────────────────────────────────────────────

    async def transform(
        self,
        raw_contents: list[str],
        game_name: str,
        trophy_name: str,
    ) -> dict | None:
        """Pipeline completa: extract_facts → synthesize_guide."""
        facts = await self.extract_facts(raw_contents, game_name, trophy_name)
        if facts is None:
            return None

        guide = await self.synthesize_guide(facts, game_name, trophy_name)
        if guide is None:
            return None

        self._logger.info(
            "transform completato",
            game=game_name,
            trophy=trophy_name,
            title=guide["title"][:80],
            content_length=len(guide["content"]),
        )
        return guide


def _strip_json_fences(text: str) -> str:
    """Rimuove eventuali ```json ... ``` fences che Gemini potrebbe aggiungere."""
    m = _JSON_FENCE_RE.match(text.strip())
    if m:
        return m.group(1).strip()
    return text.strip()

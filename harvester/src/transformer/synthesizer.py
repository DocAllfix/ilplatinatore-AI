"""GuideSynthesizer — pipeline multi-provider: extract_facts → synthesize_guide.

Provider supportati (TRANSFORMER_PROVIDER in .env):
  - deepseek  (default) — DeepSeek-V3.2, OpenAI-compatible SDK
  - gemini               — Gemini 2.5 Flash Lite, google-genai SDK

Gestisce quota giornaliera (settings.daily_gemini_limit), parsing JSON robusto
(con strip di markdown fences), logging strutturato.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from datetime import date

from src.config.logger import get_logger
from src.config.settings import settings
from src.transformer.prompts import FACT_EXTRACTION_PROMPT, GUIDE_SYNTHESIS_PROMPT

_TEMPERATURE = 0.3
_MAX_OUTPUT_TOKENS = 8192  # DeepSeek-chat max; Gemini supporta valori più alti
_REQUEST_TIMEOUT = 120  # secondi: se il provider non risponde entro 2 min → eccezione

# DeepSeek config
_DEEPSEEK_MODEL = "deepseek-chat"
_DEEPSEEK_BASE_URL = "https://api.deepseek.com"

# Gemini config (fallback)
_GEMINI_MODEL = "gemini-2.5-flash-lite"

# Regex per estrarre il contenuto da ```json ... ``` fences.
_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*\n?(.*?)\n?```", re.DOTALL)

# Regex per il titolo della guida: prima riga ## ...
_TITLE_RE = re.compile(r"^\s*##\s+(.+?)\s*$", re.MULTILINE)


class GuideSynthesizer:
    """Wrapper multi-provider per estrazione fatti + sintesi guide."""

    def __init__(self) -> None:
        self._provider = settings.transformer_provider.lower()
        self._logger = get_logger(self.__class__.__name__)
        self._gemini_calls_today: int = 0
        self._last_reset_date: date = date.today()

        if self._provider == "deepseek":
            from openai import OpenAI  # noqa: PLC0415
            self._client = OpenAI(
                api_key=settings.deepseek_api_key,
                base_url=_DEEPSEEK_BASE_URL,
                timeout=_REQUEST_TIMEOUT,
            )
            self._logger.info("transformer provider: DeepSeek", model=_DEEPSEEK_MODEL)
        else:
            from google import genai  # noqa: PLC0415
            from google.genai import types as genai_types  # noqa: PLC0415
            self._genai_types = genai_types
            self._client = genai.Client(
                api_key=settings.gemini_api_key,
                http_options=genai_types.HttpOptions(timeout=_REQUEST_TIMEOUT),
            )
            self._logger.info("transformer provider: Gemini", model=_GEMINI_MODEL)

    # ── Quota (shared tra provider) ───────────────────────────────────────────

    async def _check_daily_limit(self) -> bool:
        """Reset del contatore se cambia giorno; False se limite superato."""
        today = date.today()
        if today != self._last_reset_date:
            self._gemini_calls_today = 0
            self._last_reset_date = today
        if self._gemini_calls_today >= settings.daily_gemini_limit:
            self._logger.warning(
                "quota giornaliera esaurita",
                calls=self._gemini_calls_today,
                limit=settings.daily_gemini_limit,
            )
            return False
        return True

    # ── Provider call helpers ─────────────────────────────────────────────────

    def _call_deepseek(
        self,
        system_prompt: str,
        user_prompt: str,
        json_mode: bool = False,
    ) -> str:
        """Chiamata DeepSeek sincrona via OpenAI-compatible SDK."""
        kwargs: dict = {}
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}

        response = self._client.chat.completions.create(
            model=_DEEPSEEK_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=_TEMPERATURE,
            max_tokens=_MAX_OUTPUT_TOKENS,
            **kwargs,
        )
        return response.choices[0].message.content or ""

    def _call_gemini(
        self,
        system_instruction: str,
        user_prompt: str,
        response_mime_type: str | None = None,
    ) -> str:
        """Chiamata Gemini sincrona via google-genai SDK."""
        genai_types = self._genai_types
        config = genai_types.GenerateContentConfig(
            system_instruction=system_instruction,
            temperature=_TEMPERATURE,
            max_output_tokens=_MAX_OUTPUT_TOKENS,
            **({"response_mime_type": response_mime_type} if response_mime_type else {}),
        )
        response = self._client.models.generate_content(
            model=_GEMINI_MODEL,
            contents=[user_prompt],
            config=config,
        )
        return response.text or ""

    def _call_llm(
        self,
        system_prompt: str,
        user_prompt: str,
        json_mode: bool = False,
    ) -> str:
        """Dispatch al provider configurato."""
        if self._provider == "deepseek":
            return self._call_deepseek(system_prompt, user_prompt, json_mode=json_mode)
        return self._call_gemini(
            system_prompt,
            user_prompt,
            response_mime_type="application/json" if json_mode else None,
        )

    # ── Extract facts ────────────────────────────────────────────────────────

    async def extract_facts(
        self,
        raw_contents: list[str],
        game_name: str,
        trophy_name: str,
    ) -> list[dict] | None:
        """Estrae fatti atomici dai testi grezzi. None se quota o parsing KO."""
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
                self._call_llm,
                FACT_EXTRACTION_PROMPT,
                user_prompt,
                True,  # json_mode
            )
        except Exception as exc:  # noqa: BLE001
            self._logger.error(
                "extract_facts failed",
                provider=self._provider,
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
                "JSON non valido da provider",
                provider=self._provider,
                error=str(exc),
                preview=cleaned[:200],
            )
            return None

        if not isinstance(facts, list):
            # DeepSeek con json_object mode può wrappare in {"facts": [...]}
            if isinstance(facts, dict):
                for v in facts.values():
                    if isinstance(v, list):
                        facts = v
                        break
            if not isinstance(facts, list):
                self._logger.error(
                    "facts non è una lista",
                    provider=self._provider,
                    type=type(facts).__name__,
                )
                return None

        self._logger.info(
            "fatti estratti",
            count=len(facts),
            elapsed_ms=elapsed_ms,
            provider=self._provider,
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
        """Sintetizza una guida markdown dai fatti. None se quota o formato KO."""
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
                self._call_llm,
                GUIDE_SYNTHESIS_PROMPT,
                user_prompt,
                False,  # json_mode
            )
        except Exception as exc:  # noqa: BLE001
            self._logger.error(
                "synthesize_guide failed",
                provider=self._provider,
                error=str(exc),
                game=game_name,
                trophy=trophy_name,
            )
            return None
        finally:
            self._gemini_calls_today += 1

        elapsed_ms = round((time.monotonic() - start) * 1000, 1)

        markdown = _strip_markdown_fences(markdown)

        has_heading = "##" in markdown
        has_game_field = "**Game:**" in markdown or "**Gioco:**" in markdown
        if not has_heading or not has_game_field:
            self._logger.error(
                "output non rispetta il template",
                provider=self._provider,
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
            "guide_type": "trophy",
            "language": "en",
            "source": "harvested",
            "confidence_level": "harvested",
        }

        self._logger.info(
            "guida sintetizzata",
            title=title[:80],
            elapsed_ms=elapsed_ms,
            provider=self._provider,
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
            provider=self._provider,
            game=game_name,
            trophy=trophy_name,
            title=guide["title"][:80],
            content_length=len(guide["content"]),
        )
        return guide


_MARKDOWN_FENCE_RE = re.compile(r"```(?:markdown)?\s*\n?(.*?)\n?```\s*$", re.DOTALL)


def _strip_markdown_fences(text: str) -> str:
    """Rimuove eventuali ```markdown ... ``` fences dal testo sintetizzato."""
    stripped = text.strip()
    m = _MARKDOWN_FENCE_RE.search(stripped)
    if m:
        return m.group(1).strip()
    return stripped


def _strip_json_fences(text: str) -> str:
    """Rimuove eventuali ```json ... ``` fences.

    Usa search() invece di match() per gestire testo prima/dopo le fences.
    Fallback: se la fence non è chiusa, cerca il primo '[' o '{'.
    """
    stripped = text.strip()
    m = _JSON_FENCE_RE.search(stripped)
    if m:
        return m.group(1).strip()
    for start_char in ("[", "{"):
        idx = stripped.find(start_char)
        if idx != -1:
            return stripped[idx:]
    return stripped

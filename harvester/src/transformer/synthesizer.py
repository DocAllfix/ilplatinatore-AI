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
_MAX_OUTPUT_TOKENS = 16384
_REQUEST_TIMEOUT = 120  # secondi: se Gemini non risponde entro 2 min → eccezione

# Regex per estrarre il contenuto da ```json ... ``` fences eventualmente restituite da Gemini.
# Usa search (non match) per trovare la fence anche se Gemini aggiunge testo prima/dopo.
_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*\n?(.*?)\n?```", re.DOTALL)

# Regex per il titolo della guida: prima riga ## ...
_TITLE_RE = re.compile(r"^\s*##\s+(.+?)\s*$", re.MULTILINE)


class GuideSynthesizer:
    """Wrapper Gemini per estrazione fatti + sintesi guide."""

    def __init__(self) -> None:
        self._client = genai.Client(
            api_key=settings.gemini_api_key,
            http_options=genai_types.HttpOptions(timeout=_REQUEST_TIMEOUT),
        )
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

    def _call_gemini(
        self,
        system_instruction: str,
        user_prompt: str,
        response_mime_type: str | None = None,
    ) -> str:
        """Chiamata Gemini sincrona (SDK è sync).  Ritorna response.text.

        response_mime_type: se "application/json", abilita il JSON mode di Gemini
        (evita fences, forza output JSON valido).  Usato solo per extract_facts.
        """
        config = genai_types.GenerateContentConfig(
            system_instruction=system_instruction,
            temperature=_TEMPERATURE,
            max_output_tokens=_MAX_OUTPUT_TOKENS,
            **({"response_mime_type": response_mime_type} if response_mime_type else {}),
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
                self._call_gemini,
                FACT_EXTRACTION_PROMPT,
                user_prompt,
                "application/json",  # JSON mode: no fences, output validato
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

        # Strip eventuali ```markdown ... ``` fences — Gemini le aggiunge a volte.
        markdown = _strip_markdown_fences(markdown)

        # Valida il template: deve avere un heading ## e almeno un campo **Game:** o **Gioco:**
        has_heading = "##" in markdown
        has_game_field = "**Game:**" in markdown or "**Gioco:**" in markdown
        if not has_heading or not has_game_field:
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
            "guide_type": "trophy",
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


_MARKDOWN_FENCE_RE = re.compile(r"```(?:markdown)?\s*\n?(.*?)\n?```\s*$", re.DOTALL)


def _strip_markdown_fences(text: str) -> str:
    """Rimuove eventuali ```markdown ... ``` fences dal testo sintetizzato."""
    stripped = text.strip()
    m = _MARKDOWN_FENCE_RE.search(stripped)
    if m:
        return m.group(1).strip()
    return stripped


def _strip_json_fences(text: str) -> str:
    """Rimuove eventuali ```json ... ``` fences che Gemini potrebbe aggiungere.

    Usa search() invece di match() per gestire testo prima/dopo le fences.
    Fallback: se la fence non è chiusa (max_tokens raggiunto), cerca il primo
    '[' o '{' e restituisce tutto da lì in poi.
    """
    stripped = text.strip()
    m = _JSON_FENCE_RE.search(stripped)
    if m:
        return m.group(1).strip()

    # Fallback: cerca il primo array o oggetto JSON nel testo (fence non chiusa).
    for start_char in ("[", "{"):
        idx = stripped.find(start_char)
        if idx != -1:
            return stripped[idx:]

    return stripped

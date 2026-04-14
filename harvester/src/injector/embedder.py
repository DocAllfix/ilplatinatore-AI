"""Embedder — wrapper Gemini text-embedding-004 con batching e quota giornaliera.

NOTA: nell'architettura corrente l'harvester Python NON scrive in guide_embeddings:
quel lavoro è del worker BullMQ Node.js che legge `embedding_pending=true`.
Questo modulo esiste per eventuali pipeline sincrone / test / future estensioni.
"""

from __future__ import annotations

import asyncio
import time
from datetime import date

from google import genai
from google.genai import types as genai_types

from src.config.logger import get_logger
from src.config.settings import settings

# gemini-embedding-001 è disponibile su v1beta.
# text-embedding-004 era il modello precedente (v1 only).
_MODEL = "gemini-embedding-001"
_EMBEDDING_DIM = 768  # deve corrispondere alla colonna vector(768) in guide_embeddings
_MAX_BATCH_SIZE = 100


class Embedder:
    """Wrapper Gemini embedding con quota e batching automatico."""

    def __init__(self) -> None:
        self._client = genai.Client(api_key=settings.google_embedding_api_key)
        self._calls_today: int = 0
        self._last_reset_date: date = date.today()
        self._logger = get_logger(self.__class__.__name__)

    async def _check_daily_limit(self, needed: int = 1) -> bool:
        today = date.today()
        if today != self._last_reset_date:
            self._calls_today = 0
            self._last_reset_date = today
        if self._calls_today + needed > settings.daily_embedding_limit:
            self._logger.warning(
                "quota embedding giornaliera esaurita",
                calls=self._calls_today,
                needed=needed,
                limit=settings.daily_embedding_limit,
            )
            return False
        return True

    def _embed_sync(self, texts: list[str]) -> list[list[float]]:
        config = genai_types.EmbedContentConfig(
            output_dimensionality=_EMBEDDING_DIM,
        )
        result = self._client.models.embed_content(
            model=_MODEL,
            contents=texts,
            config=config,
        )
        return [list(emb.values) for emb in result.embeddings]

    async def embed_batch(self, texts: list[str]) -> list[list[float]] | None:
        """Embedding in batch (max 100/call).  Splitta in sotto-batch se necessario."""
        if not texts:
            return []

        if not await self._check_daily_limit(len(texts)):
            return None

        vectors: list[list[float]] = []
        start = time.monotonic()
        try:
            for i in range(0, len(texts), _MAX_BATCH_SIZE):
                sub = texts[i : i + _MAX_BATCH_SIZE]
                batch_vecs = await asyncio.to_thread(self._embed_sync, sub)
                vectors.extend(batch_vecs)
                self._calls_today += len(sub)
        except Exception as exc:  # noqa: BLE001 — SDK errori eterogenei
            self._logger.error(
                "Gemini embed_batch failed",
                error=str(exc),
                n_texts=len(texts),
            )
            return None

        elapsed_ms = round((time.monotonic() - start) * 1000, 1)
        dim = len(vectors[0]) if vectors else 0
        self._logger.info(
            "embedding batch completato",
            n_texts=len(texts),
            dim=dim,
            elapsed_ms=elapsed_ms,
        )
        return vectors

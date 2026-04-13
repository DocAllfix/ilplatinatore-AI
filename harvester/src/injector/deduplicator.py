"""Deduplicator — evita upsert inutili e protegge guide verificate."""

from __future__ import annotations

from src.config.db import fetch_one
from src.config.logger import get_logger


class Deduplicator:
    """Logica di deduplicazione basata su DB lookup."""

    def __init__(self) -> None:
        self._logger = get_logger(self.__class__.__name__)

    async def guide_exists(
        self,
        game_id: int,
        trophy_id: int | None,
        guide_type: str,
    ) -> dict | None:
        """Ritorna la guida esistente (id/confidence/quality) se presente, altrimenti None."""
        if trophy_id is None:
            # Cerca guida senza trophy_id: IS NULL match.
            row = await fetch_one(
                # Cerca guida esistente per (game_id, trophy_id NULL, guide_type).
                "SELECT id, confidence_level, quality_score "
                "FROM guides "
                "WHERE game_id = %s AND trophy_id IS NULL AND guide_type = %s "
                "LIMIT 1",
                (game_id, guide_type),
            )
        else:
            row = await fetch_one(
                # Cerca guida esistente per (game_id, trophy_id, guide_type).
                "SELECT id, confidence_level, quality_score "
                "FROM guides "
                "WHERE game_id = %s AND trophy_id = %s AND guide_type = %s "
                "LIMIT 1",
                (game_id, trophy_id, guide_type),
            )
        if not row:
            return None
        return {
            "id": row["id"],
            "confidence_level": row.get("confidence_level") or "unverified",
            "quality_score": float(row.get("quality_score") or 0.0),
        }

    async def source_already_processed(
        self, source_url: str, content_hash: str
    ) -> bool:
        """True se esiste harvest_sources con stessa URL e stesso hash (nulla è cambiato)."""
        row = await fetch_one(
            # Verifica che URL+hash siano già processati (skip re-ingestion inutile).
            "SELECT 1 FROM harvest_sources "
            "WHERE source_url = %s AND content_hash = %s "
            "LIMIT 1",
            (source_url, content_hash),
        )
        return row is not None

    @staticmethod
    def should_upsert(existing: dict | None, new_quality_score: float) -> bool:
        """Decide se sovrascrivere una guida esistente.

        - None → upsert (nuova guida)
        - verified → MAI sovrascrivere
        - new_quality > existing_quality → upsert (miglioramento)
        - altrimenti → skip
        """
        if existing is None:
            return True
        if existing.get("confidence_level") == "verified":
            return False
        return new_quality_score > float(existing.get("quality_score", 0.0))

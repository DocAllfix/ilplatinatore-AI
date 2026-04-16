"""Upserter — transazione atomica: game → trophy → guide → harvest_sources.

**FF-NEW-3:** l'harvester NON inserisce embedding né tocca Redis/BullMQ.
Il contratto con il backend Node è solo `guides.embedding_pending = true`.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

from psycopg.rows import dict_row

from src.config.db import _get_pool
from src.config.logger import get_logger
from src.injector.deduplicator import Deduplicator

logger = get_logger("Upserter")

_SLUG_CLEANUP_RE = re.compile(r"[^a-z0-9]+")
_CET = ZoneInfo("Europe/Rome")


def _slugify(text: str) -> str:
    """Lowercase + rimozione accenti base + non-alfanumerici → trattini."""
    return _SLUG_CLEANUP_RE.sub("-", text.lower()).strip("-")


def generate_slug(
    game_name: str,
    trophy_name: str | None,
    guide_type: str,
) -> str:
    """Slug URL-safe per la guida: `guida-{game}-{trophy?}-{type}`."""
    parts = ["guida", _slugify(game_name)]
    if trophy_name:
        parts.append(_slugify(trophy_name))
    parts.append(_slugify(guide_type))
    slug = "-".join(p for p in parts if p)
    # Collassa eventuali trattini doppi.
    return re.sub(r"-+", "-", slug).strip("-")


def _is_peak_hour(now: datetime | None = None) -> bool:
    """Peak hour CET: 18:00-23:59."""
    n = (now or datetime.now(tz=timezone.utc)).astimezone(_CET)
    return 18 <= n.hour <= 23


class Upserter:
    """Gestisce l'INSERT atomico di guida + fonti in una transazione."""

    def __init__(self, deduplicator: Deduplicator | None = None) -> None:
        self._dedup = deduplicator or Deduplicator()
        self._logger = logger

    # ── Games ────────────────────────────────────────────────────────────────

    async def find_or_create_game(self, game_name: str) -> int:
        """Trova il game per slug o alias; se non esiste, INSERT e ritorna l'id."""
        slug = _slugify(game_name)
        pool = await _get_pool()
        async with pool.connection() as conn:
            async with conn.cursor(row_factory=dict_row) as cur:
                # Match diretto per slug.
                await cur.execute(
                    "SELECT id FROM games WHERE slug = %s LIMIT 1",
                    (slug,),
                )
                row = await cur.fetchone()
                if row:
                    return int(row["id"])

                # Fuzzy match via game_aliases (case-insensitive).
                await cur.execute(
                    # Cerca in aliases un match esatto (case-insensitive) per game_name.
                    "SELECT game_id FROM game_aliases "
                    "WHERE lower(alias) = lower(%s) LIMIT 1",
                    (game_name,),
                )
                row = await cur.fetchone()
                if row:
                    return int(row["game_id"])

                # Non esiste: INSERT con title + slug.
                await cur.execute(
                    # Crea un nuovo game con slug univoco.
                    "INSERT INTO games (title, slug) VALUES (%s, %s) "
                    "ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title "
                    "RETURNING id",
                    (game_name, slug),
                )
                new_row = await cur.fetchone()
                return int(new_row["id"])  # type: ignore[index]

    # ── Trophies ─────────────────────────────────────────────────────────────

    async def find_or_create_trophy(
        self, game_id: int, trophy_name: str | None
    ) -> int | None:
        """Trova il trofeo per game_id + nome; None se trophy_name non è dato."""
        if not trophy_name or not trophy_name.strip():
            return None

        pool = await _get_pool()
        async with pool.connection() as conn:
            async with conn.cursor(row_factory=dict_row) as cur:
                # Match case-insensitive tramite ILIKE sul nome esatto.
                await cur.execute(
                    "SELECT id FROM trophies "
                    "WHERE game_id = %s AND name ILIKE %s "
                    "LIMIT 1",
                    (game_id, trophy_name),
                )
                row = await cur.fetchone()
                if row:
                    return int(row["id"])

                await cur.execute(
                    # Inserisce nuovo trofeo senza tipo/descrizione (enrichment successivo).
                    "INSERT INTO trophies (game_id, name) VALUES (%s, %s) RETURNING id",
                    (game_id, trophy_name.strip()),
                )
                new_row = await cur.fetchone()
                return int(new_row["id"])  # type: ignore[index]

    # ── Guide + sources (transazione) ────────────────────────────────────────

    async def upsert_guide(
        self,
        guide: dict,
        chunks: list[str],
        embeddings: list[list[float]],
        sources: list[dict],
    ) -> int | None:
        """UPSERT atomica di una guida con tracciabilità fonti.

        Argomenti `chunks` e `embeddings` sono accettati per contratto API ma
        NON vengono scritti qui (FF-NEW-3): l'embedding è del worker Node.

        Ritorna il guide_id in caso di successo, None se skip o errore.
        """
        game_name = guide.get("game_name", "") or ""
        trophy_name = guide.get("trophy_name")
        guide_type = guide.get("guide_type", "walkthrough")
        title = guide.get("title", "Untitled")
        content = guide.get("content", "")
        language = guide.get("language", "it")
        source = guide.get("source", "harvested")
        confidence_level = guide.get("confidence_level", "harvested")
        quality_score = float(guide.get("quality_score", 0.0))

        if not game_name or not content:
            self._logger.error(
                "upsert_guide: campi obbligatori mancanti",
                has_game=bool(game_name),
                has_content=bool(content),
            )
            return None

        slug = generate_slug(game_name, trophy_name, guide_type)

        pool = await _get_pool()
        try:
            async with pool.connection() as conn:
                # Autocommit=True nel pool: disabilitiamo per aprire una transazione.
                await conn.set_autocommit(False)
                try:
                    async with conn.cursor(row_factory=dict_row) as cur:
                        # ── Game / trophy ────────────────────────────────────
                        game_id = await self._find_or_create_game_tx(cur, game_name)
                        trophy_id = await self._find_or_create_trophy_tx(
                            cur, game_id, trophy_name
                        )

                        # ── Deduplicazione ────────────────────────────────────
                        await cur.execute(
                            # Ricarica lo stato guida esistente dentro la transazione.
                            # IS NOT DISTINCT FROM gestisce NULL-safe equality (NULL=NULL → TRUE).
                            # Cast ::integer necessario: psycopg3 non inferisce il tipo da NULL.
                            "SELECT id, confidence_level, quality_score "
                            "FROM guides "
                            "WHERE game_id = %s "
                            "AND trophy_id IS NOT DISTINCT FROM %s::integer "
                            "AND guide_type = %s "
                            "LIMIT 1",
                            (game_id, trophy_id, guide_type),
                        )
                        existing_row = await cur.fetchone()
                        existing = None
                        if existing_row:
                            existing = {
                                "id": existing_row["id"],
                                "confidence_level": existing_row.get(
                                    "confidence_level"
                                )
                                or "unverified",
                                "quality_score": float(
                                    existing_row.get("quality_score") or 0.0
                                ),
                            }

                        if not Deduplicator.should_upsert(existing, quality_score):
                            await conn.rollback()
                            self._logger.info(
                                "upsert skip",
                                reason="verified_or_lower_quality",
                                existing_id=existing["id"] if existing else None,
                            )
                            return None

                        # ── AUDIT FIX Fatal Flaw #2: mem + advisory lock ─────
                        await cur.execute("SET LOCAL maintenance_work_mem = '128MB'")
                        await cur.execute("SELECT pg_try_advisory_xact_lock(42)")
                        lock_row = await cur.fetchone()
                        lock_acquired = bool(
                            lock_row and list(lock_row.values())[0]
                        )

                        if not lock_acquired and _is_peak_hour():
                            await conn.rollback()
                            self._logger.warning(
                                "Peak hour, advisory lock busy — backoff",
                                game=game_name,
                                slug=slug,
                            )
                            return None

                        # ── UPSERT guides ────────────────────────────────────
                        await cur.execute(
                            # Upsert guida con protezione 'verified' nel WHERE.
                            "INSERT INTO guides ("
                            " game_id, trophy_id, title, slug, content, language,"
                            " guide_type, source, quality_score, confidence_level,"
                            " embedding_pending, updated_at"
                            ") VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,true,NOW()) "
                            "ON CONFLICT (slug) DO UPDATE SET "
                            " title = EXCLUDED.title,"
                            " content = EXCLUDED.content,"
                            " quality_score = EXCLUDED.quality_score,"
                            " confidence_level = EXCLUDED.confidence_level,"
                            " embedding_pending = true,"
                            " updated_at = NOW() "
                            "WHERE guides.confidence_level != 'verified' "
                            "RETURNING id",
                            (
                                game_id,
                                trophy_id,
                                title,
                                slug,
                                content,
                                language,
                                guide_type,
                                source,
                                quality_score,
                                confidence_level,
                            ),
                        )
                        row = await cur.fetchone()
                        if not row:
                            # WHERE ha bloccato l'UPDATE (verified) → no RETURNING.
                            await conn.rollback()
                            self._logger.info(
                                "upsert bloccato da WHERE verified-guard",
                                slug=slug,
                            )
                            return None
                        guide_id = int(row["id"])

                        # ── harvest_sources ──────────────────────────────────
                        for src in sources:
                            import json as _json

                            meta = src.get("metadata") or src.get("extra") or {}
                            await cur.execute(
                                # Insert tracciabilità fonte; ON CONFLICT aggiorna hash/timestamp.
                                # source_type e metadata preservati dal primo insert (no override
                                # su ON CONFLICT per non declassare community→primary su re-scrape).
                                "INSERT INTO harvest_sources ("
                                " guide_id, source_url, source_domain, "
                                " content_hash, raw_content_length,"
                                " source_type, metadata"
                                ") VALUES (%s,%s,%s,%s,%s,%s,%s) "
                                "ON CONFLICT (source_url) DO UPDATE SET "
                                " guide_id = EXCLUDED.guide_id,"
                                " content_hash = EXCLUDED.content_hash,"
                                " raw_content_length = EXCLUDED.raw_content_length,"
                                " scraped_at = NOW()",
                                (
                                    guide_id,
                                    src.get("source_url"),
                                    src.get("source_domain"),
                                    src.get("content_hash"),
                                    src.get("raw_content_length")
                                    or len(src.get("raw_content") or ""),
                                    src.get("source_type", "primary"),
                                    _json.dumps(meta),
                                ),
                            )

                        await conn.commit()

                        self._logger.info(
                            "guide upserted",
                            guide_id=guide_id,
                            game=game_name,
                            trophy=trophy_name,
                            quality=quality_score,
                            n_sources=len(sources),
                            n_chunks=len(chunks),
                        )
                        return guide_id

                except Exception:
                    await conn.rollback()
                    raise
                finally:
                    await conn.set_autocommit(True)

        except Exception as exc:
            self._logger.exception(
                "upsert_guide failed",
                error=str(exc),
                slug=slug,
            )
            return None

    # ── Helpers TX-scoped (riutilizzano il cursor della transazione) ─────────

    async def _find_or_create_game_tx(self, cur: Any, game_name: str) -> int:
        slug = _slugify(game_name)
        await cur.execute("SELECT id FROM games WHERE slug = %s LIMIT 1", (slug,))
        row = await cur.fetchone()
        if row:
            return int(row["id"])
        await cur.execute(
            "SELECT game_id FROM game_aliases WHERE lower(alias) = lower(%s) LIMIT 1",
            (game_name,),
        )
        row = await cur.fetchone()
        if row:
            return int(row["game_id"])
        await cur.execute(
            "INSERT INTO games (title, slug) VALUES (%s, %s) "
            "ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title RETURNING id",
            (game_name, slug),
        )
        row = await cur.fetchone()
        return int(row["id"])  # type: ignore[index]

    async def _find_or_create_trophy_tx(
        self, cur: Any, game_id: int, trophy_name: str | None
    ) -> int | None:
        if not trophy_name or not trophy_name.strip():
            return None
        await cur.execute(
            "SELECT id FROM trophies WHERE game_id = %s AND name ILIKE %s LIMIT 1",
            (game_id, trophy_name),
        )
        row = await cur.fetchone()
        if row:
            return int(row["id"])
        await cur.execute(
            "INSERT INTO trophies (game_id, name) VALUES (%s, %s) RETURNING id",
            (game_id, trophy_name.strip()),
        )
        row = await cur.fetchone()
        return int(row["id"])  # type: ignore[index]

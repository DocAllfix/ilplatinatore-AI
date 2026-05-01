"""TopicMapper — orchestrator per discovery + persistenza topic (Fase 24).

Dato un game_id, invoca i discoverers (boss/build/collectible/lore) e fa upsert
in `game_topics` con dedup multi-source.

Idempotente: re-eseguire su stesso game_id non duplica righe, accumula sorgenti.
Lo `priority` viene ricalcolato ad ogni upsert in funzione di discovered_from.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any

from src.config.db import execute, fetch_all, fetch_one
from src.config.logger import get_logger
from src.topics.priority_scorer import score_topic

logger = get_logger(__name__)


_SLUG_NON_WORD = re.compile(r"[^a-z0-9]+")
_SLUG_TRIM = re.compile(r"^-+|-+$")


def slugify_topic(name: str, max_len: int = 200) -> str:
    """Normalizza un topic_name in slug stabile per dedup DB.

    Es: "Malenia, Blade of Miquella" -> "malenia-blade-of-miquella".
    """
    s = name.strip().lower()
    s = _SLUG_NON_WORD.sub("-", s)
    s = _SLUG_TRIM.sub("", s)
    return s[:max_len] or "unnamed"


# Whitelist topic_type — deve restare allineata al CHECK constraint in migration 032.
_VALID_TYPES = {"boss", "build", "collectible", "lore", "puzzle"}


class TopicMapper:
    """Orchestratore della discovery di topic per i giochi in DB.

    I discoverers sono lazy-imported per consentire mock granulare nei test
    e per non importare httpx/BeautifulSoup quando non serve (CLI --help).
    """

    def __init__(self) -> None:
        self._discoverers: dict[str, Any] | None = None

    def _load_discoverers(self) -> dict[str, Any]:
        """Importa i discoverers la prima volta che servono (lazy)."""
        if self._discoverers is None:
            from src.topics.discoverers.boss_discoverer import BossDiscoverer
            from src.topics.discoverers.build_discoverer import BuildDiscoverer
            from src.topics.discoverers.collectible_discoverer import (
                CollectibleDiscoverer,
            )
            from src.topics.discoverers.lore_discoverer import LoreDiscoverer

            self._discoverers = {
                "boss": BossDiscoverer(),
                "build": BuildDiscoverer(),
                "collectible": CollectibleDiscoverer(),
                "lore": LoreDiscoverer(),
            }
        return self._discoverers

    async def upsert_topic(
        self,
        game_id: int,
        topic_type: str,
        topic_name: str,
        source: str,
    ) -> None:
        """Inserisce o aggiorna un topic, aggiungendo `source` a discovered_from.

        Ricalcola priority a ogni upsert (più sorgenti -> priorità migliore).
        """
        if topic_type not in _VALID_TYPES:
            logger.warning(
                "topic_type non valido, skip",
                topic_type=topic_type,
                topic_name=topic_name,
            )
            return

        slug = slugify_topic(topic_name)
        if not slug:
            return

        # Strategia: leggi sorgenti correnti, calcola merge + score, poi UPSERT.
        # Alternative array_cat lato SQL sarebbero più veloci ma ricalcolare priority
        # in DB richiederebbe una stored function — preferisco logica scorer in Python.
        existing = await fetch_one(
            "SELECT discovered_from FROM game_topics "
            "WHERE game_id = %s AND topic_type = %s AND topic_slug = %s",
            (game_id, topic_type, slug),
        )

        if existing:
            sources = sorted(set(existing["discovered_from"]) | {source})
        else:
            sources = [source]

        priority = score_topic(topic_type, topic_name, sources)

        await execute(
            "INSERT INTO game_topics (game_id, topic_type, topic_name, topic_slug, "
            "                         discovered_from, priority) "
            "VALUES (%s, %s, %s, %s, %s, %s) "
            "ON CONFLICT (game_id, topic_type, topic_slug) DO UPDATE "
            "SET discovered_from = EXCLUDED.discovered_from, "
            "    priority = EXCLUDED.priority, "
            "    topic_name = EXCLUDED.topic_name",
            (game_id, topic_type, topic_name, slug, sources, priority),
        )

    async def discover_for_game(
        self,
        game_id: int,
        game_slug: str,
        types: list[str] | None = None,
    ) -> dict[str, int]:
        """Esegue i discoverers per un singolo gioco e fa upsert dei risultati.

        Args:
            game_id: PK in tabella games
            game_slug: slug usato per costruire URL (es. "elden-ring")
            types: subset di tipi da scoprire; default tutti.

        Returns:
            Stats dict {tipo -> numero topic upsertati}.
        """
        discoverers = self._load_discoverers()
        target_types = types or list(discoverers.keys())
        stats: dict[str, int] = {}

        for topic_type in target_types:
            if topic_type not in discoverers:
                continue
            try:
                discoveries = await discoverers[topic_type].discover(game_slug)
            except Exception as exc:
                logger.warning(
                    "discoverer fallito",
                    topic_type=topic_type,
                    game_id=game_id,
                    game_slug=game_slug,
                    error=str(exc),
                )
                stats[topic_type] = 0
                continue

            count = 0
            for name, source in discoveries:
                try:
                    await self.upsert_topic(game_id, topic_type, name, source)
                    count += 1
                except Exception as exc:
                    logger.warning(
                        "upsert topic fallito",
                        game_id=game_id,
                        topic_type=topic_type,
                        topic_name=name,
                        error=str(exc),
                    )
            stats[topic_type] = count
            logger.info(
                "discovery completata",
                game_id=game_id,
                game_slug=game_slug,
                topic_type=topic_type,
                count=count,
            )
        return stats

    async def discover_all(
        self,
        parallelism: int = 3,
        limit: int | None = None,
    ) -> dict[int, dict[str, int]]:
        """Discovery su tutti i giochi in DB (con cap opzionale)."""
        if limit:
            rows = await fetch_all(
                "SELECT id, slug FROM games ORDER BY id ASC LIMIT %s",
                (int(limit),),
            )
        else:
            rows = await fetch_all("SELECT id, slug FROM games ORDER BY id ASC")

        sem = asyncio.Semaphore(parallelism)
        results: dict[int, dict[str, int]] = {}

        async def _one(game_id: int, game_slug: str) -> None:
            async with sem:
                results[game_id] = await self.discover_for_game(game_id, game_slug)

        await asyncio.gather(
            *[_one(r["id"], r["slug"]) for r in rows],
        )
        return results

    async def list_pending(
        self,
        game_id: int | None = None,
        topic_type: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """Lista topic con guide_generated=false ordinati per priority crescente."""
        where = ["guide_generated = false"]
        params: list[Any] = []
        if game_id is not None:
            where.append("game_id = %s")
            params.append(game_id)
        if topic_type is not None:
            where.append("topic_type = %s")
            params.append(topic_type)
        params.append(limit)
        sql = (
            "SELECT id, game_id, topic_type, topic_name, topic_slug, "
            "       discovered_from, priority, created_at "
            "FROM game_topics WHERE " + " AND ".join(where) + " "
            "ORDER BY priority ASC, created_at ASC LIMIT %s"
        )
        return await fetch_all(sql, tuple(params))

    async def mark_generated(self, topic_id: int, guide_id: int) -> None:
        """Segna un topic come generato e lo collega alla guide_id prodotta."""
        await execute(
            "UPDATE game_topics "
            "SET guide_generated = true, generated_guide_id = %s "
            "WHERE id = %s",
            (guide_id, topic_id),
        )

"""HarvestPipeline — orchestratore che connette collector → transformer → injector.

Modalità batch: parte, processa il seed, si ferma.
Advisory lock (99) impedisce due istanze concorrenti.
Persistenza offset (harvest_progress) per restart idempotente.
"""

from __future__ import annotations

import time
from pathlib import Path
from urllib.parse import urlparse

from src.collectors.base import BaseCollector
from src.collectors.powerpyx import PowerPyxCollector
from src.collectors.psnprofiles import PSNProfilesCollector
from src.collectors.trueachievements import TrueAchievementsCollector
from src.config.db import _get_pool
from src.config.logger import get_logger
from src.discovery.seed_loader import SeedLoader
from src.injector.chunker import chunk_content
from src.injector.deduplicator import Deduplicator
from src.injector.embedder import Embedder
from src.injector.upserter import Upserter
from src.transformer.quality import calculate_quality_score
from src.transformer.synthesizer import GuideSynthesizer

_QUALITY_THRESHOLD = 0.4
_ADVISORY_LOCK_ID = 99

logger = get_logger("HarvestPipeline")


class HarvestPipeline:
    """Orchestra la pipeline completa: collect → transform → inject."""

    def __init__(self) -> None:
        self._seed_loader = SeedLoader()
        # Dizionario dei collector attivi: chiave = nome, valore = istanza.
        self._collectors: dict[str, BaseCollector] = {
            "powerpyx": PowerPyxCollector(),
            "psnprofiles": PSNProfilesCollector(),
            "trueachievements": TrueAchievementsCollector(),
        }
        self._synthesizer = GuideSynthesizer()
        self._deduplicator = Deduplicator()
        self._embedder = Embedder()
        self._upserter = Upserter(deduplicator=self._deduplicator)
        self._logger = logger

        # Contatori.
        self.guides_processed: int = 0
        self.guides_injected: int = 0
        self.guides_skipped: int = 0
        self.guides_failed: int = 0

    # ── Single guide ─────────────────────────────────────────────────────────

    async def process_single_guide(
        self,
        game_name: str,
        trophy_name: str | None,
        source_urls: list[str],
    ) -> bool:
        """Processa una singola guida end-to-end. Ritorna True se iniettata."""
        self.guides_processed += 1

        # STEP 1: Collect da tutte le sorgenti.
        # Il collector corretto viene scelto in base al dominio dell'URL.
        collected: list[dict] = []
        for url in source_urls:
            try:
                collector = self._get_collector_for_url(url)
                if collector is None:
                    self._logger.warning(
                        "nessun collector per URL, skip",
                        url=url[:100],
                    )
                    continue
                result = await collector.collect(url)
                if result is not None:
                    collected.append(result)
            except Exception as exc:
                self._logger.error(
                    "collect fallito",
                    url=url[:100],
                    error=str(exc),
                )

        if not collected:
            self._logger.warning(
                "nessun contenuto raccolto",
                game=game_name,
                trophy=trophy_name,
                urls=len(source_urls),
            )
            self.guides_failed += 1
            return False

        # STEP 2: Deduplicazione sorgenti.
        all_already_processed = True
        for src in collected:
            src_url = src.get("source_url", "")
            src_hash = src.get("content_hash", "")
            try:
                already = await self._deduplicator.source_already_processed(
                    src_url, src_hash
                )
                if not already:
                    all_already_processed = False
                    break
            except Exception as exc:
                self._logger.error(
                    "dedup check fallito",
                    url=src_url[:100],
                    error=str(exc),
                )
                all_already_processed = False
                break

        if all_already_processed:
            self._logger.info(
                "tutte le sorgenti già processate, skip",
                game=game_name,
                trophy=trophy_name,
            )
            self.guides_skipped += 1
            return False

        # STEP 3: Transform (Gemini extract_facts + synthesize_guide).
        raw_contents = [src.get("raw_content", "") for src in collected]
        try:
            guide = await self._synthesizer.transform(
                raw_contents,
                game_name,
                trophy_name or "",
            )
        except Exception as exc:
            self._logger.error(
                "transform fallito",
                game=game_name,
                trophy=trophy_name,
                error=str(exc),
            )
            self.guides_failed += 1
            return False

        if guide is None:
            self._logger.warning(
                "transform ritornato None",
                game=game_name,
                trophy=trophy_name,
            )
            self.guides_failed += 1
            return False

        # STEP 4: Quality check.
        quality = calculate_quality_score(guide)
        guide["quality_score"] = quality

        if quality < _QUALITY_THRESHOLD:
            self._logger.warning(
                "qualità insufficiente, scartata",
                game=game_name,
                trophy=trophy_name,
                quality=quality,
                threshold=_QUALITY_THRESHOLD,
            )
            self.guides_skipped += 1
            return False

        # STEP 5: Chunk.
        chunks = chunk_content(
            guide.get("content", ""),
            title=guide.get("title", "Untitled"),
        )

        # STEP 6: Embedding.
        try:
            embeddings = await self._embedder.embed_batch(chunks)
        except Exception as exc:
            self._logger.error(
                "embedding fallito",
                game=game_name,
                trophy=trophy_name,
                error=str(exc),
            )
            self.guides_failed += 1
            return False

        if embeddings is None:
            self._logger.warning(
                "embedding ritornato None (quota?)",
                game=game_name,
                trophy=trophy_name,
            )
            self.guides_failed += 1
            return False

        # STEP 7: Upsert.
        sources_meta = [
            {
                "source_url": src.get("source_url"),
                "source_domain": src.get("source_domain"),
                "content_hash": src.get("content_hash"),
                "raw_content_length": len(src.get("raw_content") or ""),
            }
            for src in collected
        ]

        try:
            guide_id = await self._upserter.upsert_guide(
                guide, chunks, embeddings, sources_meta
            )
        except Exception as exc:
            self._logger.error(
                "upsert fallito",
                game=game_name,
                trophy=trophy_name,
                error=str(exc),
            )
            self.guides_failed += 1
            return False

        if guide_id is None:
            self._logger.info(
                "upsert skip (dedup/verified)",
                game=game_name,
                trophy=trophy_name,
            )
            self.guides_skipped += 1
            return False

        self._logger.info(
            "guida iniettata con successo",
            guide_id=guide_id,
            game=game_name,
            trophy=trophy_name,
            quality=quality,
            chunks=len(chunks),
        )
        self.guides_injected += 1
        return True

    # ── Seed batch ───────────────────────────────────────────────────────────

    async def run_seed_batch(self, seed_file: str) -> dict:
        """Processa tutti i giochi del seed file con advisory lock singleton.

        Ritorna statistiche del batch.
        """
        start_time = time.monotonic()
        pool = await _get_pool()

        # AUDIT FIX (R6-3): advisory lock session-level impedisce concorrenza.
        lock_conn = await pool.getconn()
        try:
            result = await lock_conn.execute(
                # Tenta di acquisire un advisory lock session-level (lock 99).
                "SELECT pg_try_advisory_lock(%s)",
                (_ADVISORY_LOCK_ID,),
            )
            acquired = (await result.fetchone())[0]  # type: ignore[index]
            if not acquired:
                self._logger.warning(
                    "Another harvester instance running (advisory_lock 99 busy). "
                    "Exiting gracefully.",
                )
                await pool.putconn(lock_conn)
                return {
                    "processed": 0,
                    "injected": 0,
                    "skipped": 0,
                    "failed": 0,
                    "skipped_reason": "another_instance_running",
                    "resumed_from": None,
                    "duration_seconds": 0,
                }

            # Carica seed.
            games = self._seed_loader.load_seed_file(seed_file)

            # AUDIT FIX (R5-4): Leggi ultimo slug processato per restart idempotente.
            resumed_from = await self._get_last_processed_slug(seed_file)
            skip_mode = resumed_from is not None

            for game in games:
                slug = game.get("slug", "")
                title = game.get("title", "")

                # Se in skip_mode, salta fino a raggiungere il punto di ripresa.
                if skip_mode:
                    if slug == resumed_from:
                        skip_mode = False
                        self._logger.info(
                            "ripresa dal punto salvato",
                            slug=slug,
                        )
                    continue

                if not title or not slug:
                    continue

                # Costruisci URL da fonti multiple per lo stesso gioco.
                # PSNProfiles richiede un ID numerico non disponibile nel seed:
                # viene saltata finché non sarà disponibile un endpoint di discovery.
                urls = [
                    f"https://powerpyx.com/{slug}-trophy-guide/",
                    f"https://www.trueachievements.com/game/{slug}/achievements",
                ]
                await self.process_single_guide(title, None, urls)

                # Persisti progresso dopo ogni gioco.
                await self._save_progress(seed_file, slug)

                # AUDIT FIX (W-ARCH-2): Heartbeat.
                _touch_heartbeat()

            # Batch completato: resetta per il prossimo ciclo.
            await self._reset_progress(seed_file)

        finally:
            # Rilascia advisory lock e restituisci connessione al pool.
            try:
                await lock_conn.execute(
                    # Rilascia l'advisory lock session-level.
                    "SELECT pg_advisory_unlock(%s)",
                    (_ADVISORY_LOCK_ID,),
                )
            except Exception:
                pass
            await pool.putconn(lock_conn)

        duration = round(time.monotonic() - start_time, 1)
        stats = {
            "processed": self.guides_processed,
            "injected": self.guides_injected,
            "skipped": self.guides_skipped,
            "failed": self.guides_failed,
            "resumed_from": resumed_from,
            "duration_seconds": duration,
        }
        self._logger.info("run_seed_batch completato", **stats)
        return stats

    # ── Progress persistence (R5-4) ─────────────────────────────────────────

    async def _get_last_processed_slug(self, seed_file: str) -> str | None:
        """Legge l'ultimo slug processato dal DB."""
        from src.config.db import fetch_one

        row = await fetch_one(
            # Recupera ultimo slug processato per restart idempotente.
            "SELECT last_seed_slug FROM harvest_progress "
            "WHERE seed_file = %s AND last_seed_slug IS NOT NULL",
            (seed_file,),
        )
        if row:
            return row.get("last_seed_slug")
        return None

    async def _save_progress(self, seed_file: str, slug: str) -> None:
        """Salva il progresso corrente nel DB."""
        from src.config.db import execute

        await execute(
            # Upsert progresso: salva ultimo slug processato.
            "INSERT INTO harvest_progress "
            "(seed_file, last_seed_slug, total_processed, total_failed) "
            "VALUES (%s, %s, %s, %s) "
            "ON CONFLICT (seed_file) DO UPDATE SET "
            "last_seed_slug = EXCLUDED.last_seed_slug, "
            "last_seen_at = NOW(), "
            "total_processed = EXCLUDED.total_processed, "
            "total_failed = EXCLUDED.total_failed",
            (seed_file, slug, self.guides_processed, self.guides_failed),
        )

    async def _reset_progress(self, seed_file: str) -> None:
        """Resetta il progresso dopo un batch completato con successo."""
        from src.config.db import execute

        await execute(
            # Resetta per il prossimo ciclo.
            "UPDATE harvest_progress SET last_seed_slug = NULL, last_seen_at = NOW() "
            "WHERE seed_file = %s",
            (seed_file,),
        )

    # ── Collector dispatch ────────────────────────────────────────────────────

    def _get_collector_for_url(self, url: str) -> BaseCollector | None:
        """Seleziona il collector corretto in base al dominio dell'URL.

        Usa match esatto o subdomain: evita false positives da substring
        (es. "fake-trueachievements.com" non deve matchare "trueachievements.com").
        """
        try:
            netloc = urlparse(url).netloc
        except (ValueError, AttributeError):
            return None

        # Normalizza: rimuovi prefisso "www." se presente.
        # Non usare lstrip("www.") — strip per carattere, non per prefisso.
        if netloc.startswith("www."):
            netloc = netloc[4:]

        for collector in self._collectors.values():
            # Accetta: dominio esatto OPPURE sottodominio (es. "m.psnprofiles.com").
            if netloc == collector.domain or netloc.endswith("." + collector.domain):
                return collector
        return None

    # ── Cleanup ──────────────────────────────────────────────────────────────

    async def cleanup(self) -> None:
        """Chiude tutti i client HTTP."""
        for name, collector in self._collectors.items():
            try:
                await collector.close()
            except Exception as exc:
                self._logger.error(
                    "collector close fallito", collector=name, error=str(exc)
                )


def _touch_heartbeat() -> None:
    """Heartbeat file per Docker healthcheck (W-ARCH-2)."""
    try:
        Path("/tmp/harvester_heartbeat").touch()
    except OSError:
        pass

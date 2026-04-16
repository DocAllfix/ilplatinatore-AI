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
from src.collectors.fandom import FandomCollector
from src.collectors.fextralife import FextralifeCollector
from src.collectors.ign import IGNCollector
from src.collectors.powerpyx import PowerPyxCollector
from src.collectors.psnprofiles import PSNProfilesCollector
from src.collectors.reddit import RedditCollector
from src.collectors.steam_community import SteamCommunityGuidesCollector
from src.collectors.trueachievements import TrueAchievementsCollector
from src.collectors.youtube import YouTubeCollector
from src.config.db import _get_pool
from src.config.logger import get_logger
from src.discovery.seed_loader import SeedLoader
from src.injector.chunker import chunk_content
from src.injector.deduplicator import Deduplicator
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
            "fextralife": FextralifeCollector(),
            "ign": IGNCollector(),
            "reddit": RedditCollector(),
            "steam_community": SteamCommunityGuidesCollector(),
            "youtube": YouTubeCollector(),
            "fandom": FandomCollector(),
        }
        self._synthesizer = GuideSynthesizer()
        self._deduplicator = Deduplicator()
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
        guide_type_override: str | None = None,
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

        # STEP 3: Transform (LLM extract_facts + synthesize_guide).
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

        # Override guide_type se richiesto (boss/build/meta/lore/faq).
        # Il synthesizer hardcoda "trophy" nel suo output; i metodi dedicati
        # (process_boss_guides, process_with_reddit) usano questo hook per
        # mantenere la distinzione semantica in DB.
        if guide_type_override is not None:
            guide["guide_type"] = guide_type_override

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

        # STEP 5: Chunk (per contratto API con upserter; embedding gestito da worker Node).
        chunks = chunk_content(
            guide.get("content", ""),
            title=guide.get("title", "Untitled"),
        )

        # STEP 6: Upsert (FF-NEW-3: embedding_pending=true, worker Node farà gli embedding).
        sources_meta = [
            {
                "source_url": src.get("source_url"),
                "source_domain": src.get("source_domain"),
                "content_hash": src.get("content_hash"),
                "raw_content_length": len(src.get("raw_content") or ""),
                "source_type": src.get("source_type", "primary"),
                "metadata": src.get("extra", {}),
            }
            for src in collected
        ]

        try:
            guide_id = await self._upserter.upsert_guide(
                guide, chunks, [], sources_meta
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

    # ── Guide granulari (boss / build via Fextralife + IGN) ─────────────────

    async def process_boss_guides(
        self,
        game_id: int,
        boss_names: list[str] | None = None,
    ) -> dict:
        """Genera guide boss per un gioco usando Fextralife + IGN.

        Se boss_names è None, prova a leggerli da game_topics
        (tabella opzionale, migration Fase 24). Se la tabella non esiste,
        logga warning e ritorna stats vuote.

        Ritorna {'processed': N, 'injected': N, 'failed': N}.
        """
        from src.config.db import fetch_all, fetch_one

        stats = {"processed": 0, "injected": 0, "failed": 0}

        # Recupera slug gioco per costruire URL.
        row = await fetch_one(
            # Recupera titolo + slug per costruire URL Fextralife/IGN.
            "SELECT title, slug FROM games WHERE id = %s",
            (game_id,),
        )
        if not row:
            self._logger.warning("process_boss_guides: game_id non trovato", game_id=game_id)
            return stats

        game_title = row.get("title", "")
        game_slug = row.get("slug", "") or _slugify(game_title)

        # Se non passati esplicitamente, prova a leggere da game_topics.
        if boss_names is None:
            try:
                topic_rows = await fetch_all(
                    # Legge boss non ancora processati per questo gioco.
                    "SELECT topic_name FROM game_topics "
                    "WHERE game_id = %s AND topic_type = 'boss' "
                    "AND guide_generated = false "
                    "ORDER BY priority ASC LIMIT 50",
                    (game_id,),
                )
                boss_names = [r["topic_name"] for r in topic_rows]
            except Exception as exc:
                self._logger.warning(
                    "game_topics non disponibile (migration Fase 24 non applicata?), "
                    "nessun boss_names fornito → skip",
                    error=str(exc),
                )
                return stats

        if not boss_names:
            self._logger.info(
                "process_boss_guides: nessun boss da processare", game_id=game_id
            )
            return stats

        for boss in boss_names:
            boss_slug = _slugify(boss)
            urls = [
                f"https://wiki.fextralife.com/{game_slug}/{boss_slug}",
                f"https://www.ign.com/wikis/{game_slug}/{boss_slug}",
            ]
            ok = await self.process_single_guide(
                game_name=game_title,
                trophy_name=boss,  # riusato come "topic" per il synthesizer
                source_urls=urls,
                guide_type_override="boss",
            )
            stats["processed"] += 1
            if ok:
                stats["injected"] += 1
            else:
                stats["failed"] += 1

        self._logger.info("process_boss_guides completato", game_id=game_id, **stats)
        return stats

    async def process_with_reddit(
        self,
        game_id: int,
        subreddit: str,
        queries: list[str] | None = None,
    ) -> dict:
        """Arricchisce guide con community tips da Reddit.

        Per ogni query (default: meta/build/tips), cerca nel subreddit,
        aggrega i post top e iniette come guida di tipo 'meta'.

        Ritorna {'processed': N, 'injected': N, 'failed': N}.
        """
        from src.config.db import fetch_one

        stats = {"processed": 0, "injected": 0, "failed": 0}

        row = await fetch_one(
            # Titolo gioco per nomenclatura e prompt synthesizer.
            "SELECT title FROM games WHERE id = %s",
            (game_id,),
        )
        if not row:
            self._logger.warning(
                "process_with_reddit: game_id non trovato", game_id=game_id
            )
            return stats
        game_title = row.get("title", "")

        if queries is None:
            queries = [
                f"{game_title} best build",
                f"{game_title} tips tricks",
                f"{game_title} meta guide",
            ]

        reddit = self._collectors.get("reddit")
        if not isinstance(reddit, RedditCollector):
            self._logger.error("RedditCollector non registrato")
            return stats

        for q in queries:
            try:
                posts = await reddit.search_subreddit(subreddit, q, limit=5)
            except Exception as exc:
                self._logger.error(
                    "reddit search fallita",
                    subreddit=subreddit,
                    query=q,
                    error=str(exc),
                )
                stats["failed"] += 1
                continue

            if not posts:
                self._logger.debug(
                    "reddit: nessun post", subreddit=subreddit, query=q
                )
                continue

            aggregated = "\n\n---\n\n".join(
                reddit.format_for_llm(p) for p in posts
            )
            if len(aggregated) < 200:
                continue

            # Inietta come singola guida 'meta' passando contenuto già aggregato.
            # Riusiamo process_single_guide inventando un URL pseudo-sorgente
            # stabile per dedup (hash-based).
            pseudo_url = (
                f"https://www.reddit.com/r/{subreddit}/search?q={q.replace(' ', '+')}"
            )
            from src.collectors.base import compute_hash

            synthetic = {
                "title": f"Reddit /r/{subreddit}: {q}",
                "game_name": game_title,
                "trophy_name": None,
                "guide_type": "meta",
                "raw_content": aggregated[:15_000],
                "source_url": pseudo_url,
                "source_domain": "reddit.com",
                "content_hash": compute_hash(aggregated),
            }

            stats["processed"] += 1
            ok = await self._inject_synthetic(synthetic, game_title, q)
            if ok:
                stats["injected"] += 1
            else:
                stats["failed"] += 1

        self._logger.info(
            "process_with_reddit completato",
            game_id=game_id,
            subreddit=subreddit,
            **stats,
        )
        return stats

    async def process_steam_community_guides(
        self,
        game_id: int,
        limit: int = 5,
    ) -> dict:
        """Discovery + collect di Steam Community Guides per un gioco.

        Richiede `games.steam_appid` popolato (Fase 24/IGDB enrichment).
        Ritorna {'processed': N, 'injected': N, 'failed': N, 'skipped': N}.
        """
        from src.config.db import fetch_one

        stats = {"processed": 0, "injected": 0, "failed": 0, "skipped": 0}

        row = await fetch_one(
            # Recupera title + steam_appid per discovery Steam.
            "SELECT title, steam_appid FROM games WHERE id = %s",
            (game_id,),
        )
        if not row:
            self._logger.warning(
                "process_steam_community_guides: game_id non trovato",
                game_id=game_id,
            )
            return stats

        appid = row.get("steam_appid")
        if not appid:
            self._logger.info(
                "process_steam_community_guides: steam_appid mancante, skip",
                game_id=game_id,
            )
            return stats
        game_title = row.get("title", "")

        steam = self._collectors.get("steam_community")
        if not isinstance(steam, SteamCommunityGuidesCollector):
            self._logger.error("SteamCommunityGuidesCollector non registrato")
            return stats

        try:
            guides = await steam.discover_guides(int(appid), limit=limit)
        except Exception as exc:
            self._logger.error(
                "steam discover_guides fallito",
                game_id=game_id,
                appid=appid,
                error=str(exc),
            )
            return stats

        for g in guides:
            stats["processed"] += 1
            try:
                body = await steam.fetch(g["detail_url"])
                if body is None:
                    stats["failed"] += 1
                    continue
                src = await steam.extract(body, g["detail_url"])
            except Exception as exc:
                self._logger.error(
                    "steam extract fallito",
                    pid=g.get("publishedfileid"),
                    error=str(exc),
                )
                stats["failed"] += 1
                continue

            if src is None:
                stats["skipped"] += 1
                continue

            ok = await self._inject_synthetic(
                src,
                game_title,
                src.get("title") or "Steam Guide",
                guide_type=src.get("guide_type") or "walkthrough",
            )
            if ok:
                stats["injected"] += 1
            else:
                stats["skipped"] += 1

        self._logger.info(
            "process_steam_community_guides completato",
            game_id=game_id,
            appid=appid,
            **stats,
        )
        return stats

    async def process_youtube_guides(
        self,
        game_id: int,
        queries: list[str] | None = None,
        limit: int = 3,
        guide_type_override: str | None = None,
    ) -> dict:
        """Discovery + inject di guide video YouTube per un gioco.

        Per ogni query (default: trophy guide + boss guide + walkthrough),
        cerca i top video, ottiene il transcript, e inietta come guida.

        Richiede YOUTUBE_API_KEY configurato. Usa quota YouTube Data API v3:
        ~101 units/query → default 3 query = ~303 units/game.

        Ritorna {'processed': N, 'injected': N, 'failed': N, 'skipped': N}.
        """
        from src.config.db import fetch_one

        stats = {"processed": 0, "injected": 0, "failed": 0, "skipped": 0}

        row = await fetch_one(
            # Recupera titolo gioco per costruire le query YouTube.
            "SELECT title FROM games WHERE id = %s",
            (game_id,),
        )
        if not row:
            self._logger.warning(
                "process_youtube_guides: game_id non trovato", game_id=game_id
            )
            return stats
        game_title = row.get("title", "")

        yt = self._collectors.get("youtube")
        if not isinstance(yt, YouTubeCollector):
            self._logger.error("YouTubeCollector non registrato")
            return stats

        if queries is None:
            queries = [
                f"{game_title} all trophies trophy guide",
                f"{game_title} platinum guide",
                f"{game_title} boss guide walkthrough",
            ]

        seen_video_ids: set[str] = set()

        for q in queries:
            try:
                videos = await yt.search_videos(q, limit=limit)
            except Exception as exc:
                self._logger.error(
                    "youtube search fallita", query=q[:80], error=str(exc)
                )
                stats["failed"] += 1
                continue

            if not videos:
                continue

            for v in videos:
                video_id = v["video_id"]
                if video_id in seen_video_ids:
                    continue
                seen_video_ids.add(video_id)
                stats["processed"] += 1

                try:
                    transcript = await yt.get_transcript(video_id)
                except Exception as exc:
                    self._logger.warning(
                        "youtube transcript fallito",
                        video_id=video_id,
                        error=str(exc),
                    )
                    stats["failed"] += 1
                    continue

                if transcript is None:
                    stats["skipped"] += 1
                    continue

                attrib_url = f"https://www.youtube.com/watch?v={video_id}"
                extra = {
                    "youtube_video_id": video_id,
                    "youtube_title": v.get("title", ""),
                    "youtube_channel_title": v.get("channel_title", ""),
                    "youtube_channel_id": v.get("channel_id", ""),
                    "youtube_view_count": v.get("view_count", 0),
                    "youtube_duration_seconds": v.get("duration_seconds", 0),
                    "youtube_published_at": v.get("published_at", ""),
                }

                src = await yt.extract(transcript, attrib_url, extra=extra)
                if src is None:
                    stats["skipped"] += 1
                    continue

                determined_type = guide_type_override or src.get("guide_type") or "walkthrough"
                src["guide_type"] = determined_type

                ok = await self._inject_synthetic(
                    src,
                    game_title,
                    v.get("title") or q,
                    guide_type=determined_type,
                )
                if ok:
                    stats["injected"] += 1
                else:
                    stats["skipped"] += 1

        self._logger.info(
            "process_youtube_guides completato",
            game_id=game_id,
            quota_used=yt._quota_used,
            **stats,
        )
        return stats

    async def process_fandom_content(
        self,
        game_id: int,
        pages: list[str] | None = None,
        wiki_subdomain: str | None = None,
        limit: int = 10,
    ) -> dict[str, int]:
        """Raccoglie contenuti wiki da Fandom per un gioco.

        Se `wiki_subdomain` è fornito, usa search_wiki per trovare pagine.
        Se `pages` è fornito, le raccoglie direttamente.
        Entrambi possono essere usati insieme.
        """
        stats: dict[str, int] = {"fetched": 0, "injected": 0, "skipped": 0}

        pool = await _get_pool()
        async with pool.connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    # Recupera nome del gioco per query semantica.
                    "SELECT title FROM games WHERE id = %s LIMIT 1",
                    (game_id,),
                )
                row = await cur.fetchone()

        if not row:
            self._logger.warning(
                "process_fandom_content: game_id non trovato", game_id=game_id
            )
            return stats

        game_name: str = row[0]
        fandom: FandomCollector = self._collectors["fandom"]  # type: ignore[assignment]

        # Candidati: pagine esplicite + risultati di ricerca.
        candidate_pages: list[tuple[str, str]] = []  # (subdomain, title)

        if pages and wiki_subdomain:
            for p in pages:
                candidate_pages.append((wiki_subdomain, p))

        if wiki_subdomain:
            queries = [game_name, f"{game_name} boss guide", f"{game_name} weapon build"]
            for query in queries:
                titles = await fandom.search_wiki(wiki_subdomain, query, limit=limit)
                for t in titles:
                    entry = (wiki_subdomain, t)
                    if entry not in candidate_pages:
                        candidate_pages.append(entry)

        # Deduplicazione URL già visti in questo run.
        seen_urls: set[str] = set()

        for subdomain, title in candidate_pages:
            page_data = await fandom.fetch_page(subdomain, title)
            if not page_data:
                stats["skipped"] += 1
                continue

            page_url = page_data["page_url"]
            if page_url in seen_urls:
                stats["skipped"] += 1
                continue
            seen_urls.add(page_url)

            stats["fetched"] += 1

            raw = await fandom.extract(
                page_data["html_text"],
                page_url,
                categories=page_data["categories"],
                page_title=page_data["page_title"],
            )
            if not raw:
                stats["skipped"] += 1
                continue

            injected = await self._inject_synthetic(
                raw,
                game_name=game_name,
                topic=raw.get("topic") or title,
                guide_type=raw.get("guide_type", "walkthrough"),
            )
            if injected:
                stats["injected"] += 1
            else:
                stats["skipped"] += 1

        self._logger.info(
            "process_fandom_content completato",
            game_id=game_id,
            wiki_subdomain=wiki_subdomain,
            **stats,
        )
        return stats

    async def _inject_synthetic(
        self,
        src: dict,
        game_name: str,
        topic: str,
        guide_type: str = "meta",
    ) -> bool:
        """Inietta un contenuto già raccolto (bypass collect step).

        Include dedup check su (source_url, content_hash) per evitare
        duplicati su re-run dello stesso `process_with_reddit`.
        """
        # Dedup: skip se questa fonte (hash) è già stata processata.
        src_url = src.get("source_url", "")
        src_hash = src.get("content_hash", "")
        try:
            already = await self._deduplicator.source_already_processed(
                src_url, src_hash
            )
            if already:
                self._logger.info(
                    "synthetic già processato, skip",
                    url=src_url[:100],
                )
                return False
        except Exception as exc:
            self._logger.warning(
                "dedup check synthetic fallito, procedo comunque",
                error=str(exc),
            )

        try:
            guide = await self._synthesizer.transform(
                [src["raw_content"]], game_name, topic
            )
        except Exception as exc:
            self._logger.error(
                "synthetic transform fallito", game=game_name, error=str(exc)
            )
            return False
        if guide is None:
            return False

        # Override guide_type (synthesizer hardcoda "trophy").
        guide["guide_type"] = guide_type

        quality = calculate_quality_score(guide)
        guide["quality_score"] = quality
        if quality < _QUALITY_THRESHOLD:
            return False

        chunks = chunk_content(
            guide.get("content", ""), title=guide.get("title", "Untitled")
        )
        sources_meta = [
            {
                "source_url": src.get("source_url"),
                "source_domain": src.get("source_domain"),
                "content_hash": src.get("content_hash"),
                "raw_content_length": len(src.get("raw_content") or ""),
                "source_type": src.get("source_type", "community"),
                "metadata": src.get("extra", {}),
            }
        ]
        try:
            guide_id = await self._upserter.upsert_guide(
                guide, chunks, [], sources_meta
            )
        except Exception as exc:
            self._logger.error("synthetic upsert fallito", error=str(exc))
            return False
        return guide_id is not None

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


def _slugify(name: str) -> str:
    """Converte 'Elden Ring' → 'elden-ring' (URL slug conservativo)."""
    import re as _re

    s = name.strip().lower()
    s = _re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


def _touch_heartbeat() -> None:
    """Heartbeat file per Docker healthcheck (W-ARCH-2)."""
    try:
        Path("/tmp/harvester_heartbeat").touch()
    except OSError:
        pass

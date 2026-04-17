"""Genera guide per-trofeo (platinum + gold) per i top 20 giochi con trofei PSN.

Pipeline search-first con esecuzione parallela:
  1. Query DB → top 20 giochi per numero di trofei plat+gold (con psn_communication_id)
  2. Per ogni gioco (2 giochi in parallelo):
     a. SCOPERTA FONTI (parallela):
        - Cerca su DuckDuckGo "{game} trophy guide" → URL reali su domini noti
        - Fetcha tutti gli URL trovati IN PARALLELO → estrae sezioni per-trofeo
        - Match sezioni → trophy names (fuzzy)
     b. Per ogni trofeo platinum/gold (batch di 4 in parallelo):
        - PSNProfiles + Reddit fetched IN PARALLELO
        - Fonte 1: descrizione ufficiale PSN
        - Fonte 2: PSNProfiles per-trofeo (spesso 403, handled gracefully)
        - Fonte 3–N: sezioni matchate dalle guide trovate via search
        - Fonte extra: Reddit r/Trophies community tips
        - Sintesi via GuideSynthesizer
        - Upsert in guides con trophy_id
  3. Log finale: trofei coperti vs non coperti per gioco

Guide in inglese (language='en'). Traduzione on-demand via backend (Fase 20).

Uso:
    cd il-platinatore-ai/harvester
    python scripts/run_trophy_guides_top20.py
    python scripts/run_trophy_guides_top20.py --dry-run   # mostra piano, no sintesi
    python scripts/run_trophy_guides_top20.py --game-id 16  # solo un gioco
    python scripts/run_trophy_guides_top20.py --concurrency 3  # giochi in parallelo
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import re
import sys
import unicodedata
from pathlib import Path
from urllib.parse import urlparse

import httpx

sys.path.insert(0, str(Path(__file__).parent.parent))

# ── Costanti ──────────────────────────────────────────────────────────────────

_PSNPROFILES_TROPHY_URL = (
    "https://psnprofiles.com/trophy/{comm_id}-{game_slug}/{trophy_id}-{trophy_slug}"
)

# Semaphore: max richieste HTTP parallele globali.
_HTTP_SEM = asyncio.Semaphore(8)

# Semaphore: max sintesi LLM parallele (evita quota burst).
_SYNTH_SEM = asyncio.Semaphore(4)

# Max giochi processati in parallelo.
_GAME_CONCURRENCY = 2

# Max URL da fetchare per gioco dopo la ricerca.
_MAX_GUIDE_URLS_PER_GAME = 5

# Trofei per gioco: solo platinum + gold.
_TARGET_TYPES = {"platinum", "gold"}

# Browser UA per fetch generici di siti guide (evita bot-block).
_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)


# ── Helpers ───────────────────────────────────────────────────────────────────


def _slugify(text: str) -> str:
    """Slug URL-safe: NFKD + minuscolo + solo alfanum e trattini."""
    text = unicodedata.normalize("NFKD", text.lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")


def _url_hash(url: str, extra: str = "") -> str:
    """SHA256 di url+extra, troncato a 64 char per content_hash NOT NULL."""
    return hashlib.sha256((url + extra).encode()).hexdigest()[:64]


def _psnprofiles_trophy_url(
    comm_id: str, game_title: str, trophy_id: int, trophy_name: str
) -> str:
    return _PSNPROFILES_TROPHY_URL.format(
        comm_id=comm_id,
        game_slug=_slugify(game_title),
        trophy_id=trophy_id,
        trophy_slug=_slugify(trophy_name),
    )


# ── Generic async fetcher (browser UA, nessun rate-limit per-domain fisso) ───


async def _generic_fetch(
    client: httpx.AsyncClient, url: str, log: object | None = None
) -> str | None:
    """Fetch generico con browser UA e semaphore globale.

    Usato per URL di guida su domini arbitrari (powerpyx, truetrophies, ign…).
    Non usa BaseCollector per evitare il bug del rate-limit keyed su self.domain.
    """
    async with _HTTP_SEM:
        try:
            resp = await client.get(url, timeout=15.0)
            if resp.status_code == 200:
                return resp.text
            if log:
                log.warning(  # type: ignore[attr-defined]
                    "fetch generico fallito",
                    url=url[:80],
                    status=resp.status_code,
                )
            return None
        except httpx.TimeoutException:
            if log:
                log.warning("fetch timeout", url=url[:80])  # type: ignore[attr-defined]
            return None
        except httpx.HTTPError as exc:
            if log:
                log.warning("fetch errore HTTP", url=url[:80], error=str(exc))  # type: ignore[attr-defined]
            return None


# ── Scoperta fonti per gioco — PARALLELA ─────────────────────────────────────


async def _fetch_and_extract(
    client: httpx.AsyncClient,
    url: str,
    trophy_names: list[str],
    log: object,
) -> tuple[str, dict[str, str]]:
    """Fetch un URL guida ed estrae le sezioni trophy matchate.

    Ritorna (url, {trophy_name → content}).
    """
    from src.collectors.trophy_section_extractor import (
        extract_trophy_sections,
        match_trophies_to_sections,
    )

    html = await _generic_fetch(client, url, log)
    if not html:
        return url, {}

    sections = extract_trophy_sections(html)
    if not sections:
        return url, {}

    matches = match_trophies_to_sections(sections, trophy_names)
    return url, matches


async def _discover_guide_sources(
    searcher: object,
    client: httpx.AsyncClient,
    game_title: str,
    trophy_names: list[str],
    log: object,
) -> dict[str, str]:
    """Cerca guide via DDG e fetcha tutti gli URL IN PARALLELO.

    Ritorna {trophy_name → content} aggregando da tutte le fonti trovate.
    """
    # 3 query DDG sequenziali → URL deduplicati per dominio.
    unique_urls = await searcher.search_guide_urls_multi(  # type: ignore[attr-defined]
        game_title, max_results=_MAX_GUIDE_URLS_PER_GAME
    )

    # Fallback deterministico se DDG è bloccato/rate-limited.
    if not unique_urls:
        from src.collectors.guide_search import build_fallback_urls

        unique_urls = build_fallback_urls(game_title)
        log.warning(  # type: ignore[attr-defined]
            "DDG bloccato — uso fallback URL deterministici",
            game=game_title,
            urls=len(unique_urls),
        )
    else:
        log.info(  # type: ignore[attr-defined]
            "Scoperta fonti: URL trovati",
            game=game_title,
            urls=len(unique_urls),
            domains=[urlparse(u).netloc for u in unique_urls],
        )

    if not unique_urls:
        return {}

    # Fetch PARALLELO di tutti gli URL trovati.
    tasks = [
        _fetch_and_extract(client, url, trophy_names, log)
        for url in unique_urls
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    # Merge: prima fonte che matcha un trofeo vince.
    all_matches: dict[str, str] = {}
    for result in results:
        if isinstance(result, Exception):
            log.warning("fetch_and_extract exception", error=str(result))  # type: ignore[attr-defined]
            continue
        url, matches = result
        new_matches = 0
        for trophy_name, content in matches.items():
            if trophy_name not in all_matches:
                all_matches[trophy_name] = content
                new_matches += 1
        if new_matches:
            log.info(  # type: ignore[attr-defined]
                "Fonte elaborata",
                game=game_title,
                url=url[:80],
                new_matches=new_matches,
            )

    return all_matches


# ── Reddit tips per-trofeo ────────────────────────────────────────────────────


async def _fetch_reddit_trophy_tips(
    reddit: object,
    game_title: str,
    trophy_name: str,
) -> str | None:
    """Cerca tips per un trofeo specifico su r/Trophies (async, no semaphore)."""
    query = f'"{game_title}" "{trophy_name}" trophy'
    posts = await reddit.search_subreddit("Trophies", query, limit=3)  # type: ignore[attr-defined]
    if not posts:
        query_loose = f"{game_title} {trophy_name} trophy guide how to"
        posts = await reddit.search_subreddit("Trophies", query_loose, limit=2)  # type: ignore[attr-defined]

    if not posts:
        return None

    parts = [reddit.format_for_llm(p) for p in posts]  # type: ignore[attr-defined]
    text = "\n\n---\n\n".join(p for p in parts if p.strip())
    return text if text.strip() else None


# ── Processing per singolo trofeo (async, può girare in parallelo) ────────────


async def _process_trophy(
    trophy: dict,
    game: dict,
    guide_matches: dict[str, str],
    psnprofiles_collector: object,
    reddit_collector: object,
    synthesizer: object,
    upserter: object,
    dry_run: bool,
    log: object,
) -> str:
    """Genera e salva la guida per un singolo trofeo. Ritorna status string."""
    from src.transformer.quality import calculate_quality_score

    game_title: str = game["title"]
    comm_id: str = game["metadata"]["psn_communication_id"]
    trophy_id: int = trophy["id"]
    trophy_name: str = trophy.get("name_en") or ""
    psn_trophy_id: int = int(trophy["psn_trophy_id"])
    trophy_type: str = trophy.get("type") or "bronze"
    detail_en: str = trophy.get("detail_en") or ""

    if not trophy_name:
        return "skip_no_name"

    # ── Fonte 1: descrizione PSN ──────────────────────────────────────────────
    raw_contents: list[str] = []
    sources_meta: list[dict] = []

    if detail_en:
        raw_contents.append(
            f"Official PSN trophy description: {trophy_name} — {detail_en}"
        )

    # ── Fonti 2 + 3: PSNProfiles e Reddit IN PARALLELO ───────────────────────
    psn_url = _psnprofiles_trophy_url(comm_id, game_title, psn_trophy_id, trophy_name)

    async def _psn_fetch() -> tuple[str | None, dict | None]:
        html = await psnprofiles_collector.fetch(psn_url)  # type: ignore[attr-defined]
        if not html:
            return None, None
        data = await psnprofiles_collector.extract(html, psn_url)  # type: ignore[attr-defined]
        return html, data

    psn_task = asyncio.create_task(_psn_fetch())
    reddit_task = asyncio.create_task(
        _fetch_reddit_trophy_tips(reddit_collector, game_title, trophy_name)
    )

    (_, psn_data), reddit_text = await asyncio.gather(psn_task, reddit_task)

    # Processa risultato PSNProfiles.
    if psn_data and psn_data.get("raw_content"):
        raw_contents.append(psn_data["raw_content"])
        sources_meta.append({
            "source_url": psn_url,
            "source_domain": "psnprofiles.com",
            "source_type": "community",
            "raw_content_length": len(psn_data["raw_content"]),
            "content_hash": psn_data.get("content_hash") or _url_hash(psn_url),
        })

    # Audit trail PSNProfiles anche se fallito.
    if not any(s["source_domain"] == "psnprofiles.com" for s in sources_meta):
        sources_meta.append({
            "source_url": psn_url,
            "source_domain": "psnprofiles.com",
            "source_type": "primary",
            "raw_content_length": 0,
            "content_hash": _url_hash(psn_url),
        })

    # ── Fonte 3: sezione guida matchata via search ────────────────────────────
    guide_section = guide_matches.get(trophy_name)
    if guide_section:
        raw_contents.append(guide_section)
        sources_meta.append({
            "source_url": f"https://search.discovery/{_slugify(game_title)}/{_slugify(trophy_name)}",
            "source_domain": "guide.discovery",
            "source_type": "supplementary",
            "raw_content_length": len(guide_section),
            "content_hash": _url_hash(game_title, trophy_name),
        })

    # ── Fonte 4: Reddit tips ──────────────────────────────────────────────────
    if reddit_text:
        raw_contents.append(reddit_text)
        reddit_url = (
            f"https://www.reddit.com/r/Trophies/search?q="
            f"{_slugify(game_title)}+{_slugify(trophy_name)}"
        )
        sources_meta.append({
            "source_url": reddit_url,
            "source_domain": "reddit.com",
            "source_type": "community",
            "raw_content_length": len(reddit_text),
            "content_hash": _url_hash(reddit_url, trophy_name),
        })

    if not raw_contents:
        log.warning("Nessuna fonte trovata — skip", game=game_title, trophy=trophy_name)  # type: ignore[attr-defined]
        return "skip_no_content"

    if dry_run:
        log.info(  # type: ignore[attr-defined]
            "[DRY-RUN] Trofeo pronto per sintesi",
            game=game_title,
            trophy=trophy_name,
            type=trophy_type,
            sources=len(raw_contents),
            has_guide=guide_section is not None,
            has_reddit=reddit_text is not None,
        )
        return "dry_run"

    # ── Sintesi con semaphore (max _SYNTH_SEM parallele) ─────────────────────
    async with _SYNTH_SEM:
        guide = await synthesizer.transform(raw_contents, game_title, trophy_name)  # type: ignore[attr-defined]

    if not guide:
        log.warning("Sintesi fallita", game=game_title, trophy=trophy_name)  # type: ignore[attr-defined]
        return "skip_synth_fail"

    guide["quality_score"] = calculate_quality_score(guide)

    guide_id = await upserter.upsert_guide(  # type: ignore[attr-defined]
        {**guide, "game_name": game_title},
        chunks=[],
        embeddings=[],
        sources=sources_meta,
    )

    if guide_id:
        from src.config.db import execute

        await execute(
            "UPDATE guides SET trophy_id = %s WHERE id = %s AND trophy_id IS NULL",
            (trophy_id, guide_id),
        )
        log.info(  # type: ignore[attr-defined]
            "Guida salvata",
            guide_id=guide_id,
            game=game_title,
            trophy=trophy_name,
            type=trophy_type,
            n_sources=len(raw_contents),
        )
        return "ok"

    log.warning("upsert_guide skip/fail", game=game_title, trophy=trophy_name)  # type: ignore[attr-defined]
    return "skip_upsert_fail"


# ── Processing per singolo gioco ──────────────────────────────────────────────


async def _process_game(
    game: dict,
    trophies: list[dict],
    searcher: object,
    client: httpx.AsyncClient,
    psnprofiles_collector: object,
    reddit_collector: object,
    synthesizer: object,
    upserter: object,
    dry_run: bool,
) -> dict[str, int]:
    """Genera guide per i trofei plat/gold di un gioco.

    Trofei processati in batch paralleli (max _SYNTH_SEM alla volta).
    Ritorna stats dict.
    """
    from src.config.logger import get_logger

    game_title: str = game["title"]
    log = get_logger("trophy_guides")
    log.info("Elaborazione gioco", game=game_title, trophies=len(trophies))

    trophy_names = [t["name_en"] for t in trophies if t.get("name_en")]

    # ── Fase A: scoperta fonti (tutti gli URL in parallelo) ───────────────────
    guide_matches = await _discover_guide_sources(
        searcher, client, game_title, trophy_names, log
    )

    covered = len(guide_matches)
    log.info(
        "Copertura guide",
        game=game_title,
        covered=covered,
        total=len(trophy_names),
        pct=f"{100*covered//max(len(trophy_names),1)}%",
    )

    # ── Fase B: trofei in parallelo (batch da _SYNTH_SEM) ────────────────────
    tasks = [
        _process_trophy(
            trophy=t,
            game=game,
            guide_matches=guide_matches,
            psnprofiles_collector=psnprofiles_collector,
            reddit_collector=reddit_collector,
            synthesizer=synthesizer,
            upserter=upserter,
            dry_run=dry_run,
            log=log,
        )
        for t in trophies
    ]

    # Tutti i trofei in parallelo — il _SYNTH_SEM limita le sintesi LLM,
    # ma fetch PSN/Reddit girano liberamente in parallelo.
    results = await asyncio.gather(*tasks, return_exceptions=True)

    stats = {"synthesized": 0, "skipped_no_content": 0, "skipped_dry_run": 0}
    for r in results:
        if isinstance(r, Exception):
            log.error("trophy task exception", error=str(r))  # type: ignore[attr-defined]
            stats["skipped_no_content"] += 1
        elif r == "ok":
            stats["synthesized"] += 1
        elif r == "dry_run":
            stats["skipped_dry_run"] += 1
        else:
            stats["skipped_no_content"] += 1

    return stats


# ── Entry point ────────────────────────────────────────────────────────────────


async def _run(
    dry_run: bool,
    only_game_id: int | None,
    game_concurrency: int,
    regen_italian: bool = False,
) -> int:
    from src.collectors.guide_search import GuideSearchCollector
    from src.collectors.psnprofiles import PSNProfilesCollector
    from src.collectors.reddit import RedditCollector
    from src.config.db import close_pool, fetch_all, init_pool
    from src.config.logger import get_logger, setup_logging
    from src.config.redis_client import close_redis
    from src.injector.upserter import Upserter
    from src.transformer.synthesizer import GuideSynthesizer

    setup_logging()
    log = get_logger("run_trophy_guides_top20")

    await init_pool()

    # Client httpx con browser UA per fetch generici dei siti guida.
    # Non usa BaseCollector per evitare il bug del rate-limit keyed su self.domain.
    generic_client = httpx.AsyncClient(
        timeout=httpx.Timeout(15.0),
        headers={
            "User-Agent": _BROWSER_UA,
            "Accept-Language": "en-US,en;q=0.9",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        follow_redirects=True,
    )

    psnprofiles = PSNProfilesCollector()
    searcher = GuideSearchCollector()
    reddit = RedditCollector()
    synthesizer = GuideSynthesizer()
    upserter = Upserter()

    try:
        # ── Query giochi candidati ────────────────────────────────────────────
        if only_game_id:
            games = await fetch_all(
                """
                SELECT g.id, g.title, g.metadata
                FROM games g
                WHERE g.id = %s
                  AND g.metadata->>'psn_communication_id' IS NOT NULL
                """,
                (only_game_id,),
            )
        else:
            games = await fetch_all(
                """
                SELECT g.id, g.title, g.metadata,
                       COUNT(t.id) FILTER (WHERE t.type IN ('platinum','gold')) AS pg_count
                FROM games g
                JOIN trophies t ON t.game_id = g.id
                WHERE g.metadata->>'psn_communication_id' IS NOT NULL
                  AND t.psn_trophy_id IS NOT NULL
                GROUP BY g.id, g.title, g.metadata
                HAVING COUNT(t.id) FILTER (WHERE t.type IN ('platinum','gold')) > 0
                ORDER BY pg_count DESC, g.id
                LIMIT 20
                """
            )

        if not games:
            log.error("Nessun gioco candidato trovato")
            return 1

        log.info(
            "Giochi da processare",
            count=len(games),
            dry_run=dry_run,
            concurrency=game_concurrency,
            regen_italian=regen_italian,
        )
        total_stats = {"synthesized": 0, "skipped_no_content": 0, "skipped_dry_run": 0}

        # Semaphore per limitare giochi in parallelo.
        game_sem = asyncio.Semaphore(game_concurrency)

        async def _process_game_guarded(i: int, game: dict) -> dict[str, int]:
            async with game_sem:
                game_id = game["id"]
                log.info(f"[{i}/{len(games)}] Inizio: {game['title']}")

                # In modalità normale: salta trofei che hanno già una guida.
                # In modalità --regen-italian: include anche i trofei la cui guida
                # esistente ha label italiane (**Gioco:** o ### Come Ottenere),
                # consentendo la rigenerazione con il prompt English-only.
                # L'overwrite è garantito da should_upsert >= (qualità uguale = ok).
                if regen_italian:
                    trophies = await fetch_all(
                        """
                        SELECT t.id, t.psn_trophy_id, t.type, t.name_en, t.detail_en
                        FROM trophies t
                        WHERE t.game_id = %s
                          AND t.type IN ('platinum', 'gold')
                          AND t.psn_trophy_id IS NOT NULL
                          AND t.name_en IS NOT NULL AND t.name_en != ''
                          AND (
                            NOT EXISTS (
                              SELECT 1 FROM guides gu WHERE gu.trophy_id = t.id
                            )
                            OR EXISTS (
                              SELECT 1 FROM guides gu
                              WHERE gu.trophy_id = t.id
                                AND (gu.content LIKE %s OR gu.content LIKE %s)
                                AND gu.confidence_level != 'verified'
                            )
                          )
                        ORDER BY t.type DESC, t.psn_trophy_id
                        """,
                        (game_id, "%**Gioco:**%", "%### Come Ottenere%"),
                    )
                else:
                    trophies = await fetch_all(
                        """
                        SELECT t.id, t.psn_trophy_id, t.type, t.name_en, t.detail_en
                        FROM trophies t
                        WHERE t.game_id = %s
                          AND t.type IN ('platinum', 'gold')
                          AND t.psn_trophy_id IS NOT NULL
                          AND t.name_en IS NOT NULL AND t.name_en != ''
                          AND NOT EXISTS (
                              SELECT 1 FROM guides gu WHERE gu.trophy_id = t.id
                          )
                        ORDER BY t.type DESC, t.psn_trophy_id
                        """,
                        (game_id,),
                    )

                if not trophies:
                    log.info("Tutti i trofei già con guida — skip", game=game["title"])
                    return {"synthesized": 0, "skipped_no_content": 0, "skipped_dry_run": 0}

                log.info(
                    "Trofei da guidare",
                    game=game["title"],
                    count=len(trophies),
                )

                stats = await _process_game(
                    game=game,
                    trophies=trophies,
                    searcher=searcher,
                    client=generic_client,
                    psnprofiles_collector=psnprofiles,
                    reddit_collector=reddit,
                    synthesizer=synthesizer,
                    upserter=upserter,
                    dry_run=dry_run,
                )

                log.info("Gioco completato", game=game["title"], **stats)
                return stats

        # Lancia tutti i giochi in parallelo (limitati da game_sem).
        all_game_tasks = [
            _process_game_guarded(i, game)
            for i, game in enumerate(games, 1)
        ]
        game_results = await asyncio.gather(*all_game_tasks, return_exceptions=True)

        for r in game_results:
            if isinstance(r, Exception):
                log.error("game task exception", error=str(r))
            else:
                for k, v in r.items():
                    total_stats[k] += v

        log.info("Pipeline completata", **total_stats, dry_run=dry_run)
        return 0

    except Exception as exc:
        log.exception("Errore fatale", error=str(exc))
        return 1

    finally:
        await generic_client.aclose()
        await psnprofiles.close()
        await searcher.close()
        await reddit.close()
        await close_pool()
        await close_redis()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Genera guide per-trofeo (plat+gold) per i top 20 giochi"
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--game-id", type=int, default=None, metavar="ID")
    parser.add_argument(
        "--concurrency",
        type=int,
        default=_GAME_CONCURRENCY,
        metavar="N",
        help=f"Giochi in parallelo (default {_GAME_CONCURRENCY})",
    )
    parser.add_argument(
        "--regen-italian",
        action="store_true",
        help=(
            "Rigenera guide esistenti con label italiane (**Gioco:** / ### Come Ottenere). "
            "Richiede fix deduplicator >= per funzionare."
        ),
    )
    args = parser.parse_args()

    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

    exit_code = asyncio.run(
        _run(
            dry_run=args.dry_run,
            only_game_id=args.game_id,
            game_concurrency=args.concurrency,
            regen_italian=args.regen_italian,
        )
    )
    sys.exit(exit_code)


if __name__ == "__main__":
    main()

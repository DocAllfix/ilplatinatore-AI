"""End-to-end pipeline test — UN singolo gioco reale.

Valida l'intera pipeline: collect → transform → quality → embed → DB → pgvector.
Fa richieste HTTP e chiamate Gemini REALI. Richiede le API key nel .env.

Esecuzione:
    cd harvester && source .venv/bin/activate
    python -m scripts.test_single_game
"""

from __future__ import annotations

import asyncio
import sys

import src.transformer.synthesizer as _synth_module
from src.collectors.powerpyx import PowerPyxCollector
from src.config.db import _get_pool, close_pool, fetch_all, test_connection
from src.config.logger import get_logger
from src.config.redis_client import close_redis, test_redis_connection
from src.injector.chunker import chunk_content
from src.injector.embedder import Embedder
from src.injector.upserter import Upserter
from src.transformer.quality import calculate_quality_score
from src.transformer.synthesizer import GuideSynthesizer

# ── Parametri del test ────────────────────────────────────────────────────────

_GAME_NAME = "Elden Ring"
_TROPHY_NAME = None  # guida completa, non un singolo trofeo
_URL = "https://powerpyx.com/elden-ring-trophy-guide/"

# Fallback model se gemini-2.5-flash è overloaded (503).
# Ripristinare "gemini-2.5-flash" in produzione.
_GEMINI_MODEL_OVERRIDE = "gemini-2.5-flash-lite"
_QUERY = "how to get the platinum trophy in elden ring"

log = get_logger("E2ETest")


# ── Helpers ───────────────────────────────────────────────────────────────────


def _vec_to_pg(vec: list[float]) -> str:
    """Converte una lista float nel literal pgvector '[f1,f2,...]'.

    Usato per INSERT e query <=>. Sicuro perché i valori vengono dall'embedder
    (float puri, nessun input utente).
    """
    return "[" + ",".join(f"{v:.10f}" for v in vec) + "]"


async def _insert_embeddings(
    guide_id: int,
    chunks: list[str],
    embeddings: list[list[float]],
) -> int:
    """Inserisce righe in guide_embeddings. TEST-ONLY: bypassa il worker Node.js."""
    pool = await _get_pool()
    inserted = 0
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            for idx, (chunk, vec) in enumerate(zip(chunks, embeddings)):
                vec_literal = _vec_to_pg(vec)
                await cur.execute(
                    # Insert embedding manuale per test E2E (il worker Node lo fa in prod).
                    "INSERT INTO guide_embeddings "
                    "(guide_id, embedding, chunk_index, chunk_text) "
                    f"VALUES (%s, '{vec_literal}'::vector, %s, %s) "
                    "ON CONFLICT DO NOTHING",
                    (guide_id, idx, chunk),
                )
                inserted += 1
    return inserted


async def _pgvector_search(query_vec: list[float], limit: int = 3) -> list[dict]:
    """Ricerca coseno su guide_embeddings. Ritorna le righe più simili."""
    vec_literal = _vec_to_pg(query_vec)
    return await fetch_all(
        # Ricerca similarity con operatore coseno pgvector.
        "SELECT ge.chunk_index, ge.chunk_text, "
        f"       ROUND((1-(ge.embedding<=>'{vec_literal}'::vector))::numeric,4) AS similarity, "
        "       g.title AS guide_title "
        "FROM guide_embeddings ge "
        "JOIN guides g ON ge.guide_id = g.id "
        f"ORDER BY ge.embedding <=> '{vec_literal}'::vector "
        f"LIMIT {limit}",
    )


# ── Steps ─────────────────────────────────────────────────────────────────────


async def step1_init() -> None:
    log.info("━━ STEP 1 — Inizializzazione connessioni ━━")
    await test_connection()
    await test_redis_connection()


async def step2_collect(collector: PowerPyxCollector) -> dict:
    log.info("━━ STEP 2 — Collect da PowerPyx ━━", url=_URL)
    raw = await collector.collect(_URL)
    if raw is None:
        log.error("COLLECT FALLITO — pagina non raggiungibile o bloccata da robots.txt")
        sys.exit(1)
    log.info(
        "collect OK",
        title=raw.get("title", "?")[:80],
        raw_content_length=len(raw.get("raw_content", "")),
        content_hash=raw.get("content_hash", "?")[:16] + "...",
        game_name=raw.get("game_name"),
        trophy_name=raw.get("trophy_name"),
    )
    return raw


async def step3_transform(synth: GuideSynthesizer, raw: dict) -> dict:
    log.info("━━ STEP 3 — Transform (Gemini) ━━")

    # Estrai fatti (1a chiamata Gemini) — retry su 503 transient errors
    facts = None
    for attempt in range(1, 4):
        facts = await synth.extract_facts(
            raw_contents=[raw["raw_content"]],
            game_name=_GAME_NAME,
            trophy_name=_TROPHY_NAME or "Platinum",
        )
        if facts is not None:
            break
        if attempt < 3:
            wait = 15 * attempt
            log.warning("extract_facts fallito, retry", attempt=attempt, wait_seconds=wait)
            await asyncio.sleep(wait)
    if facts is None:
        log.error("EXTRACT_FACTS FALLITO dopo 3 tentativi — controllare la API key Gemini")
        sys.exit(1)
    log.info(
        "fatti estratti",
        n_facts=len(facts),
        esempio_primo_fatto=facts[0] if facts else None,
    )

    # Sintetizza guida (2a chiamata Gemini) — retry su 503
    guide = None
    for attempt in range(1, 4):
        guide = await synth.synthesize_guide(
            facts=facts,
            game_name=_GAME_NAME,
            trophy_name=_TROPHY_NAME or "Platinum",
        )
        if guide is not None:
            break
        if attempt < 3:
            wait = 15 * attempt
            log.warning("synthesize_guide fallito, retry", attempt=attempt, wait_seconds=wait)
            await asyncio.sleep(wait)
    if guide is None:
        log.error("SYNTHESIZE_GUIDE FALLITO dopo 3 tentativi")
        sys.exit(1)
    log.info(
        "guida sintetizzata",
        title=guide.get("title", "?")[:80],
        content_length=len(guide.get("content", "")),
        language=guide.get("language"),
    )
    return guide


async def step4_quality_and_chunk(guide: dict) -> tuple[float, list[str]]:
    log.info("━━ STEP 4 — Quality score + Chunking ━━")
    quality = calculate_quality_score(guide)
    chunks = chunk_content(guide["content"], guide["title"])
    log.info(
        "quality e chunk",
        quality_score=quality,
        n_chunks=len(chunks),
        primo_chunk_preview=chunks[0][:120] + "..." if chunks else None,
    )
    return quality, chunks


async def step5_embed(embedder: Embedder, chunks: list[str]) -> list[list[float]]:
    log.info("━━ STEP 5 — Embedding chunks ━━")
    embeddings = await embedder.embed_batch(chunks)
    if embeddings is None:
        log.error("EMBED FALLITO — quota embedding esaurita o errore API")
        sys.exit(1)
    dim = len(embeddings[0]) if embeddings else 0
    log.info("embedding OK", n_vectors=len(embeddings), vector_dim=dim)
    return embeddings


async def step6_upsert(
    upserter: Upserter,
    guide: dict,
    quality: float,
    chunks: list[str],
    embeddings: list[list[float]],
    raw: dict,
) -> int:
    log.info("━━ STEP 6 — Upsert guida nel DB ━━")
    guide["quality_score"] = quality

    sources = [
        {
            "source_url": raw["source_url"],
            "source_domain": raw["source_domain"],
            "content_hash": raw["content_hash"],
            "raw_content_length": len(raw.get("raw_content", "")),
        }
    ]
    guide_id = await upserter.upsert_guide(guide, chunks, embeddings, sources)
    if guide_id is None:
        log.error("UPSERT FALLITO — deduplication skip o errore DB")
        sys.exit(1)
    log.info("guida inserita nel DB", guide_id=guide_id, n_harvest_sources=len(sources))
    return guide_id


async def step7_insert_embeddings(
    guide_id: int, chunks: list[str], embeddings: list[list[float]]
) -> None:
    log.info("━━ STEP 7 — Insert embeddings (test-only, bypassa worker Node) ━━")
    n = await _insert_embeddings(guide_id, chunks, embeddings)
    log.info("embeddings inseriti", n_righe=n, guide_id=guide_id)


async def step8_pgvector_search(embedder: Embedder) -> None:
    log.info("━━ STEP 8 — pgvector similarity search ━━", query=_QUERY)
    query_vec = await embedder.embed_batch([_QUERY])
    if not query_vec:
        log.error("EMBEDDING QUERY FALLITO")
        return

    results = await _pgvector_search(query_vec[0])
    if not results:
        log.warning("nessun risultato trovato — embedding_pending non ancora processato?")
        return

    log.info(f"top {len(results)} risultati pgvector:")
    for i, row in enumerate(results, 1):
        log.info(
            f"  #{i}",
            similarity=row.get("similarity"),
            guide_title=row.get("guide_title", "?")[:60],
            chunk_index=row.get("chunk_index"),
            chunk_preview=str(row.get("chunk_text", ""))[:120] + "...",
        )


# ── Entry point ───────────────────────────────────────────────────────────────


async def main() -> None:
    log.info("=" * 60)
    log.info("IL PLATINATORE — E2E PIPELINE TEST", game=_GAME_NAME, url=_URL)
    log.info("=" * 60)

    # Override del modello per il test: se gemini-2.5-flash è overloaded usa 2.0-flash.
    _synth_module._MODEL = _GEMINI_MODEL_OVERRIDE

    collector = PowerPyxCollector()
    synth = GuideSynthesizer()
    embedder = Embedder()
    upserter = Upserter()

    try:
        await step1_init()
        raw = await step2_collect(collector)
        guide = await step3_transform(synth, raw)
        quality, chunks = await step4_quality_and_chunk(guide)
        embeddings = await step5_embed(embedder, chunks)
        guide_id = await step6_upsert(upserter, guide, quality, chunks, embeddings, raw)
        await step7_insert_embeddings(guide_id, chunks, embeddings)
        await step8_pgvector_search(embedder)

        log.info("=" * 60)
        log.info("TEST E2E COMPLETATO CON SUCCESSO", guide_id=guide_id)
        log.info("=" * 60)

    except SystemExit:
        raise
    except Exception as exc:
        log.exception("ERRORE INATTESO", error=str(exc))
        sys.exit(1)
    finally:
        await collector.close()
        await close_pool()
        await close_redis()
        log.info("connessioni chiuse")


if __name__ == "__main__":
    # psycopg3 richiede SelectorEventLoop su Windows (ProactorEventLoop non supportato).
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(main())

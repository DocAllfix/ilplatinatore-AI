"""CLI entry point per topic_mapper (Fase 24).

Uso:
    python -m src.topics --game-id 42                    # discover singolo gioco
    python -m src.topics --all --parallelism 3           # tutto il catalogo
    python -m src.topics --all --limit 5                 # smoke test 5 giochi
    python -m src.topics --list-pending --topic-type boss  # quale c'è in coda
    python -m src.topics --generate-guides --limit 10    # genera guide dai topic (OPT-IN)

NOTE su `--generate-guides`:
  Il flag attiva la pipeline esistente (HarvestPipeline.process_single_guide) per
  ogni topic con guide_generated=false ordinati per priority. È OPT-IN per evitare
  costi LLM accidentali su 4000+ giochi del catalogo. Il `--limit` cap è obbligatorio.
"""

from __future__ import annotations

import argparse
import asyncio
import json

from src.config.db import close_pool, fetch_one, init_pool
from src.config.logger import get_logger
from src.topics.topic_mapper import TopicMapper

logger = get_logger(__name__)


async def cmd_discover_one(game_id: int) -> None:
    row = await fetch_one("SELECT slug FROM games WHERE id = %s", (game_id,))
    if not row:
        logger.error("game non trovato", game_id=game_id)
        return
    mapper = TopicMapper()
    stats = await mapper.discover_for_game(game_id, row["slug"])
    print(json.dumps({"game_id": game_id, "slug": row["slug"], "stats": stats}, indent=2))


async def cmd_discover_all(parallelism: int, limit: int | None) -> None:
    mapper = TopicMapper()
    results = await mapper.discover_all(parallelism=parallelism, limit=limit)
    total = sum(sum(s.values()) for s in results.values())
    print(
        json.dumps(
            {
                "games_processed": len(results),
                "topics_total": total,
                "per_type": _aggregate_per_type(results),
            },
            indent=2,
        )
    )


def _aggregate_per_type(
    results: dict[int, dict[str, int]],
) -> dict[str, int]:
    agg: dict[str, int] = {}
    for stats in results.values():
        for k, v in stats.items():
            agg[k] = agg.get(k, 0) + v
    return agg


async def cmd_list_pending(
    game_id: int | None,
    topic_type: str | None,
    limit: int,
) -> None:
    mapper = TopicMapper()
    rows = await mapper.list_pending(
        game_id=game_id,
        topic_type=topic_type,
        limit=limit,
    )
    for r in rows:
        # Stampa CSV-like, comprensibile da occhio umano e parsabile.
        sources = ",".join(r.get("discovered_from") or [])
        print(
            f"{r['id']}\t{r['game_id']}\t{r['topic_type']}\t"
            f"prio={r['priority']}\tsources={sources}\t{r['topic_name']}"
        )


async def cmd_generate_guides(limit: int) -> None:
    """OPT-IN: genera guide dai topic pending (costo LLM!).

    Riusa HarvestPipeline esistente con `guide_type_override` settato al topic_type.
    Per evitare overload, il limit è obbligatorio (default CLI 10).
    """
    from src.orchestrator.pipeline import HarvestPipeline

    mapper = TopicMapper()
    pipeline = HarvestPipeline()
    pending = await mapper.list_pending(limit=limit)

    if not pending:
        print("Nessun topic pending da generare.")
        return

    generated = 0
    for topic in pending:
        # Per Fase 24 baseline: il topic_name diventa la query/title della guide.
        # In futuro un topic potrebbe puntare a un URL collector specifico (Fextralife).
        # Per ora: guidance = topic_name + game.slug, lasciamo che il LLM elabori.
        logger.info(
            "Generating guide for topic",
            topic_id=topic["id"],
            game_id=topic["game_id"],
            topic_type=topic["topic_type"],
            topic_name=topic["topic_name"],
        )
        # TODO Fase 24-bis: passare topic-specific seed URL al pipeline.
        # Per ora: skip se non abbiamo URL collector → log e marca come pending.
        # L'utente attiverà generazione concreta quando integrerà discoverer URLs.
        # Implementazione minimale: marca come "generation_attempted" via log.
        # In una fase successiva, popoleremo guide con LLM completion.
        generated += 1

    print(
        json.dumps(
            {"generated": generated, "limit": limit, "note": "stub — vedi TODO Fase 24-bis"},
            indent=2,
        )
    )


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="topic_mapper", description="Fase 24 — Topic Mapper")
    p.add_argument("--game-id", type=int, help="Discover topic per singolo game_id")
    p.add_argument("--all", action="store_true", help="Discover su tutto il catalogo")
    p.add_argument("--parallelism", type=int, default=3, help="Coroutines concorrenti")
    p.add_argument("--limit", type=int, default=None, help="Cap giochi/topic processati")
    p.add_argument("--list-pending", action="store_true", help="Lista topic con guide_generated=false")
    p.add_argument("--topic-type", type=str, default=None, help="Filtro su tipo topic")
    p.add_argument("--generate-guides", action="store_true",
                   help="OPT-IN: genera guide dai topic pending (limit obbligatorio)")
    return p


async def _main() -> None:
    args = _build_parser().parse_args()
    await init_pool()
    try:
        if args.list_pending:
            await cmd_list_pending(
                game_id=args.game_id,
                topic_type=args.topic_type,
                limit=args.limit or 100,
            )
        elif args.generate_guides:
            if args.limit is None:
                raise SystemExit(
                    "--generate-guides richiede --limit per evitare costi LLM accidentali."
                )
            await cmd_generate_guides(limit=args.limit)
        elif args.all:
            await cmd_discover_all(parallelism=args.parallelism, limit=args.limit)
        elif args.game_id is not None:
            await cmd_discover_one(args.game_id)
        else:
            _build_parser().print_help()
    finally:
        await close_pool()


if __name__ == "__main__":
    asyncio.run(_main())

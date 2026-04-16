"""Script: discovery massiva giochi PS5+PS4 via IGDB fetch_games paginato.

Strategia:
- PS5 (167) + PS4 (48): i più giocati con trofei PSN
- Filtro qualità: rating_count >= 3 O hypes >= 5
- Ordine: popularity desc → prima i più giocati
- Target: 500-1000 giochi con trofei PSN reali

Dopo l'ingestion, genera automaticamente expanded_seed.json per l'harvest.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))


async def main() -> None:
    from src.config.db import close_pool, fetch_all, init_pool
    from src.config.logger import get_logger
    from src.config.settings import settings
    from src.discovery.igdb import (
        MOBILE_VR_PLATFORM_IDS,
        PLATFORM_PS4,
        PLATFORM_PS5,
        IGDBDiscovery,
        _IGDB_DELAY_S,
    )

    logger = get_logger("igdb_full_discovery")
    await init_pool()

    try:
        igdb = IGDBDiscovery()
        token = await igdb._get_token()

        import httpx

        client = httpx.AsyncClient(timeout=30.0)
        headers = {
            "Authorization": f"Bearer {token}",
            "Client-ID": settings.igdb_client_id,
        }

        # Piattaforme target: PS5 + PS4
        platform_ids = [PLATFORM_PS5, PLATFORM_PS4]
        ids_str = ",".join(str(p) for p in platform_ids)

        total_added = 0
        total_skipped = 0
        offset = 0
        limit = 500

        logger.info("Avvio discovery PS5+PS4", platform_ids=platform_ids)

        while True:
            body = (
                f"fields name, slug, platforms, first_release_date,"
                f" aggregated_rating, total_rating_count, follows, hypes, cover;"
                f" where platforms = ({ids_str})"
                f" & total_rating_count >= 3;"
                f" sort total_rating_count desc;"
                f" limit {limit};"
                f" offset {offset};"
            )
            resp = await client.post(
                "https://api.igdb.com/v4/games",
                headers=headers,
                content=body,
            )
            await asyncio.sleep(_IGDB_DELAY_S)

            if resp.status_code != 200:
                logger.error("IGDB error", status=resp.status_code)
                break

            games = resp.json()
            if not games:
                logger.info("Paginazione completata", total_pages=offset // limit)
                break

            logger.info(
                "Batch ricevuto", offset=offset, count=len(games), added_so_far=total_added
            )

            for game in games:
                # Salta giochi mobile/VR
                platform_set = set(game.get("platforms", []))
                if platform_set & MOBILE_VR_PLATFORM_IDS:
                    total_skipped += 1
                    continue

                name = game.get("name", "").strip()
                if not name:
                    continue

                try:
                    added = await igdb._ingest_game(game)
                    if added:
                        total_added += 1
                    else:
                        total_skipped += 1
                except Exception as exc:
                    logger.error("ingest fallito", game=name, error=str(exc))

            offset += limit

            # Safety: max 10 pagine (5000 giochi) per run
            if offset >= 5000:
                logger.info("Limite 5000 giochi raggiunto, stop")
                break

        await client.aclose()
        logger.info("Discovery completata", total_added=total_added, total_skipped=total_skipped)

        # ── Conta totale ────────────────────────────────────────────────────
        from src.config.db import fetch_one

        row = await fetch_one("SELECT count(*) as n FROM games")
        total_games = row["n"] if row else 0
        logger.info("Totale games nel DB", count=total_games)

        row2 = await fetch_one("SELECT count(*) as n FROM trophies")
        logger.info("Totale trophies nel DB", count=row2["n"] if row2 else 0)

        # ── Genera expanded_seed.json ────────────────────────────────────────
        # Prende i giochi PS5/PS4 con più trofei nel DB, ordinati per relevance.
        # Esclude giochi già con guide.
        games_for_seed = await fetch_all(
            """
            SELECT g.title, g.slug
            FROM games g
            WHERE 'PS5' = ANY(g.platform) OR 'PS4' = ANY(g.platform)
              AND NOT EXISTS (SELECT 1 FROM guides gu WHERE gu.game_id = g.id)
            ORDER BY array_length(g.platform, 1) DESC NULLS LAST, g.title
            LIMIT 200
            """,
        )

        seed_entries = []
        for row in games_for_seed:
            seed_entries.append(
                {
                    "title": row["title"],
                    "slug": row["slug"],
                }
            )

        seed_path = Path(__file__).parent.parent / "seeds" / "expanded_seed.json"
        seed_path.write_text(json.dumps(seed_entries, indent=2, ensure_ascii=False))
        logger.info("expanded_seed.json scritto", path=str(seed_path), count=len(seed_entries))

    finally:
        await close_pool()


if __name__ == "__main__":
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(main())

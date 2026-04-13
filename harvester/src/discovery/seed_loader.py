"""SeedLoader — carica un file JSON seed e popola il catalogo giochi nel DB.

Formato atteso del file seed:
[
  {
    "title": "Elden Ring",
    "slug": "elden-ring",
    "platforms": ["PS5", "PS4", "PC", "Xbox Series X"],
    "priority": 1
  },
  ...
]
"""

from __future__ import annotations

import json
from pathlib import Path

from src.config.db import _get_pool
from src.config.logger import get_logger

logger = get_logger("SeedLoader")


class SeedLoader:
    """Legge file JSON seed e upserta giochi nel DB con alias."""

    def load_seed_file(self, filepath: str) -> list[dict]:
        """Legge e valida un file JSON seed. Ritorna la lista di giochi."""
        path = Path(filepath)
        if not path.exists():
            raise FileNotFoundError(f"Seed file non trovato: {filepath}")

        with path.open(encoding="utf-8") as fh:
            data = json.load(fh)

        if not isinstance(data, list):
            raise ValueError(f"Seed file deve contenere una lista JSON, trovato: {type(data)}")

        logger.info("Seed file caricato", filepath=filepath, count=len(data))
        return data

    async def seed_database(self, filepath: str) -> int:
        """Upserta tutti i giochi del seed file nel DB.

        Per ogni gioco:
        - INSERT INTO games ON CONFLICT (slug) DO UPDATE.
        - Inserisce alias: titolo completo.
        Ritorna il numero di giochi inseriti/aggiornati.
        """
        games = self.load_seed_file(filepath)
        pool = await _get_pool()
        inserted = 0

        async with pool.connection() as conn:
            for game in games:
                title: str = game.get("title", "").strip()
                slug: str = game.get("slug", "").strip()

                if not title or not slug:
                    logger.warning("Gioco seed senza title o slug, saltato", game=game)
                    continue

                try:
                    # Upsert gioco principale.
                    await conn.execute(
                        # Inserisce o aggiorna il gioco seed nel catalogo.
                        "INSERT INTO games (title, slug) VALUES (%s, %s) "
                        "ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title",
                        (title, slug),
                    )

                    # Recupera l'id per gli alias.
                    async with conn.cursor() as cur:
                        await cur.execute(
                            # Recupera id del gioco appena inserito/aggiornato.
                            "SELECT id FROM games WHERE slug = %s LIMIT 1",
                            (slug,),
                        )
                        row = await cur.fetchone()

                    if row:
                        game_id = row[0]
                        # Alias: titolo completo (per matching case-insensitive).
                        await conn.execute(
                            # Inserisce alias titolo; ignora duplicati.
                            "INSERT INTO game_aliases (game_id, alias) VALUES (%s, %s) "
                            "ON CONFLICT (game_id, alias) DO NOTHING",
                            (game_id, title),
                        )

                    inserted += 1
                    logger.info("Gioco seed upsertato", title=title, slug=slug)

                except Exception as exc:
                    logger.error(
                        "Errore upsert gioco seed",
                        title=title,
                        slug=slug,
                        error=str(exc),
                    )

        logger.info("seed_database completato", total=inserted)
        return inserted

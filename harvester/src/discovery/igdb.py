"""IGDBDiscovery — popola il catalogo giochi via IGDB API v4.

Autenticazione: Twitch OAuth2 client_credentials.
Token cachato in memoria (~60 giorni di vita).
Rate limit IGDB: 4 req/s → delay 0.25s tra richieste.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx

from src.config.logger import get_logger
from src.config.settings import settings
from src.injector.upserter import Upserter

_TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token"
_IGDB_GAMES_URL = "https://api.igdb.com/v4/games"

# Platform IDs IGDB.
PLATFORM_PS5 = 167
PLATFORM_PS4 = 48
PLATFORM_XBOX_SERIES = 169
PLATFORM_XBOX_ONE = 49
PLATFORM_PC = 6
PLATFORM_SWITCH = 130


class IGDBDiscovery:
    """Client IGDB per discovery automatica giochi e popolamento catalogo DB."""

    def __init__(self, upserter: Upserter | None = None) -> None:
        self._client = httpx.AsyncClient(timeout=30.0)
        self._logger = get_logger(self.__class__.__name__)
        self._upserter = upserter or Upserter()

        # Token cache: (access_token, expires_at_monotonic)
        self._token: str | None = None
        self._token_expires_at: float = 0.0

    # ── Auth ─────────────────────────────────────────────────────────────────

    async def _get_token(self) -> str:
        """Ritorna il token Twitch OAuth, richiedendolo/rinnovandolo se scaduto."""
        now = time.monotonic()
        # Rinnova 60 secondi prima della scadenza per sicurezza.
        if self._token and now < self._token_expires_at - 60:
            return self._token

        resp = await self._client.post(
            _TWITCH_TOKEN_URL,
            params={
                "client_id": settings.igdb_client_id,
                "client_secret": settings.igdb_client_secret,
                "grant_type": "client_credentials",
            },
        )
        resp.raise_for_status()
        data = resp.json()

        self._token = data["access_token"]
        # expires_in è in secondi.
        self._token_expires_at = now + float(data.get("expires_in", 3600))
        self._logger.info(
            "Twitch token rinnovato",
            expires_in_s=data.get("expires_in"),
        )
        return self._token  # type: ignore[return-value]

    # ── IGDB Games ───────────────────────────────────────────────────────────

    async def fetch_games(
        self,
        platform_ids: list[int],
        offset: int = 0,
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        """Recupera giochi IGDB per le piattaforme indicate.

        IGDB usa POST con body query (non GET).
        Ritorna lista di dict con campi IGDB grezzi.
        """
        token = await self._get_token()
        ids_str = ",".join(str(pid) for pid in platform_ids)
        body = (
            f"fields name,slug,platforms,first_release_date,genres,cover;"
            f" where platforms = ({ids_str});"
            f" sort popularity desc;"
            f" limit {limit};"
            f" offset {offset};"
        )

        resp = await self._client.post(
            _IGDB_GAMES_URL,
            headers={
                "Authorization": f"Bearer {token}",
                "Client-ID": settings.igdb_client_id,
            },
            content=body,
        )
        resp.raise_for_status()
        games: list[dict[str, Any]] = resp.json()

        self._logger.info(
            "IGDB games ricevuti",
            count=len(games),
            offset=offset,
            platforms=platform_ids,
        )
        return games

    # ── Discovery loop ───────────────────────────────────────────────────────

    async def discover_all_games(self, platform_ids: list[int]) -> int:
        """Scarica tutti i giochi IGDB per le piattaforme e li inserisce nel DB.

        Pagina con offset crescente finché IGDB ritorna lista vuota.
        Inserisce ogni gioco via upserter.find_or_create_game e aggiunge alias.
        Rispetta il rate limit IGDB: 0.25s tra richieste (4 req/s max).
        Ritorna il totale giochi inseriti/aggiornati.
        """
        total = 0
        offset = 0
        limit = 500

        while True:
            try:
                games = await self.fetch_games(platform_ids, offset=offset, limit=limit)
            except Exception as exc:
                self._logger.error(
                    "fetch_games fallito",
                    offset=offset,
                    error=str(exc),
                )
                break

            if not games:
                # Nessun risultato → fine paginazione.
                break

            for game in games:
                game_name: str = game.get("name", "").strip()
                if not game_name:
                    continue
                try:
                    game_id = await self._upserter.find_or_create_game(game_name)
                    await self._insert_aliases(game_id, game_name, game.get("slug"))
                    total += 1
                except Exception as exc:
                    self._logger.error(
                        "find_or_create_game fallito",
                        game=game_name,
                        error=str(exc),
                    )

            offset += limit
            # Rate limiting: max 4 req/s.
            await asyncio.sleep(0.25)

        self._logger.info("discover_all_games completato", total=total, platforms=platform_ids)
        return total

    # ── Aliases ──────────────────────────────────────────────────────────────

    async def _insert_aliases(
        self, game_id: int, game_name: str, igdb_slug: str | None
    ) -> None:
        """Inserisce alias per il gioco: titolo completo + slug IGDB."""
        from src.config.db import _get_pool

        pool = await _get_pool()
        async with pool.connection() as conn:
            # Alias: titolo completo (per match case-insensitive futuro).
            await conn.execute(
                # Inserisce alias titolo + slug IGDB; ignora duplicati.
                "INSERT INTO game_aliases (game_id, alias) VALUES (%s, %s) "
                "ON CONFLICT (game_id, alias) DO NOTHING",
                (game_id, game_name),
            )
            if igdb_slug:
                await conn.execute(
                    # Alias slug IGDB per matching alternativo.
                    "INSERT INTO game_aliases (game_id, alias) VALUES (%s, %s) "
                    "ON CONFLICT (game_id, alias) DO NOTHING",
                    (game_id, igdb_slug),
                )

    async def close(self) -> None:
        """Chiude il client httpx."""
        await self._client.aclose()

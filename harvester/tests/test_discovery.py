"""Test per il modulo Discovery: SeedLoader + IGDBDiscovery — zero HTTP reali."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.discovery.seed_loader import SeedLoader

# Percorso assoluto del file seed principale.
_SEED_FILE = Path(__file__).parents[1] / "seeds" / "top_games.json"


# ── SeedLoader — load_seed_file ───────────────────────────────────────────────


class TestLoadSeedFile:
    def test_parses_valid_json(self) -> None:
        """load_seed_file restituisce lista di dict da JSON valido."""
        data = [
            {"title": "Elden Ring", "slug": "elden-ring", "platforms": ["PS5"], "priority": 1}
        ]
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            json.dump(data, f)
            tmp_path = f.name

        try:
            loader = SeedLoader()
            result = loader.load_seed_file(tmp_path)
            assert isinstance(result, list)
            assert len(result) == 1
            assert result[0]["title"] == "Elden Ring"
            assert result[0]["slug"] == "elden-ring"
        finally:
            os.unlink(tmp_path)

    def test_raises_on_missing_file(self) -> None:
        """FileNotFoundError se il file non esiste."""
        loader = SeedLoader()
        with pytest.raises(FileNotFoundError):
            loader.load_seed_file("/tmp/nonexistent_seed_xyz.json")

    def test_raises_on_non_list_json(self) -> None:
        """ValueError se il JSON non è una lista."""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            json.dump({"title": "Elden Ring"}, f)
            tmp_path = f.name

        try:
            loader = SeedLoader()
            with pytest.raises(ValueError, match="lista JSON"):
                loader.load_seed_file(tmp_path)
        finally:
            os.unlink(tmp_path)


# ── top_games.json — sanity checks ───────────────────────────────────────────


class TestTopGamesSeedFile:
    def test_seed_file_exists(self) -> None:
        """Il file seeds/top_games.json esiste."""
        assert _SEED_FILE.exists(), f"File non trovato: {_SEED_FILE}"

    def test_contains_at_least_20_games(self) -> None:
        """Il seed ha almeno 20 giochi."""
        loader = SeedLoader()
        games = loader.load_seed_file(str(_SEED_FILE))
        assert len(games) >= 20, f"Trovati solo {len(games)} giochi, ne servono ≥ 20"

    def test_every_game_has_required_fields(self) -> None:
        """Ogni gioco ha title, slug, platforms e priority."""
        loader = SeedLoader()
        games = loader.load_seed_file(str(_SEED_FILE))
        for i, game in enumerate(games):
            assert "title" in game, f"Gioco [{i}] manca 'title'"
            assert "slug" in game, f"Gioco [{i}] manca 'slug'"
            assert "platforms" in game, f"Gioco [{i}] manca 'platforms'"
            assert "priority" in game, f"Gioco [{i}] manca 'priority'"
            assert isinstance(game["platforms"], list), f"Gioco [{i}]: platforms deve essere lista"
            assert game["title"], f"Gioco [{i}]: title non può essere vuoto"
            assert game["slug"], f"Gioco [{i}]: slug non può essere vuoto"

    def test_priority_values_are_valid(self) -> None:
        """Priority deve essere un intero ≥ 1."""
        loader = SeedLoader()
        games = loader.load_seed_file(str(_SEED_FILE))
        for game in games:
            assert isinstance(game["priority"], int), f"priority non int: {game['title']}"
            assert game["priority"] >= 1, f"priority < 1: {game['title']}"


# ── IGDBDiscovery — token cache + fetch_games mockati ────────────────────────


class TestIGDBDiscovery:
    @pytest.mark.asyncio
    async def test_get_token_caches_result(self) -> None:
        """_get_token chiama POST una volta sola se il token è ancora valido."""
        from src.discovery.igdb import IGDBDiscovery

        discovery = IGDBDiscovery()
        mock_resp = MagicMock()
        mock_resp.json.return_value = {"access_token": "tok123", "expires_in": 3600}
        mock_resp.raise_for_status = MagicMock()

        with patch.object(
            discovery._client, "post", new_callable=AsyncMock, return_value=mock_resp
        ) as mock_post:
            token1 = await discovery._get_token()
            token2 = await discovery._get_token()

        assert token1 == "tok123"
        assert token2 == "tok123"
        # POST chiamato una sola volta grazie alla cache.
        assert mock_post.call_count == 1
        await discovery.close()

    @pytest.mark.asyncio
    async def test_fetch_games_returns_list(self) -> None:
        """fetch_games ritorna la lista di giochi parsata dal JSON IGDB."""
        from src.discovery.igdb import IGDBDiscovery

        discovery = IGDBDiscovery()
        # Pre-popola il token in cache per saltare il POST OAuth.
        import time

        discovery._token = "cached_token"
        discovery._token_expires_at = time.monotonic() + 3600

        fake_games = [
            {"id": 1, "name": "Elden Ring", "slug": "elden-ring"},
            {"id": 2, "name": "God of War", "slug": "god-of-war"},
        ]
        mock_resp = MagicMock()
        mock_resp.json.return_value = fake_games
        mock_resp.raise_for_status = MagicMock()

        with patch.object(
            discovery._client, "post", new_callable=AsyncMock, return_value=mock_resp
        ):
            games = await discovery.fetch_games([167, 48], offset=0, limit=10)

        assert games == fake_games
        assert len(games) == 2
        await discovery.close()

    @pytest.mark.asyncio
    async def test_discover_all_games_stops_on_empty(self) -> None:
        """discover_all_games si ferma quando fetch_games ritorna lista vuota."""
        from src.discovery.igdb import IGDBDiscovery

        discovery = IGDBDiscovery()

        call_count = 0

        async def fake_fetch_games(platform_ids, offset=0, limit=500):
            nonlocal call_count
            call_count += 1
            # Prima chiamata: 2 giochi; seconda: lista vuota → stop.
            if offset == 0:
                return [{"name": "Elden Ring"}, {"name": "God of War"}]
            return []

        mock_upserter = MagicMock()
        mock_upserter.find_or_create_game = AsyncMock(side_effect=[1, 2])
        discovery._upserter = mock_upserter

        with patch.object(discovery, "fetch_games", side_effect=fake_fetch_games):
            with patch.object(discovery, "_insert_aliases", new_callable=AsyncMock):
                total = await discovery.discover_all_games([167])

        assert total == 2
        assert call_count == 2
        await discovery.close()

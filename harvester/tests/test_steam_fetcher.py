"""Test per SteamAchievementFetcher — tutto mockato, zero chiamate Steam reali."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

# ── Helper ────────────────────────────────────────────────────────────────────


def _make_schema_response(achievements: list[dict]) -> MagicMock:
    """Crea una mock httpx.Response con la struttura Steam GetSchemaForGame."""
    resp = MagicMock()
    resp.raise_for_status.return_value = None
    resp.json.return_value = {
        "game": {
            "gameName": "Test Game",
            "availableGameStats": {"achievements": achievements},
        }
    }
    return resp


def _make_pct_response(percentages: dict[str, float]) -> MagicMock:
    """Crea una mock httpx.Response per GetGlobalAchievementPercentagesForApp."""
    resp = MagicMock()
    resp.raise_for_status.return_value = None
    resp.json.return_value = {
        "achievementpercentages": {
            "achievements": [
                {"name": k, "percent": v} for k, v in percentages.items()
            ]
        }
    }
    return resp


def _sample_achievement(
    apiname: str = "ACH_001", display_name: str = "First Blood"
) -> dict:
    """Achievement fixture con tutti i campi Steam."""
    return {
        "name": apiname,
        "displayName": display_name,
        "description": f"Description for {display_name}",
        "icon": f"https://cdn.steam.com/{apiname}.png",
        "icongray": f"https://cdn.steam.com/{apiname}_gray.png",
    }


# ── Test fetch_game_achievements ──────────────────────────────────────────────


class TestFetchGameAchievements:
    async def test_parses_single_lang_correctly(self) -> None:
        """fetch_game_achievements() parsa la risposta Steam correttamente."""
        from src.discovery.steam_achievement_fetcher import (
            SteamAchievementFetcher,
        )

        fetcher = SteamAchievementFetcher()
        ach = _sample_achievement("ACH_WIN", "Winner")

        async def fake_get(url: str, params: dict) -> MagicMock:
            if "GetSchema" in url:
                return _make_schema_response([ach])
            return _make_pct_response({"ACH_WIN": 45.6})

        with patch.object(fetcher._client, "get", side_effect=fake_get):
            achievements = await fetcher.fetch_game_achievements(12345)

        assert len(achievements) == 1
        a = achievements[0]
        assert a["steam_achievement_id"] == "ACH_WIN"
        assert a["name_en"] == "Winner"
        assert a["detail_en"] == "Description for Winner"
        assert a["icon_url"] == "https://cdn.steam.com/ACH_WIN.png"
        assert abs(a["rarity_pct"] - 45.6) < 0.01

    async def test_multilang_merge(self) -> None:
        """Achievement multilingua vengono mergiati correttamente."""
        from src.discovery.steam_achievement_fetcher import (
            _LANG_MAP,
            SteamAchievementFetcher,
        )

        fetcher = SteamAchievementFetcher()

        async def fake_get(url: str, params: dict) -> MagicMock:
            if "GetSchema" in url:
                lang = params.get("l", "english")
                ach = {
                    "name": "ACH_01",
                    "displayName": f"Name in {lang}",
                    "description": f"Desc in {lang}",
                    "icon": "https://cdn.steam.com/icon.png",
                }
                return _make_schema_response([ach])
            return _make_pct_response({})

        with patch.object(fetcher._client, "get", side_effect=fake_get):
            achievements = await fetcher.fetch_game_achievements(99999)

        assert len(achievements) == 1
        a = achievements[0]
        assert a["name_en"] == "Name in english"
        assert a["name_it"] == "Name in italian"
        assert a["name_fr"] == "Name in french"
        assert a["name_ja"] == "Name in japanese"
        assert a["detail_en"] == "Desc in english"
        assert a["detail_it"] == "Desc in italian"
        # Verifica tutte le 10 lingue
        for lang, (name_f, detail_f) in _LANG_MAP.items():
            assert a[name_f] == f"Name in {lang}"
            assert a[detail_f] == f"Desc in {lang}"

    async def test_empty_game_returns_empty(self) -> None:
        """Gioco senza achievement ritorna lista vuota."""
        from src.discovery.steam_achievement_fetcher import (
            SteamAchievementFetcher,
        )

        fetcher = SteamAchievementFetcher()

        async def fake_get(url: str, params: dict) -> MagicMock:
            if "GetSchema" in url:
                return _make_schema_response([])
            return _make_pct_response({})

        with patch.object(fetcher._client, "get", side_effect=fake_get):
            achievements = await fetcher.fetch_game_achievements(11111)

        assert achievements == []

    async def test_failed_lang_skipped(self) -> None:
        """Una lingua che fallisce non blocca le altre."""
        import httpx

        from src.discovery.steam_achievement_fetcher import (
            SteamAchievementFetcher,
        )

        fetcher = SteamAchievementFetcher()
        call_count = 0

        async def fake_get(url: str, params: dict) -> MagicMock:
            nonlocal call_count
            if "GetSchema" in url:
                call_count += 1
                lang = params.get("l", "english")
                if lang == "japanese":
                    raise httpx.HTTPStatusError(
                        "403", request=MagicMock(), response=MagicMock()
                    )
                ach = {
                    "name": "ACH_01",
                    "displayName": f"Name {lang}",
                    "description": "",
                    "icon": "",
                }
                return _make_schema_response([ach])
            return _make_pct_response({})

        with patch.object(fetcher._client, "get", side_effect=fake_get):
            achievements = await fetcher.fetch_game_achievements(22222)

        assert len(achievements) == 1
        # japanese fallita → name_ja non presente o vuota
        a = achievements[0]
        assert a.get("name_en") == "Name english"
        assert "name_ja" not in a


# ── Test upsert_achievements ──────────────────────────────────────────────────


class TestUpsertAchievements:
    async def test_calls_execute_for_each(self) -> None:
        """upsert_achievements() chiama execute() una volta per achievement."""
        from src.discovery.steam_achievement_fetcher import (
            SteamAchievementFetcher,
        )

        achievements = [
            {
                "steam_achievement_id": "ACH_01",
                "name_en": "First",
                "name_it": "Primo",
                "icon_url": "https://cdn.steam.com/ach01.png",
                "rarity_pct": 50.0,
            },
            {
                "steam_achievement_id": "ACH_02",
                "name_en": "Second",
                "name_it": "Secondo",
                "icon_url": "",
                "rarity_pct": 10.0,
            },
        ]

        fetcher = SteamAchievementFetcher()

        with patch(
            "src.discovery.steam_achievement_fetcher.execute",
            new_callable=AsyncMock,
        ) as mock_exec:
            count = await fetcher.upsert_achievements(
                game_id=1, achievements=achievements
            )

        assert count == 2
        assert mock_exec.call_count == 2

    async def test_empty_list_returns_zero(self) -> None:
        """upsert_achievements() con lista vuota ritorna 0."""
        from src.discovery.steam_achievement_fetcher import (
            SteamAchievementFetcher,
        )

        fetcher = SteamAchievementFetcher()

        with patch(
            "src.discovery.steam_achievement_fetcher.execute",
            new_callable=AsyncMock,
        ) as mock_exec:
            count = await fetcher.upsert_achievements(game_id=1, achievements=[])

        assert count == 0
        mock_exec.assert_not_called()

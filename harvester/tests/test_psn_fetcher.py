"""Test per PsnTrophyFetcher — tutto mockato, zero chiamate PSN reali."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

# ── Helper ────────────────────────────────────────────────────────────────────

def _make_psn_response(trophies: list[dict]) -> MagicMock:
    """Crea una mock httpx.Response con la struttura PSN Trophy API."""
    resp = MagicMock()
    resp.raise_for_status.return_value = None
    resp.json.return_value = {"trophies": trophies}
    return resp


def _sample_trophy(trophy_id: int = 0, trophy_type: str = "platinum") -> dict:
    """Trophy fixture con tutti i campi PSN."""
    return {
        "trophyId": trophy_id,
        "trophyType": trophy_type,
        "trophyName": f"Test Trophy {trophy_id}",
        "trophyDetail": f"Descrizione trofeo {trophy_id}",
        "trophyIconUrl": f"https://cdn.psn.com/trophy_{trophy_id}.png",
        "trophyEarnedRate": "12.5",
    }


# ── Test authenticate ─────────────────────────────────────────────────────────


class TestAuthenticate:
    async def test_returns_false_when_npsso_empty(self) -> None:
        """authenticate() ritorna False e logga warning se PSN_NPSSO è vuoto."""
        from src.discovery.psn_trophy_fetcher import PsnTrophyFetcher

        with patch("src.discovery.psn_trophy_fetcher.settings") as mock_settings:
            mock_settings.psn_npsso = ""
            fetcher = PsnTrophyFetcher()
            result = await fetcher.authenticate()

        assert result is False
        assert fetcher._access_token is None

    async def test_returns_true_from_redis_cache(self) -> None:
        """authenticate() ritorna True usando il token cachato in Redis."""
        from src.discovery.psn_trophy_fetcher import PsnTrophyFetcher

        with (
            patch("src.discovery.psn_trophy_fetcher.settings") as mock_settings,
            patch(
                "src.discovery.psn_trophy_fetcher.redis_client.get",
                new_callable=AsyncMock,
                return_value="cached-token-xyz",
            ),
        ):
            mock_settings.psn_npsso = "valid-npsso"
            fetcher = PsnTrophyFetcher()
            result = await fetcher.authenticate()

        assert result is True
        assert fetcher._access_token == "cached-token-xyz"


# ── Test fetch_game_trophies ──────────────────────────────────────────────────


class TestFetchGameTrophies:
    async def test_parses_response_correctly(self) -> None:
        """fetch_game_trophies() parsa la risposta PSN e mergia le 10 lingue."""
        from src.discovery.psn_trophy_fetcher import PsnTrophyFetcher

        fetcher = PsnTrophyFetcher()
        fetcher._access_token = "test-token"

        mock_resp = _make_psn_response([_sample_trophy(trophy_id=0)])

        with patch.object(fetcher._client, "get", return_value=mock_resp):
            trophies = await fetcher.fetch_game_trophies("NPWR12345_00")

        assert len(trophies) == 1
        t = trophies[0]
        assert t["psn_trophy_id"] == "0"
        assert t["psn_communication_id"] == "NPWR12345_00"
        assert t["trophy_type"] == "platinum"
        assert t["icon_url"] == "https://cdn.psn.com/trophy_0.png"
        assert abs(t["rarity_pct"] - 12.5) < 0.01

    async def test_multilang_fields_mapped_correctly(self) -> None:
        """I nomi multilingua sono mappati ai campi name_XX corretti."""
        from src.discovery.psn_trophy_fetcher import _LANG_FIELD_MAP, PsnTrophyFetcher

        fetcher = PsnTrophyFetcher()
        fetcher._access_token = "test-token"

        # Ogni lingua ritorna un nome diverso per riconoscerle nel merge
        lang_list = list(_LANG_FIELD_MAP.keys())

        call_count = 0

        async def fake_fetch_lang(
            comm_id: str, lang: str, service_name: str = "trophy2"
        ):  # noqa: ANN202
            nonlocal call_count
            call_count += 1
            return lang, {
                0: {
                    "name": f"Name in {lang}",
                    "detail": f"Detail in {lang}",
                    "trophy_type": "gold",
                }
            }

        with patch.object(fetcher, "_fetch_lang", side_effect=fake_fetch_lang):
            trophies = await fetcher.fetch_game_trophies("NPWR99999_00")

        # Probe en-US (1) + 9 lingue rimanenti = 10 chiamate totali
        assert call_count == len(lang_list)
        t = trophies[0]
        assert t["name_en"] == "Name in en-US"
        assert t["name_it"] == "Name in it-IT"
        assert t["name_fr"] == "Name in fr-FR"
        assert t["name_de"] == "Name in de-DE"
        assert t["name_zh_hans"] == "Name in zh-Hans"
        assert t["name_zh_hant"] == "Name in zh-Hant"
        # detail ora in tutte le 10 lingue (migration 022)
        assert t["detail_en"] == "Detail in en-US"
        assert t["detail_it"] == "Detail in it-IT"
        assert t["detail_fr"] == "Detail in fr-FR"

    async def test_failed_language_is_skipped(self) -> None:
        """Una lingua che fallisce non blocca le altre."""
        from src.discovery.psn_trophy_fetcher import PsnTrophyFetcher

        fetcher = PsnTrophyFetcher()
        fetcher._access_token = "test-token"

        call_count = 0

        async def fake_fetch_lang(
            comm_id: str, lang: str, service_name: str = "trophy2"
        ):  # noqa: ANN202
            nonlocal call_count
            call_count += 1
            if lang == "ja-JP":
                raise httpx.HTTPStatusError(
                    "403", request=MagicMock(), response=MagicMock()
                )
            return lang, {0: {"name": f"Name {lang}", "detail": ""}}

        import httpx

        with patch.object(fetcher, "_fetch_lang", side_effect=fake_fetch_lang):
            trophies = await fetcher.fetch_game_trophies("NPWR00001_00")

        # 9 lingue ok, 1 fallita — ma il trofeo è comunque nel risultato
        assert len(trophies) == 1
        assert "name_ja" not in trophies[0] or trophies[0].get("name_ja") is None


# ── Test upsert_trophies ──────────────────────────────────────────────────────


class TestUpsertTrophies:
    async def test_calls_execute_for_each_trophy(self) -> None:
        """upsert_trophies() chiama execute() una volta per trofeo."""
        from src.discovery.psn_trophy_fetcher import PsnTrophyFetcher

        trophies = [
            {
                "psn_trophy_id": "0",
                "psn_communication_id": "NPWR12345_00",
                "trophy_type": "platinum",
                "name_en": "Platinum",
                "name_it": "Platino",
                "name_fr": "", "name_de": "", "name_es": "",
                "name_pt": "", "name_ja": "", "name_ko": "",
                "name_zh_hans": "", "name_zh_hant": "",
                "detail_en": "Get all trophies",
                "detail_it": "Ottieni tutti i trofei",
                "icon_url": "https://cdn.psn.com/plat.png",
                "rarity_pct": 2.3,
            }
        ]

        fetcher = PsnTrophyFetcher()

        with patch(
            "src.discovery.psn_trophy_fetcher.execute", new_callable=AsyncMock
        ) as mock_exec:
            count = await fetcher.upsert_trophies(game_id=1, trophies=trophies)

        assert count == 1
        assert mock_exec.call_count == 1

    async def test_empty_list_returns_zero(self) -> None:
        """upsert_trophies() con lista vuota ritorna 0 senza chiamare execute."""
        from src.discovery.psn_trophy_fetcher import PsnTrophyFetcher

        fetcher = PsnTrophyFetcher()

        with patch(
            "src.discovery.psn_trophy_fetcher.execute", new_callable=AsyncMock
        ) as mock_exec:
            count = await fetcher.upsert_trophies(game_id=1, trophies=[])

        assert count == 0
        mock_exec.assert_not_called()

    async def test_upsert_uses_name_en_as_name(self) -> None:
        """upsert_trophies() usa name_en come valore per la colonna name (NOT NULL)."""
        from src.discovery.psn_trophy_fetcher import PsnTrophyFetcher

        trophy = {
            "psn_trophy_id": "1",
            "psn_communication_id": "NPWR12345_00",
            "trophy_type": "gold",
            "name_en": "The Gold One",
            "name_it": "Quello d'oro",
        }

        fetcher = PsnTrophyFetcher()
        captured_params: list = []

        async def capture_execute(query: str, params: tuple) -> None:
            captured_params.append(params)

        with patch("src.discovery.psn_trophy_fetcher.execute", side_effect=capture_execute):
            await fetcher.upsert_trophies(game_id=5, trophies=[trophy])

        assert len(captured_params) == 1
        params = captured_params[0]
        # game_id è il primo parametro
        assert params[0] == 5
        # name è il secondo parametro — deve essere name_en
        assert params[1] == "The Gold One"

"""PsnTrophyFetcher — recupera nomi ufficiali PSN trofei in 10 lingue.

Autenticazione: NPSSO cookie da PlayStation.com → scambio OAuth → access token.
Token cachato in Redis con TTL 55 min (PSN emette token da ~60 min).
Richiede PSN_NPSSO in .env. Se assente: fetcher disabilitato silenziosamente.
Tutte le chiamate per lingua sono parallele via asyncio.gather.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx

from src.config.db import execute, fetch_one
from src.config.logger import get_logger
from src.config.redis_client import redis_client
from src.config.settings import settings

# ── Costanti ──────────────────────────────────────────────────────────────────

_PSN_TROPHY_URL = (
    "https://m.np.playstation.com/api/trophy/v1"
    "/npCommunicationIds/{comm_id}/trophyGroups/all/trophies"
)
_REDIS_TOKEN_KEY = "psn:access_token"
_REDIS_TOKEN_TTL = 3300  # 55 minuti (token PSN durano ~60 min)
_INTER_BATCH_DELAY_S = 0.1  # 100ms tra batch per rispettare rate limit PSN

# Lingue supportate → colonne DB (da migration 017)
_LANG_FIELD_MAP: dict[str, str] = {
    "en-US": "name_en",
    "it-IT": "name_it",
    "fr-FR": "name_fr",
    "de-DE": "name_de",
    "es-ES": "name_es",
    "pt-PT": "name_pt",
    "ja-JP": "name_ja",
    "ko-KR": "name_ko",
    "zh-Hans": "name_zh_hans",
    "zh-Hant": "name_zh_hant",
}

# Descrizioni trofei in tutte le lingue (migration 017 + 022)
_DETAIL_LANG_TO_FIELD: dict[str, str] = {
    "en-US": "detail_en",
    "it-IT": "detail_it",
    "fr-FR": "detail_fr",
    "de-DE": "detail_de",
    "es-ES": "detail_es",
    "pt-PT": "detail_pt",
    "ja-JP": "detail_ja",
    "ko-KR": "detail_ko",
    "zh-Hans": "detail_zh_hans",
    "zh-Hant": "detail_zh_hant",
}


# ── Classe principale ──────────────────────────────────────────────────────────


class PsnTrophyFetcher:
    """Recupera trofei ufficiali PSN con nomi multilingua e li salva nel DB."""

    def __init__(self) -> None:
        self._logger = get_logger(self.__class__.__name__)
        self._client = httpx.AsyncClient(timeout=15.0)
        self._access_token: str | None = None
        # Semaphore: max 5 richieste PSN parallele (conservativo, ~10 req/s)
        self._sem = asyncio.Semaphore(5)

    # ── Auth ──────────────────────────────────────────────────────────────────

    async def authenticate(self) -> bool:
        """Autentica con PSN via NPSSO. Cacha il token in Redis.

        Ritorna False e logga warning se PSN_NPSSO non è configurato.
        Il fetcher è opzionale: il sistema funziona anche senza.
        """
        if not settings.psn_npsso:
            self._logger.warning(
                "PSN_NPSSO non configurato — PsnTrophyFetcher disabilitato"
            )
            return False

        # 1. Controlla cache Redis prima di fare OAuth
        try:
            cached = await redis_client.get(_REDIS_TOKEN_KEY)
        except Exception as exc:
            self._logger.warning("Redis non disponibile per cache PSN", error=str(exc))
            cached = None

        if cached:
            self._access_token = cached
            self._logger.info("Token PSN caricato da Redis")
            return True

        # 2. Scambia NPSSO → access token tramite psnawp (sync → asyncio.to_thread)
        try:
            from psnawp_api import PSNAWP  # lazy import — dipendenza opzionale

            def _auth_sync(npsso: str) -> str:
                """Tutto in un unico thread: crea PSNAWP, accede a me.online_id
                per triggerare la HTTP call reale, ritorna l'access token."""
                p = PSNAWP(npsso)
                me = p.me()
                _ = me.online_id  # forza la richiesta OAuth effettiva
                return p.authenticator.token_response["access_token"]

            token: str = await asyncio.to_thread(_auth_sync, settings.psn_npsso)
            try:
                await redis_client.setex(_REDIS_TOKEN_KEY, _REDIS_TOKEN_TTL, token)
            except Exception as exc:
                self._logger.warning("Cache Redis PSN fallita (non fatale)", error=str(exc))
            self._access_token = token
            self._logger.info("Token PSN ottenuto e cachato", ttl_s=_REDIS_TOKEN_TTL)
            return True
        except ImportError:
            self._logger.error(
                "psnawp non installato — aggiungi 'psnawp>=2.0' a pyproject.toml"
            )
            return False
        except Exception as exc:
            self._logger.error("Autenticazione PSN fallita", error=str(exc))
            return False

    # ── Fetch singola lingua ───────────────────────────────────────────────────

    async def _fetch_lang(
        self, comm_id: str, lang: str, service_name: str = "trophy2"
    ) -> tuple[str, dict[int, dict[str, Any]]]:
        """Fetcha nomi trofei per una singola lingua.

        Ritorna (lang, {trophy_id: {name, detail?, trophy_type?, icon_url?, rarity_pct?}}).
        I metadati non-localizzati (type, icon, rarity) sono inclusi solo se presenti —
        sono uguali per tutte le lingue, il caller li prende dalla prima call valida.
        service_name: 'trophy2' per PS5 (PPSA), 'trophy' per PS4 (CUSA/BCUS/BCES).
        """
        url = _PSN_TROPHY_URL.format(comm_id=comm_id)
        headers = {
            "Authorization": f"Bearer {self._access_token}",
            "Accept-Language": lang,
        }
        params = {"npServiceName": service_name}
        async with self._sem:
            resp = await self._client.get(url, headers=headers, params=params)
            resp.raise_for_status()

        result: dict[int, dict[str, Any]] = {}
        for trophy in resp.json().get("trophies", []):
            tid = trophy.get("trophyId")
            if tid is None:
                continue
            entry: dict[str, Any] = {
                "name": trophy.get("trophyName", ""),
                "detail": trophy.get("trophyDetail", ""),
            }
            if trophy.get("trophyType"):
                entry["trophy_type"] = trophy["trophyType"]
            if trophy.get("trophyIconUrl"):
                entry["icon_url"] = trophy["trophyIconUrl"]
            earned_rate = trophy.get("trophyEarnedRate")
            if earned_rate is not None:
                try:
                    entry["rarity_pct"] = float(earned_rate)
                except (ValueError, TypeError):
                    pass
            result[tid] = entry

        return lang, result

    # ── Fetch tutte le lingue ─────────────────────────────────────────────────

    async def fetch_game_trophies(self, psn_communication_id: str) -> list[dict]:
        """Fetcha tutti i trofei del gioco in 10 lingue in parallelo.

        Ritorna lista di dict pronti per upsert_trophies.
        Auto-rileva PS5 (npServiceName=trophy2) o PS4 (npServiceName=trophy)
        con una probe call su en-US prima di lanciare le 9 lingue rimanenti.
        """
        langs = list(_LANG_FIELD_MAP.keys())

        # ── Probe: determina se PS5 (trophy2) o PS4 (trophy) ────────────────
        service_name = "trophy2"
        probe_result: tuple | Exception | None = None
        try:
            probe_result = await self._fetch_lang(
                psn_communication_id, "en-US", service_name="trophy2"
            )
            if not probe_result[1]:  # lista vuota → prova trophy
                raise ValueError("trophy2 returned empty list")
        except Exception:
            self._logger.info(
                "trophy2 non disponibile — provo npServiceName=trophy (PS4)",
                psn_communication_id=psn_communication_id,
            )
            service_name = "trophy"
            probe_result = None  # sarà incluso nel gather sotto

        # ── Fetch tutte le lingue (en-US già disponibile se probe ok) ───────
        remaining_langs = (
            [lg for lg in langs if lg != "en-US"] if probe_result else langs
        )
        raw_results_rest = await asyncio.gather(
            *[
                self._fetch_lang(psn_communication_id, lang, service_name)
                for lang in remaining_langs
            ],
            return_exceptions=True,
        )

        # Ricostruisce la lista completa: probe (se ok) + resto
        raw_results: list = []
        if probe_result is not None and not isinstance(probe_result, Exception):
            raw_results.append(probe_result)
        raw_results.extend(raw_results_rest)

        # Delay post-batch: 100ms per rispettare il rate limit PSN non documentato
        await asyncio.sleep(_INTER_BATCH_DELAY_S)

        # Merge: {trophy_id → dict con tutti i campi}
        merged: dict[int, dict[str, Any]] = {}
        for result in raw_results:
            if isinstance(result, Exception):
                self._logger.warning("Chiamata PSN per lingua fallita", error=str(result))
                continue

            lang, trophy_data = result
            name_field = _LANG_FIELD_MAP[lang]
            detail_field = _DETAIL_LANG_TO_FIELD.get(lang)

            for trophy_id, data in trophy_data.items():
                if trophy_id not in merged:
                    merged[trophy_id] = {
                        "psn_trophy_id": str(trophy_id),
                        "psn_communication_id": psn_communication_id,
                    }
                    # Metadati non-localizzati: presi dalla prima call valida
                    for meta_key in ("trophy_type", "icon_url", "rarity_pct"):
                        if meta_key in data:
                            merged[trophy_id][meta_key] = data[meta_key]

                merged[trophy_id][name_field] = data["name"]
                if detail_field is not None:
                    merged[trophy_id][detail_field] = data["detail"]

        self._logger.info(
            "Trofei PSN fetchati",
            psn_communication_id=psn_communication_id,
            count=len(merged),
        )
        return list(merged.values())

    # ── Upsert DB ─────────────────────────────────────────────────────────────

    async def upsert_trophies(self, game_id: int, trophies: list[dict]) -> int:
        """Inserisce o aggiorna i trofei nel DB con nomi multilingua.

        ON CONFLICT sull'indice parziale (psn_communication_id, psn_trophy_id).
        Ritorna il numero di trofei processati (inseriti + aggiornati).
        """
        if not trophies:
            return 0

        for trophy in trophies:
            # name (NOT NULL) = name_en come fonte autorevole PSN
            name = trophy.get("name_en") or trophy.get("name", "") or ""
            await execute(
                """
                -- Upsert trofeo PSN: inserisce se nuovo, aggiorna nomi+descrizioni se esiste.
                -- ON CONFLICT sull'indice parziale idx_trophies_psn_id (migration 017).
                -- Nomi e descrizioni in 10 lingue (migration 017 + 022).
                INSERT INTO trophies (
                    game_id, name, type, hidden, rarity_pct, icon_url,
                    psn_trophy_id, psn_communication_id,
                    name_en, name_it, name_fr, name_de, name_es,
                    name_pt, name_ja, name_ko, name_zh_hans, name_zh_hant,
                    detail_en, detail_it, detail_fr, detail_de, detail_es,
                    detail_pt, detail_ja, detail_ko, detail_zh_hans, detail_zh_hant,
                    rarity_source
                ) VALUES (
                    %s, %s, %s, false, %s, %s,
                    %s, %s,
                    %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s,
                    'psn_official'
                )
                ON CONFLICT (psn_communication_id, psn_trophy_id)
                WHERE psn_trophy_id IS NOT NULL
                DO UPDATE SET
                    name_en       = EXCLUDED.name_en,
                    name_it       = EXCLUDED.name_it,
                    name_fr       = EXCLUDED.name_fr,
                    name_de       = EXCLUDED.name_de,
                    name_es       = EXCLUDED.name_es,
                    name_pt       = EXCLUDED.name_pt,
                    name_ja       = EXCLUDED.name_ja,
                    name_ko       = EXCLUDED.name_ko,
                    name_zh_hans  = EXCLUDED.name_zh_hans,
                    name_zh_hant  = EXCLUDED.name_zh_hant,
                    detail_en     = EXCLUDED.detail_en,
                    detail_it     = EXCLUDED.detail_it,
                    detail_fr     = EXCLUDED.detail_fr,
                    detail_de     = EXCLUDED.detail_de,
                    detail_es     = EXCLUDED.detail_es,
                    detail_pt     = EXCLUDED.detail_pt,
                    detail_ja     = EXCLUDED.detail_ja,
                    detail_ko     = EXCLUDED.detail_ko,
                    detail_zh_hans = EXCLUDED.detail_zh_hans,
                    detail_zh_hant = EXCLUDED.detail_zh_hant,
                    icon_url      = EXCLUDED.icon_url,
                    rarity_pct    = COALESCE(EXCLUDED.rarity_pct, trophies.rarity_pct),
                    rarity_source = 'psn_official'
                """,
                (
                    game_id,
                    name,
                    trophy.get("trophy_type"),
                    trophy.get("rarity_pct"),
                    trophy.get("icon_url"),
                    trophy.get("psn_trophy_id"),
                    trophy.get("psn_communication_id"),
                    trophy.get("name_en", ""),
                    trophy.get("name_it", ""),
                    trophy.get("name_fr", ""),
                    trophy.get("name_de", ""),
                    trophy.get("name_es", ""),
                    trophy.get("name_pt", ""),
                    trophy.get("name_ja", ""),
                    trophy.get("name_ko", ""),
                    trophy.get("name_zh_hans", ""),
                    trophy.get("name_zh_hant", ""),
                    trophy.get("detail_en", ""),
                    trophy.get("detail_it", ""),
                    trophy.get("detail_fr", ""),
                    trophy.get("detail_de", ""),
                    trophy.get("detail_es", ""),
                    trophy.get("detail_pt", ""),
                    trophy.get("detail_ja", ""),
                    trophy.get("detail_ko", ""),
                    trophy.get("detail_zh_hans", ""),
                    trophy.get("detail_zh_hant", ""),
                ),
            )

        self._logger.info("Trofei upsertati nel DB", game_id=game_id, count=len(trophies))
        return len(trophies)

    # ── Risoluzione comm_id ───────────────────────────────────────────────────

    async def _resolve_comm_id(self, game_id: int, game_title: str) -> str | None:
        """Cerca il psn_communication_id per un gioco.

        Strategia:
        1. games.metadata['psn_communication_id'] (pre-popolato manualmente o da IGDB)
        2. Trofei già presenti in DB con psn_communication_id valorizzato
        """
        # 1. games.metadata JSONB
        row = await fetch_one(
            "SELECT metadata FROM games WHERE id = %s",
            (game_id,),
        )
        if row and isinstance(row.get("metadata"), dict):
            comm_id = row["metadata"].get("psn_communication_id")
            if comm_id:
                return str(comm_id)

        # 2. Trofei già presenti per questo gioco
        row = await fetch_one(
            """SELECT psn_communication_id
               FROM trophies
               WHERE game_id = %s AND psn_communication_id IS NOT NULL
               LIMIT 1""",
            (game_id,),
        )
        if row and row.get("psn_communication_id"):
            return str(row["psn_communication_id"])

        self._logger.warning(
            "psn_communication_id non trovato — popolare games.metadata prima",
            game_id=game_id,
            game_title=game_title,
        )
        return None

    # ── Entry point ad alto livello ────────────────────────────────────────────

    async def fetch_and_store_for_game(self, game_id: int, game_title: str) -> int:
        """Fetch + store per un singolo gioco. Entry point ad alto livello.

        Richiede authenticate() chiamato prima. Ritorna 0 se non autenticato
        o se psn_communication_id non è disponibile nel DB.
        """
        if not self._access_token:
            self._logger.warning(
                "fetch_and_store_for_game chiamato senza token — chiamare authenticate() prima",
                game_title=game_title,
            )
            return 0

        comm_id = await self._resolve_comm_id(game_id, game_title)
        if not comm_id:
            return 0

        try:
            trophies = await self.fetch_game_trophies(comm_id)
            count = await self.upsert_trophies(game_id, trophies)
            self._logger.info(
                "fetch_and_store_for_game completato",
                game_id=game_id,
                game_title=game_title,
                trophies_upserted=count,
            )
            return count
        except Exception as exc:
            self._logger.error(
                "fetch_and_store_for_game fallito",
                game_id=game_id,
                game_title=game_title,
                error=str(exc),
            )
            return 0

    async def close(self) -> None:
        """Chiude il client httpx. Da chiamare allo shutdown."""
        await self._client.aclose()

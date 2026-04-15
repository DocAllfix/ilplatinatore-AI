"""PsnGameFinder — scopre il psn_communication_id per ogni gioco del seed.

Usa psnawp per cercare ogni gioco su PSN Store, estrae il title_id dal
defaultProduct, poi chiama game_title() per ottenere il np_communication_id.
Salva il risultato in games.metadata per uso successivo da PsnTrophyFetcher.

Matching nome: verifica sempre invariantName (nome canonico PSN, sempre presente)
PRIMA di considerare il defaultProduct. Questo evita di accettare giochi con
nome simile ma sbagliato (es. "Hades" quando si cerca "Hades II").

Tutte le chiamate psnawp sono sync → wrappate in asyncio.to_thread.
"""

from __future__ import annotations

import asyncio
import difflib
import re
import unicodedata
from typing import TYPE_CHECKING, Any

from src.config.db import execute, fetch_all
from src.config.logger import get_logger

if TYPE_CHECKING:
    from psnawp_api import PSNAWP

# Regex per estrarre il title_id dal product_id PSN.
# Formato: EP0700-PPSA04609_00-ELDENRING0000000 → PPSA04609_00
# Copre PS5 (PPSA), PS4 (CUSA), PS3 (BCUS/BCES), e altri prefissi.
_TITLE_ID_RE = re.compile(r"[A-Z]{2,4}\d{5}_\d{2}")

# Delay tra ricerche consecutive per non sovraccaricare l'API PSN Store.
_SEARCH_DELAY_S = 0.5

# Numero di risultati PSN da esaminare per ogni ricerca.
# 5 offre migliore copertura senza aumentare significativamente il rischio di falsi positivi.
_SEARCH_LIMIT = 5

# Soglia minima di similarity (SequenceMatcher ratio) per il fallback fuzzy.
# 0.82 accetta varianti ortografiche (Ragnarök/Ragnarok) ma rifiuta titoli diversi.
_NAME_SIMILARITY_THRESHOLD = 0.82


class PsnGameFinder:
    """Scopre il np_communication_id PSN per ogni gioco e lo salva in DB."""

    def __init__(self, psnawp: "PSNAWP") -> None:
        self._psnawp = psnawp
        self._logger = get_logger(self.__class__.__name__)

    # ── Helpers sync (girano in asyncio.to_thread) ─────────────────────────

    def _extract_title_id(self, product_id: str) -> str | None:
        """Estrae il title_id dal product_id PSN (parte centrale)."""
        match = _TITLE_ID_RE.search(product_id)
        return match.group() if match else None

    def _get_platform(self, title_id: str) -> Any:
        """Mappa il prefisso del title_id alla piattaforma psnawp."""
        from psnawp_api.models.game_title import PlatformType

        if title_id.startswith("PPSA"):
            return PlatformType.PS5
        return PlatformType.PS4

    @staticmethod
    def _normalize(s: str) -> str:
        """Normalizza stringa per confronto: minuscolo, senza accenti né punteggiatura."""
        # NFKD decompone i caratteri accentati (ö → o + combining)
        s = unicodedata.normalize("NFKD", s.lower().strip())
        # Rimuove combining characters (accenti, dieresi, ecc.)
        s = "".join(c for c in s if not unicodedata.combining(c))
        # Punteggiatura → spazio
        for ch in ":,'-.!?()[]/\\":
            s = s.replace(ch, " ")
        # Collassa spazi multipli
        return " ".join(s.split())

    @classmethod
    def _is_name_match(cls, query: str, candidate: str) -> bool:
        """Verifica se il nome PSN corrisponde alla query di ricerca.

        Strategia a due livelli:

        1. Token-subset: tutti i token della query devono essere presenti nei
           token del candidato. Questo garantisce che "Hades II" non venga
           accettato da "Hades" ({"hades","ii"} ⊄ {"hades"}), ma accetta
           "Hades II Digital Deluxe Edition" ({"hades","ii"} ⊆ {…}).

        2. Fallback similarity ≥ 0.82: gestisce varianti ortografiche come
           "Ragnarök" vs "Ragnarok", sottotitoli leggermente diversi per
           regione, o errori di traslitterazione.

        Entrambi operano su stringhe normalizzate (NFKD, no accenti, no punti).
        """
        if not query or not candidate:
            return False

        q = cls._normalize(query)
        c = cls._normalize(candidate)

        if q == c:
            return True

        q_tokens = set(q.split())
        c_tokens = set(c.split())

        # Tutti i token della query presenti nel candidato (può avere token extra)
        if q_tokens and q_tokens.issubset(c_tokens):
            return True

        # Veto: token brevi (≤3 chars: numeri "2","3" e cifre romane "ii","iv") nella
        # query devono essere presenti nel candidato. Senza questo, la similarity al
        # 92% di "Red Dead Redemption 2" vs "Red Dead Redemption" supererebbe la soglia.
        q_short = {t for t in q_tokens if len(t) <= 3}
        if q_short and not q_short.issubset(c_tokens):
            return False

        # Fallback: similarity ratio per varianti ortografiche
        # (es. "Ragnarök" → "Ragnarok" dopo NFKD, sottotitoli con punteggiatura diversa)
        ratio = difflib.SequenceMatcher(None, q, c).ratio()
        return ratio >= _NAME_SIMILARITY_THRESHOLD

    def _find_comm_id_sync(self, game_title: str) -> str | None:
        """Cerca il gioco su PSN e ritorna il np_communication_id.

        Sincrono — da chiamare via asyncio.to_thread.

        Algoritmo:
          1. Cerca su PSN Store (limit=5)
          2. Per ogni risultato estrae invariantName (nome canonico inglese PSN,
             sempre presente anche senza defaultProduct) e lo valida contro il
             titolo cercato PRIMA di procedere.
          3. Se il nome corrisponde ma defaultProduct è assente → gioco trovato
             ma trophy list non ancora disponibile (uscita troppo recente).
             Segna il fatto e continua sugli altri risultati (potrebbe esserci
             un bundle/edizione con prodotto). NON scivola su giochi con nome
             diverso.
          4. Se il nome corrisponde e il prodotto c'è → valida anche il nome del
             prodotto come check secondario, poi estrae title_id → comm_id.
          5. Dopo il loop: messaggi distinti per "non trovato" vs "trovato ma
             non ancora disponibile".
        """
        from psnawp_api.models.search import SearchDomain

        try:
            results = list(
                self._psnawp.search(game_title, SearchDomain.FULL_GAMES, limit=_SEARCH_LIMIT)
            )
        except Exception as exc:
            self._logger.error("PSN search fallita", game_title=game_title, error=str(exc))
            return None

        # True se abbiamo trovato almeno un risultato con nome corretto ma senza prodotto.
        # Usato per dare un messaggio di errore più preciso alla fine.
        found_name_no_product = False

        for result in results:
            res = result.get("result", {})

            # invariantName = nome canonico inglese del gioco su PSN.
            # È sempre presente anche quando defaultProduct è None (gioco nuovo).
            # Preferito a defaultProduct.name che può contenere nomi di edizioni/bundle.
            canonical_name = res.get("invariantName") or res.get("name", "")

            # ── Verifica nome PRIMA di tutto ──────────────────────────────────
            if not self._is_name_match(game_title, canonical_name):
                self._logger.debug(
                    "Risultato PSN scartato — nome non corrisponde",
                    searched=game_title,
                    found=canonical_name,
                )
                continue

            # Nome corrisponde — controlla se esiste un prodotto acquistabile
            product = res.get("defaultProduct")
            if not product:
                # Gioco trovato su PSN Store ma senza prodotto collegato.
                # Tipico delle uscite recentissime: il catalogo PSN si aggiorna
                # ore/giorni dopo il lancio. Segniamo e continuiamo: potrebbe
                # esserci un bundle o edizione speciale nei risultati successivi.
                found_name_no_product = True
                self._logger.info(
                    "Gioco trovato su PSN ma senza defaultProduct (uscita recente?)",
                    game_title=game_title,
                    psn_canonical=canonical_name,
                )
                continue

            # Check secondario: il nome del prodotto deve essere coerente.
            # Evita bundle che includono giochi con nomi simili (es. collection).
            product_name = product.get("name", "")
            if product_name and not self._is_name_match(game_title, product_name):
                self._logger.debug(
                    "Prodotto PSN scartato — nome prodotto non corrisponde",
                    searched=game_title,
                    canonical=canonical_name,
                    product_name=product_name,
                )
                continue

            product_id = product.get("id", "")
            title_id = self._extract_title_id(product_id)
            if not title_id:
                self._logger.warning(
                    "title_id non estratto dal product_id",
                    product_id=product_id,
                    game_title=game_title,
                )
                continue

            platform = self._get_platform(title_id)
            try:
                gt = self._psnawp.game_title(
                    title_id=title_id,
                    platform=platform,
                    # Account ID default PSN: fetch del set ufficiale, non di un utente
                    account_id="6515971742264256071",
                )
                comm_id: str | None = gt.np_communication_id
                if comm_id:
                    self._logger.info(
                        "comm_id trovato",
                        game_title=game_title,
                        psn_canonical=canonical_name,
                        title_id=title_id,
                        comm_id=comm_id,
                    )
                    return comm_id
            except Exception as exc:
                self._logger.warning(
                    "game_title() fallito",
                    title_id=title_id,
                    game_title=game_title,
                    error=str(exc),
                )
                continue

        # ── Nessun risultato valido — messaggio distinto per ogni caso ────────
        if found_name_no_product:
            self._logger.warning(
                "Trophy list PSN non ancora disponibile — riprovare tra qualche ora/giorno",
                game_title=game_title,
            )
        else:
            self._logger.warning(
                "comm_id non trovato — gioco non presente su PSN Store o titolo diverso",
                game_title=game_title,
            )
        return None

    # ── API async ─────────────────────────────────────────────────────────

    async def find_comm_id(self, game_title: str) -> str | None:
        """Async wrapper attorno a _find_comm_id_sync."""
        return await asyncio.to_thread(self._find_comm_id_sync, game_title)

    async def populate_all_games(self) -> dict[str, int]:
        """Popola games.metadata['psn_communication_id'] per tutti i giochi del DB.

        Salta i giochi che hanno già il comm_id. Ritorna stats:
        {'found': N, 'skipped': N, 'failed': N}
        """
        # Solo giochi presenti su PlayStation: filtriamo per platform array.
        # Un gioco PC-only o Xbox-only non va interrogato su PSN Store — spreco
        # di tempo garantito (3s per gioco). Accettiamo anche giochi con
        # platform legacy vuoto/NULL (pre-IGDB) per retrocompatibilità.
        games = await fetch_all(
            """
            SELECT id, title, metadata
            FROM games
            WHERE 'PS4' = ANY(platform)
               OR 'PS5' = ANY(platform)
               OR platform IS NULL
               OR platform = '{}'
            ORDER BY id
            """,
        )

        stats = {"found": 0, "skipped": 0, "failed": 0}

        for game in games:
            game_id: int = game["id"]
            title: str = game["title"]
            metadata: dict = game.get("metadata") or {}

            # Salta se già popolato
            if metadata.get("psn_communication_id"):
                self._logger.info("comm_id già presente — skip", game_title=title)
                stats["skipped"] += 1
                continue

            comm_id = await self.find_comm_id(title)

            if not comm_id:
                stats["failed"] += 1
                continue

            # Merge JSONB: aggiunge psn_communication_id senza sovrascrivere altri campi
            await execute(
                """
                -- Aggiorna metadata del gioco con il psn_communication_id scoperto.
                UPDATE games
                SET metadata = metadata || jsonb_build_object('psn_communication_id', %s::text)
                WHERE id = %s
                """,
                (comm_id, game_id),
            )
            stats["found"] += 1

            # Pausa tra ricerche per rispettare il rate limit PSN Store
            await asyncio.sleep(_SEARCH_DELAY_S)

        self._logger.info(
            "populate_all_games completato",
            found=stats["found"],
            skipped=stats["skipped"],
            failed=stats["failed"],
        )
        return stats

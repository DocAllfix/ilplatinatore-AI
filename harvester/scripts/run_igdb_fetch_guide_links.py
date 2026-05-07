"""Harvester guide links: trova e salva URL verificati per i giochi più popolari.

Strategia:
  - Processa solo i top N giochi per igdb_rating_count (default 5000)
  - Per ogni gioco chiama Tavily con query specifiche (trophy/walkthrough/general)
  - Valida ogni URL trovato: scarica il testo e verifica che contenga il titolo del gioco
  - Salva max 2 URL per tipo in game_guide_links (idempotente)
  - Checkpoint JSON per resume

Uso:
  cd harvester
  python scripts/run_igdb_fetch_guide_links.py               # top 5000
  python scripts/run_igdb_fetch_guide_links.py --limit 500   # solo top 500
  python scripts/run_igdb_fetch_guide_links.py --resume      # riprende da checkpoint
  python scripts/run_igdb_fetch_guide_links.py --dry-run     # nessuna scrittura DB
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

import httpx

sys.path.insert(0, str(Path(__file__).parent.parent))

# Carica .env prima di importare settings (CWD potrebbe non essere harvester/)
_env_file = Path(__file__).parent.parent / ".env"
if _env_file.exists():
    from dotenv import load_dotenv
    load_dotenv(_env_file, override=False)

_CHECKPOINT_FILE = Path(__file__).parent.parent / "data" / "guide_links_checkpoint.json"
_BATCH_SIZE = 50       # giochi per batch (Tavily ha rate limit)
_TAVILY_DELAY_S = 1.0  # secondi tra chiamate Tavily
_FETCH_TIMEOUT_S = 10  # timeout HTTP per validazione URL
_MIN_CONTENT_LEN = 200 # chars minimi per considerare il contenuto valido

# Domini fidati — include wiki/fandom/fextralife per lore e build
TRUSTED_DOMAINS = {
    # Trophy / achievement
    "powerpyx.com",
    "playstationtrophies.org",
    "trueachievements.com",
    "psnprofiles.com",
    "exophase.com",
    "trophygamers.com",
    # Guide generali
    "ign.com",
    "gamefaqs.gamespot.com",
    "gamesradar.com",
    "pushsquare.com",
    "thegamer.com",
    "gamepressure.com",
    "wikigameguides.com",
    "neoseeker.com",
    "guide-ps4.fr",
    "jeuxvideo.com",
    "supersoluce.com",
    # Wiki / lore / build — aggiunto per lore e build
    "fandom.com",
    "fextralife.com",
    "wiki.fextralife.com",
    "gameinfo.io",
    "screenrant.com",
}

# Domini di alta affidabilità per lore/build/wiki
_LORE_BUILD_TIER = {"fandom.com", "fextralife.com", "wiki.fextralife.com", "gamefaqs.gamespot.com", "neoseeker.com"}

# Query Tavily per tipo di guida
GUIDE_QUERIES = [
    ("trophy",      "{title} trophy guide"),
    ("walkthrough", "{title} complete walkthrough guide"),
    ("general",     "{title} game guide"),
    ("lore",        "{title} lore story wiki"),
    ("build",       "{title} best build guide"),
]


def _extract_domain(url: str) -> str:
    try:
        h = urlparse(url).hostname or ""
        return h.removeprefix("www.")
    except Exception:
        return ""


def _is_trusted(url: str) -> bool:
    domain = _extract_domain(url)
    if domain in TRUSTED_DOMAINS:
        return True
    return any(domain.endswith(f".{td}") for td in TRUSTED_DOMAINS)


def _reliability_score(url: str) -> float:
    domain = _extract_domain(url)
    top_tier = {"powerpyx.com", "playstationtrophies.org", "trueachievements.com",
                "psnprofiles.com", "exophase.com"}
    lore_build_tier = {"fandom.com", "fextralife.com", "wiki.fextralife.com",
                       "gamefaqs.gamespot.com", "neoseeker.com"}
    if domain in top_tier:
        return 0.95
    if domain in lore_build_tier or any(domain.endswith(f".{d}") for d in lore_build_tier):
        return 0.88
    if domain in TRUSTED_DOMAINS:
        return 0.80
    return 0.60


def _title_in_text(title: str, text: str) -> bool:
    """Verifica che almeno una parola significativa del titolo sia nel testo."""
    words = [w for w in re.split(r"[\s\-:]+", title.lower()) if len(w) > 3]
    text_lower = text[:3000].lower()
    return any(w in text_lower for w in words)


async def _fetch_page_text_inner(client: httpx.AsyncClient, url: str) -> str | None:
    resp = await client.get(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; PlatinatoreAI/1.0)",
            "Accept": "text/html,application/xhtml+xml",
        },
        follow_redirects=True,
        timeout=httpx.Timeout(connect=5.0, read=8.0, write=5.0, pool=5.0),
    )
    if resp.status_code != 200:
        return None
    html = resp.text
    # Estrazione testo minimale
    text = re.sub(r"<script[^>]*>[\s\S]*?</script>", " ", html, flags=re.IGNORECASE)
    text = re.sub(r"<style[^>]*>[\s\S]*?</style>", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]{0,500}>", " ", text)
    text = re.sub(r"\s{3,}", "\n", text).strip()
    return text if len(text) >= _MIN_CONTENT_LEN else None


async def _fetch_page_text(client: httpx.AsyncClient, url: str) -> str | None:
    """Scarica una pagina con doppio guard: timeout httpx + asyncio.wait_for esterno."""
    try:
        return await asyncio.wait_for(_fetch_page_text_inner(client, url), timeout=12.0)
    except Exception:
        return None


async def _call_tavily_inner(session: httpx.AsyncClient, query: str, tavily_key: str) -> list[dict]:
    resp = await session.post(
        "https://api.tavily.com/search",
        json={
            "query": query,
            "search_depth": "basic",
            "include_answer": False,
            "include_raw_content": False,
            "max_results": 5,
            "include_domains": list(TRUSTED_DOMAINS),
        },
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {tavily_key}",
        },
        timeout=httpx.Timeout(connect=5.0, read=12.0, write=5.0, pool=5.0),
    )
    if resp.status_code != 200:
        # 429/432 = quota exceeded — raise so caller can abort early
        if resp.status_code in (429, 432):
            raise RuntimeError(f"Tavily quota exceeded (HTTP {resp.status_code})")
        return []
    data = resp.json()
    return [r for r in (data.get("results") or []) if _is_trusted(r.get("url", ""))]


async def _call_tavily(session: httpx.AsyncClient, query: str, tavily_key: str) -> list[dict]:
    """Chiama Tavily con doppio guard timeout. Propaga RuntimeError per quota exceeded."""
    try:
        return await asyncio.wait_for(_call_tavily_inner(session, query, tavily_key), timeout=20.0)
    except RuntimeError:
        raise  # quota exceeded — let caller handle abort
    except Exception:
        return []


async def process_game(
    game: dict,
    tavily_key: str,
    tavily_client: httpx.AsyncClient,
    fetch_client: httpx.AsyncClient,
    execute,
    logger,
    dry_run: bool,
) -> int:
    """Processa un gioco: cerca link Tavily, valida, salva. Ritorna il numero di link salvati."""
    title = game["title"]
    game_id = game["id"]
    saved = 0

    for guide_type, query_tpl in GUIDE_QUERIES:
        query = query_tpl.format(title=title)
        results = await _call_tavily(tavily_client, query, tavily_key)
        await asyncio.sleep(_TAVILY_DELAY_S)

        for r in results[:3]:  # al massimo 3 candidati per tipo
            url = r.get("url", "")
            if not url or not _is_trusted(url):
                continue

            # Validazione: scarica la pagina e verifica che parli del gioco
            text = await _fetch_page_text(fetch_client, url)
            if text is None:
                logger.debug(f"    [skip] {url} — fetch fallito o testo troppo corto")
                continue
            if not _title_in_text(title, text):
                logger.debug(f"    [skip] {url} — titolo '{title}' non trovato nel testo")
                continue

            domain = _extract_domain(url)
            reliability = _reliability_score(url)

            if not dry_run:
                await execute(
                    """INSERT INTO game_guide_links
                           (game_id, url, domain, guide_type, language, reliability, auto_found, verified_at, updated_at)
                       VALUES (%s, %s, %s, %s, 'en', %s, TRUE, NOW(), NOW())
                       ON CONFLICT (game_id, url) DO UPDATE SET
                           guide_type  = EXCLUDED.guide_type,
                           reliability = GREATEST(game_guide_links.reliability, EXCLUDED.reliability),
                           verified_at = NOW(),
                           updated_at  = NOW()""",
                    (game_id, url, domain, guide_type, reliability),
                )
            logger.info(f"  [OK] {guide_type} → {url} (reliability={reliability:.2f})")
            saved += 1
            break  # 1 link valido per tipo è sufficiente

    return saved


def _load_checkpoint() -> set[int]:
    if _CHECKPOINT_FILE.exists():
        try:
            data = json.loads(_CHECKPOINT_FILE.read_text())
            return set(data.get("done_ids", []))
        except Exception:
            pass
    return set()


def _save_checkpoint(done_ids: set[int]) -> None:
    _CHECKPOINT_FILE.parent.mkdir(parents=True, exist_ok=True)
    _CHECKPOINT_FILE.write_text(json.dumps({"done_ids": list(done_ids)}))


async def main(args: argparse.Namespace) -> None:
    from src.config.db import close_pool, execute, fetch_all, init_pool
    from src.config.logger import get_logger
    from src.config.settings import settings

    logger = get_logger("guide_links_harvester")
    await init_pool()

    tavily_key = settings.tavily_api_key or os.environ.get("TAVILY_API_KEY", "")
    if not tavily_key:
        logger.error("TAVILY_API_KEY non configurata — uscita")
        return

    try:
        done_ids: set[int] = _load_checkpoint() if args.resume else set()
        if done_ids:
            logger.info(f"Resume: {len(done_ids)} giochi già processati da checkpoint")

        # Top N giochi per popolarità
        games = await fetch_all(
            f"""SELECT id, title, slug, platform
                FROM games
                WHERE igdb_rating_count IS NOT NULL
                ORDER BY igdb_rating_count DESC NULLS LAST
                LIMIT {args.limit}"""
        )

        todo = [g for g in games if g["id"] not in done_ids]
        logger.info(f"Giochi da processare: {len(todo)} (limit={args.limit}, già fatti={len(done_ids)})")

        if args.dry_run:
            logger.info("=== DRY-RUN: nessuna scrittura DB ===")

        total_links = 0
        total_processed = 0

        async with httpx.AsyncClient() as tavily_client:
            fetch_client = httpx.AsyncClient()
            try:
                for i in range(0, len(todo), _BATCH_SIZE):
                    batch = todo[i: i + _BATCH_SIZE]
                    for game in batch:
                        logger.info(f"[{total_processed + 1}/{len(todo)}] {game['title']}")
                        try:
                            n = await asyncio.wait_for(
                                process_game(
                                    game, tavily_key, tavily_client, fetch_client,
                                    execute, logger, args.dry_run,
                                ),
                                timeout=70.0,  # 70s max per gioco (3 query Tavily × 20s + fetch)
                            )
                        except asyncio.TimeoutError:
                            logger.warning(f"  [TIMEOUT] {game['title']} — skip, ricreazione client")
                            await fetch_client.aclose()
                            fetch_client = httpx.AsyncClient()
                            n = 0
                        except RuntimeError as exc:
                            if "quota exceeded" in str(exc):
                                logger.error(f"[ABORT] Tavily quota esaurita — {exc}. Riprova domani con --resume.")
                                return
                            logger.warning(f"  [ERROR] {game['title']} — {exc}")
                            n = 0
                        except Exception as exc:
                            logger.warning(f"  [ERROR] {game['title']} — {exc}")
                            n = 0
                        total_links += n
                        total_processed += 1
                        done_ids.add(game["id"])

                    if not args.dry_run:
                        _save_checkpoint(done_ids)

                    pct = min((i + len(batch)) / len(todo) * 100, 100)
                    logger.info(
                        f"Batch completato — processati={total_processed}, "
                        f"link_salvati={total_links}, progresso={pct:.1f}%"
                    )
            finally:
                await fetch_client.aclose()

        logger.info(
            f"=== HARVESTING COMPLETATO === processati={total_processed}, "
            f"link_totali_salvati={total_links}"
        )

    finally:
        await close_pool()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Harvester link guide per i giochi più popolari")
    parser.add_argument(
        "--limit", type=int, default=5000,
        help="Numero massimo di giochi da processare (ordinati per igdb_rating_count DESC)",
    )
    parser.add_argument(
        "--resume", action="store_true",
        help="Riprende da checkpoint (salta giochi già processati)",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Simula senza scrivere nel DB né nel checkpoint",
    )
    args = parser.parse_args()

    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(main(args))

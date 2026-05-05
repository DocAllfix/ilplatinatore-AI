"""BuildDiscoverer — scopre build/loadout meta da Reddit posts.

Per ogni gioco, cerca post Reddit popolari "best build" e estrae nomi build
con euristiche regex. Best-effort: API Reddit chiusa post-2024 -> usa JSON
pubblico read-only (`https://www.reddit.com/r/{sub}/search.json`).

Se Reddit blocca o il subreddit non esiste -> [].
"""

from __future__ import annotations

import json
import re

from src.config.logger import get_logger
from src.topics.discoverers._http import fetch_html

logger = get_logger(__name__)

# Pattern build name: case-insensitive.
# Cattura "Bleed build", "faith/arc build", "blood fiend build", ecc.
# Evita match generici tipo "best build", "good build", "op build".
_BUILD_RE = re.compile(
    r"\b([\w][\w\-/]+(?:\s+[\w\-/]+){0,3})\s+build\b",
    re.IGNORECASE,
)
_BUILD_BLOCKLIST = {
    "best", "good", "great", "top", "bad", "worst", "strong", "weak",
    "op", "cool", "fun", "easy", "hard", "first", "second", "third",
    "any", "my", "your", "his", "her", "their", "this", "that",
    "solo", "coop", "pvp", "pve", "meta", "true", "real", "basic",
    "current", "starter", "new", "old", "final", "end",
    # Interrogativi / feedback requests
    "need", "how", "what", "why", "when", "which", "help", "rate",
    "is", "am", "are", "was", "were", "cooked", "like", "please",
    "the", "a", "an", "i", "we",
}


class BuildDiscoverer:
    """Discoverer per topic_type='build'."""

    async def discover(self, game_slug: str) -> list[tuple[str, str]]:
        sub = self._guess_subreddit(game_slug)
        # Cerca build usando la search API del subreddit.
        # sort=relevance + q=build: ritorna post pertinenti a build/loadout.
        url = (
            f"https://www.reddit.com/r/{sub}/search.json"
            f"?q=build+guide&restrict_sr=1&sort=top&t=year&limit=50"
        )
        body = await fetch_html(url)
        if not body:
            return []

        try:
            payload = json.loads(body)
        except (ValueError, TypeError):
            logger.debug("Reddit JSON parse fallito", sub=sub)
            return []

        children = (payload.get("data") or {}).get("children", [])
        if not isinstance(children, list):
            return []

        names: list[tuple[str, str]] = []
        seen: set[str] = set()
        for c in children:
            try:
                title = (c.get("data") or {}).get("title") or ""
            except (AttributeError, TypeError):
                continue
            if "build" not in title.lower():
                continue
            for match in _BUILD_RE.finditer(title):
                build_name = match.group(1).strip()
                first_word = build_name.split()[0].lower() if build_name.split() else ""
                if first_word in _BUILD_BLOCKLIST:
                    continue
                normalized = build_name.lower()
                if normalized in seen:
                    continue
                seen.add(normalized)
                # Capitalizza ogni parola per consistenza nel DB
                display = " ".join(w.capitalize() for w in build_name.split())
                names.append((f"{display} Build", "reddit"))

        return names[:30]

    # Subreddit dedicati ai build per giochi noti.
    # Override ha priorità su heuristica generica.
    _SUBREDDIT_MAP: dict[str, str] = {
        "elden-ring": "EldenRingBuilds",
        "dark-souls-3": "DarkSouls3Builds",
        "sekiro": "Sekiro",
        "god-of-war-ragnarok": "GodofWar",
        "baldurs-gate-3": "BG3Builds",
        "cyberpunk-2077": "LowSodiumCyberpunk",
        "the-witcher-3": "thewitcher3",
        "dark-souls": "darksouls",
        "bloodborne": "bloodborne",
        "hollow-knight": "HollowKnight",
    }

    @classmethod
    def _guess_subreddit(cls, game_slug: str) -> str:
        """Subreddit dedicato se noto, altrimenti heuristica slug→r/gamename."""
        if game_slug in cls._SUBREDDIT_MAP:
            return cls._SUBREDDIT_MAP[game_slug]
        # Heuristica: collassa slug (elden-ring -> eldenring)
        clean = game_slug.replace("-", "").replace("_", "")
        return clean[:30]

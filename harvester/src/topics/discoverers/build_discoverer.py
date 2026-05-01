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

# Pattern build name: "Bleed Build", "Mage/Sorcerer Build", "Frenzy Caster Build", etc.
# Permissivo ma evita match generici tipo "best build" o "good build".
_BUILD_RE = re.compile(
    r"\b([A-Z][\w\-]+(?:\s+[A-Z][\w\-]+){0,3})\s+[Bb]uild\b",
)
_BUILD_BLOCKLIST = {
    "Best", "Good", "Great", "Top", "Bad", "Worst", "Strong", "Weak",
    "OP", "Cool", "Fun", "Easy", "Hard", "First", "Second", "Third",
    "Any", "My", "Your", "His", "Her", "Their", "This", "That",
    "Op", "Solo", "Coop", "Pvp", "Pve",
}


class BuildDiscoverer:
    """Discoverer per topic_type='build'."""

    async def discover(self, game_slug: str) -> list[tuple[str, str]]:
        sub = self._guess_subreddit(game_slug)
        url = (
            f"https://www.reddit.com/r/{sub}/search.json"
            f"?q=best+build&restrict_sr=1&sort=top&t=year&limit=20"
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
            for match in _BUILD_RE.finditer(title):
                build_name = match.group(1).strip()
                first_word = build_name.split()[0] if build_name.split() else ""
                if first_word in _BUILD_BLOCKLIST:
                    continue
                if build_name.lower() in seen:
                    continue
                seen.add(build_name.lower())
                names.append((f"{build_name} Build", "reddit"))

        return names[:30]

    @staticmethod
    def _guess_subreddit(game_slug: str) -> str:
        """Heuristica: collassa lo slug in nome subreddit comune.

        'elden-ring' -> 'Eldenring' (capitalize+nodash)
        Per giochi senza subreddit ufficiale -> Reddit ritorna 0 risultati.
        """
        clean = game_slug.replace("-", "").replace("_", "")
        return clean[:30]

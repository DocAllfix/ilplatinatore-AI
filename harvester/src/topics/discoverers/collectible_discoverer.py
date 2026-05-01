"""CollectibleDiscoverer — scopre collezionabili dalle guide PowerPyx già in DB.

A differenza di boss/build, i collezionabili sono spesso enumerati direttamente
nelle guide trofei PowerPyx (es. "Talismans Locations", "Memory Stone #1", etc).
Quindi questo discoverer NON fa scraping live — interroga `guides` e estrae
sezioni-collectible dal markdown delle guide harvested.

Fallback: se nessuna guide PowerPyx esiste per il gioco -> [].
"""

from __future__ import annotations

import re

from src.config.db import fetch_all
from src.config.logger import get_logger

logger = get_logger(__name__)

# Pattern sezione collectible: heading markdown con keyword note.
# Es: "## Talismans Locations", "### All Memory Stones", "## Sword Master Guide".
_COLLECTIBLE_KEYWORDS = (
    "talisman", "memory", "stone", "page", "treasure", "shrine",
    "feather", "egg", "tape", "audio", "log", "diary", "letter",
    "collectible", "location", "intel", "tear", "skull", "gem",
)
_HEADING_RE = re.compile(r"^#{2,4}\s+(.+?)\s*$", re.MULTILINE)
_TROPHY_LINE_RE = re.compile(r"^[-*]\s+([A-Z][^:\n]+):\s", re.MULTILINE)


class CollectibleDiscoverer:
    """Discoverer per topic_type='collectible'."""

    async def discover(self, game_slug: str) -> list[tuple[str, str]]:
        rows = await fetch_all(
            "SELECT g.id, g.title, g.content "
            "FROM guides g JOIN games gm ON gm.id = g.game_id "
            "WHERE gm.slug = %s "
            "  AND g.confidence_level IN ('harvested', 'verified') "
            "ORDER BY g.id DESC LIMIT 5",
            (game_slug,),
        )

        names: list[tuple[str, str]] = []
        seen: set[str] = set()

        for row in rows:
            content = row.get("content") or ""
            for m in _HEADING_RE.finditer(content):
                title = m.group(1).strip()
                if not self._looks_collectible(title):
                    continue
                if len(title) > 80 or len(title) < 4:
                    continue
                key = title.lower()
                if key in seen:
                    continue
                seen.add(key)
                names.append((title, "powerpyx"))

        return names[:50]

    @staticmethod
    def _looks_collectible(title: str) -> bool:
        title_lower = title.lower()
        return any(kw in title_lower for kw in _COLLECTIBLE_KEYWORDS)

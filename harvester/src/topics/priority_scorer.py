"""Priority scorer per game_topics (Fase 24).

Pure function — nessuna I/O, deterministico, testabile.

Regole di scoring (da DEEP_SEARCH_ADDITIONS.md §24):
  - default = 5
  - boss + len(discovered_from) ≥ 3 → -2 (più fonti = più canonico)
  - boss + keyword 'final|secret|hidden' nel nome → -1
  - build + keyword 'meta' nel nome → -1
  - clamp finale [1, 10]
"""

from __future__ import annotations

DEFAULT_PRIORITY = 5
MIN_PRIORITY = 1
MAX_PRIORITY = 10

_BOSS_HIGH_VALUE_KEYWORDS = ("final", "secret", "hidden", "optional", "endgame")
_BUILD_META_KEYWORDS = ("meta", "best", "tier-1", "s-tier", "broken")


def score_topic(
    topic_type: str,
    topic_name: str,
    discovered_from: list[str],
) -> int:
    """Calcola la priorità [1, 10] di un topic.

    Args:
        topic_type: 'boss' | 'build' | 'collectible' | 'lore' | 'puzzle'
        topic_name: nome leggibile (es. "Malenia, Blade of Miquella")
        discovered_from: lista di sorgenti che hanno trovato questo topic
            (es. ['fextralife', 'fandom', 'reddit'])

    Returns:
        Priorità [1, 10]; più bassa = più alta priorità di generazione.
    """
    score = DEFAULT_PRIORITY
    src_count = len(discovered_from)
    name_lower = topic_name.lower()

    if topic_type == "boss":
        if src_count >= 3:
            score -= 2
        if any(kw in name_lower for kw in _BOSS_HIGH_VALUE_KEYWORDS):
            score -= 1
    elif topic_type == "build":
        if any(kw in name_lower for kw in _BUILD_META_KEYWORDS):
            score -= 1
    # collectible / lore / puzzle: scoring neutro per ora — possibile estensione
    # con sub-categorie (es. "missable" collectible → +1 priority).

    return max(MIN_PRIORITY, min(MAX_PRIORITY, score))

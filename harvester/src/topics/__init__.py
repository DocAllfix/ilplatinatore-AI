"""Knowledge Graph Topic Mapper (Fase 24).

Auto-discovery di topic granulari per ogni gioco (boss, build, collectible, lore,
puzzle) attraverso scraping di fonti pubbliche (Fextralife, Fandom, Reddit,
PowerPyx, IGN). Popola la tabella `game_topics` come coda di generazione guide.

Entry point CLI: `python -m src.topics --game-id <N>` oppure `--all`.
"""

from src.topics.priority_scorer import score_topic
from src.topics.topic_mapper import TopicMapper, slugify_topic

__all__ = ["TopicMapper", "score_topic", "slugify_topic"]

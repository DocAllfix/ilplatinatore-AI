"""Discoverers per topic_mapper (Fase 24).

Ogni discoverer espone `async def discover(game_slug: str) -> list[tuple[str, str]]`
che ritorna una lista di (topic_name, source_label).

Tutti i discoverers sono best-effort: 404 / timeout / parsing fail -> [].
"""

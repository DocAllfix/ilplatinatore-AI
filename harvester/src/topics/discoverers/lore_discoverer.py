"""LoreDiscoverer — scopre personaggi/lore da Fandom via MediaWiki API JSON.

Usa l'endpoint `/api.php?action=query&list=categorymembers` che bypassa
Cloudflare (nessun JS challenge) al contrario dello scraping HTML della
pagina Category normale.

Categorie tentate in ordine: Characters, NPCs, Enemies (fallback progressivo).
"""

from __future__ import annotations

import json

from src.topics.discoverers._http import fetch_html

# Soglia massima per namespace pagina standard (0=main, 14=category).
# Filtriamo fuori meta-pagine (Categories, Help, Template...).
_SKIP_TITLES = {"Characters", "NPCs", "Enemies", "Bosses", "Creatures"}
_MAX_MEMBERS = 200  # limite totale per gioco per evitare topic spam


class LoreDiscoverer:
    """Discoverer per topic_type='lore'."""

    async def discover(self, game_slug: str) -> list[tuple[str, str]]:
        for variant in self._slug_variants(game_slug):
            for category in ("Characters", "NPCs", "Enemies"):
                names = await self._query_mediawiki(variant, category)
                if names:
                    return names[:_MAX_MEMBERS]
        return []

    @staticmethod
    def _slug_variants(slug: str) -> list[str]:
        clean = slug.lower().strip()
        no_dash = clean.replace("-", "")
        return [clean] if clean == no_dash else [clean, no_dash]

    @staticmethod
    async def _query_mediawiki(
        slug: str,
        category: str,
        limit: int = 500,
    ) -> list[tuple[str, str]]:
        """Chiama MediaWiki API con paginazione (max 2 pagine = 1000 membri)."""
        base = f"https://{slug}.fandom.com/api.php"
        params = (
            f"?action=query&list=categorymembers"
            f"&cmtitle=Category:{category}&cmlimit={limit}"
            f"&cmnamespace=0&format=json&formatversion=2"
        )
        names: list[tuple[str, str]] = []
        seen: set[str] = set()
        cm_continue: str | None = None

        for _ in range(2):  # max 2 pagine (1000 members)
            url = base + params
            if cm_continue:
                url += f"&cmcontinue={cm_continue}"
            body = await fetch_html(url, timeout=10.0)
            if not body:
                break
            try:
                data = json.loads(body)
            except (ValueError, TypeError):
                break

            members = data.get("query", {}).get("categorymembers", [])
            for m in members:
                title = (m.get("title") or "").strip()
                # Rimuove prefisso namespace se presente (es. "Category:X")
                if ":" in title:
                    title = title.split(":", 1)[1]
                if not title or len(title) < 3 or len(title) > 80:
                    continue
                if title in _SKIP_TITLES or title in seen:
                    continue
                seen.add(title)
                names.append((title, "fandom"))

            cm_continue = (
                data.get("continue", {}).get("cmcontinue")
            )
            if not cm_continue:
                break

        return names

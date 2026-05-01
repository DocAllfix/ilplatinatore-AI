"""LoreDiscoverer — scopre personaggi/lore da Fandom Category:Characters.

Pattern: https://{slug}.fandom.com/wiki/Category:Characters
Best-effort: 404 -> [].
"""

from __future__ import annotations

from bs4 import BeautifulSoup

from src.topics.discoverers._http import fetch_html


class LoreDiscoverer:
    """Discoverer per topic_type='lore'."""

    async def discover(self, game_slug: str) -> list[tuple[str, str]]:
        for variant in self._slug_variants(game_slug):
            url = f"https://{variant}.fandom.com/wiki/Category:Characters"
            html = await fetch_html(url)
            if not html:
                continue
            chars = self._parse(html)
            if chars:
                return chars
        return []

    @staticmethod
    def _slug_variants(slug: str) -> list[str]:
        clean = slug.lower().strip()
        no_dash = clean.replace("-", "")
        return [clean] if clean == no_dash else [clean, no_dash]

    @staticmethod
    def _parse(html: str) -> list[tuple[str, str]]:
        soup = BeautifulSoup(html, "html.parser")
        anchors = soup.select("a.category-page__member-link")
        names = []
        seen = set()
        for a in anchors:
            text = a.get_text(strip=True)
            if not text or len(text) > 80 or len(text) < 3:
                continue
            if text in seen:
                continue
            seen.add(text)
            names.append((text, "fandom"))
        return names

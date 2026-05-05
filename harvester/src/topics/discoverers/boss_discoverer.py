"""BossDiscoverer — scopre boss di un gioco da Fextralife + Fandom.

Best-effort: per giochi senza wiki dedicato ritorna [].

Fextralife pattern: https://{game}.wiki.fextralife.com/Bosses
Fandom pattern:    https://{game}.fandom.com/wiki/Category:Bosses

Il game_slug del DB potrebbe non corrispondere allo slug Fextralife/Fandom
(es. 'elden-ring' DB vs 'eldenring' Fextralife). Il discoverer prova lo slug
così com'è e in versione "no-dash". Se entrambi 404 -> [].
"""

from __future__ import annotations

from bs4 import BeautifulSoup

from src.topics.discoverers._http import fetch_html


class BossDiscoverer:
    """Discoverer per topic_type='boss'."""

    async def discover(self, game_slug: str) -> list[tuple[str, str]]:
        """Ritorna list of (boss_name, source) — dedup avviene a livello DB."""
        candidates: list[tuple[str, str]] = []

        for variant in self._slug_variants(game_slug):
            fext = await self._discover_fextralife(variant)
            candidates.extend(fext)
            fan = await self._discover_fandom(variant)
            candidates.extend(fan)
            if candidates:
                # Primo variant che produce risultati: stop. Evita doppioni
                # cross-slug (es. eldenring + elden-ring).
                break

        return candidates

    @staticmethod
    def _slug_variants(slug: str) -> list[str]:
        """Genera varianti dello slug per matching wiki esterni."""
        clean = slug.lower().strip()
        no_dash = clean.replace("-", "")
        # Mantieni l'ordine: prima quello con trattini (più informativo), poi compatto.
        variants = [clean]
        if no_dash and no_dash != clean:
            variants.append(no_dash)
        return variants

    async def _discover_fextralife(self, slug: str) -> list[tuple[str, str]]:
        url = f"https://{slug}.wiki.fextralife.com/Bosses"
        html = await fetch_html(url)
        if not html:
            return []
        return self._parse_fextralife(html)

    @staticmethod
    def _parse_fextralife(html: str) -> list[tuple[str, str]]:
        soup = BeautifulSoup(html, "html.parser")
        # Fextralife wiki link pattern: <a class="wiki_link" href="/Boss+Name">Boss Name</a>
        anchors = soup.select("a.wiki_link")
        names = []
        seen = set()
        for a in anchors:
            text = a.get_text(strip=True)
            href = a.get("href", "") or ""
            # Filtri di rumore: nav links ("Home", "Bosses"), redirects, link a sub-pagine.
            if not text or len(text) > 80 or len(text) < 3:
                continue
            if text.lower() in {"home", "bosses", "next", "previous", "wiki home"}:
                continue
            # I link a sotto-pagine hanno path con +; i nav link puntano a /Wiki%20Home, etc.
            if "+" not in href and "%2B" not in href:
                continue
            if text in seen:
                continue
            seen.add(text)
            names.append((text, "fextralife"))
        return names

    async def _discover_fandom(self, slug: str) -> list[tuple[str, str]]:
        """Usa MediaWiki API invece dello scraping HTML (bypassa Cloudflare)."""
        import json as _json

        base = f"https://{slug}.fandom.com/api.php"
        params = (
            "?action=query&list=categorymembers"
            "&cmtitle=Category:Bosses&cmlimit=500"
            "&cmnamespace=0&format=json&formatversion=2"
        )
        body = await fetch_html(base + params, timeout=10.0)
        if not body:
            return []
        try:
            data = _json.loads(body)
        except (ValueError, TypeError):
            return []

        members = data.get("query", {}).get("categorymembers", [])
        names = []
        seen: set[str] = set()
        for m in members:
            title = (m.get("title") or "").strip()
            if ":" in title:
                title = title.split(":", 1)[1]
            if not title or len(title) < 3 or len(title) > 80:
                continue
            if title in {"Bosses"} or title in seen:
                continue
            seen.add(title)
            names.append((title, "fandom"))
        return names

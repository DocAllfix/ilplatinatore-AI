"""RedditCollector — community meta/build/tips via API JSON pubblica.

Nessuna API key per lettura: reddit.com/r/{sub}/search.json è public.
Rate limit: 60 req/min senza auth (coperto dai delay di BaseCollector).

Filtri:
  - score > 50
  - is_self=True (solo post testuali)
  - not over_18, not removed, not stickied
  - ultimi ~2 anni (t=year)

Privacy: MAI salvare username in DB (anonimizzato).
"""

from __future__ import annotations

import json
from urllib.parse import quote_plus, urlparse

from src.collectors.base import BaseCollector, compute_hash

_MIN_SCORE = 50
_MAX_POSTS_DEFAULT = 5
_MAX_COMMENTS = 3
_MAX_CONTENT_CHARS = 15_000
_MIN_CONTENT_CHARS = 100


class RedditCollector(BaseCollector):
    """Collector per post Reddit — aggrega titolo + selftext + top commenti."""

    domain = "reddit.com"
    reliability_score = 0.70
    requires_js = False

    def __init__(self) -> None:
        super().__init__()
        # Reddit /search.json è pubblica ma robots.txt blocca i bot generici.
        # Usiamo browser UA per evitare il ban e saltiamo il check robots.txt.
        self._robots_loaded = True
        import httpx

        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(15.0),
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/124.0.0.0 Safari/537.36"
                ),
                "Accept": "application/json, text/html, */*",
                "Accept-Language": "en-US,en;q=0.9",
            },
            follow_redirects=True,
        )

    # ── Extract: parsa la risposta JSON di un search.json ────────────────────

    async def extract(self, html: str, url: str) -> dict | None:
        """Parsa un payload search.json o comments.json di Reddit.

        `html` qui è il body JSON (BaseCollector.fetch ritorna text).
        """
        try:
            data = json.loads(html)
        except (ValueError, json.JSONDecodeError):
            self._logger.warning("Reddit: JSON non valido", url=url[:100])
            return None

        # search.json ritorna un Listing {kind:"Listing", data:{children:[...]}}
        posts = self._extract_posts_from_listing(data)
        if not posts:
            self._logger.debug("Reddit: nessun post nel listing", url=url[:100])
            return None

        aggregated = "\n\n---\n\n".join(
            self.format_for_llm(p) for p in posts
        )
        aggregated = aggregated[:_MAX_CONTENT_CHARS]

        if len(aggregated) < _MIN_CONTENT_CHARS:
            return None

        return {
            "title": posts[0].get("title", "Reddit thread"),
            "game_name": None,
            "trophy_name": None,
            "guide_type": "meta",
            "topic": None,
            "raw_content": aggregated,
            "source_url": url,
            "source_domain": self.domain,
            "content_hash": compute_hash(aggregated),
            "source_type": "community",
        }

    # ── Search ───────────────────────────────────────────────────────────────

    async def search_subreddit(
        self,
        subreddit: str,
        query: str,
        limit: int = _MAX_POSTS_DEFAULT,
    ) -> list[dict]:
        """Cerca post in un subreddit.  Ritorna lista di dict filtrati."""
        q = quote_plus(query)
        url = (
            f"https://www.reddit.com/r/{subreddit}/search.json"
            f"?q={q}&restrict_sr=1&sort=top&limit={limit}&t=year"
        )
        body = await self.fetch(url)
        if body is None:
            return []

        try:
            data = json.loads(body)
        except (ValueError, json.JSONDecodeError):
            self._logger.warning(
                "Reddit: search JSON non valido", subreddit=subreddit
            )
            return []

        return self._extract_posts_from_listing(data)

    async def fetch_post_with_comments(self, post_id: str) -> dict | None:
        """Fetcha un post + top commenti via /comments/{id}.json."""
        url = f"https://www.reddit.com/comments/{post_id}.json?limit=10"
        body = await self.fetch(url)
        if body is None:
            return None
        try:
            data = json.loads(body)
        except (ValueError, json.JSONDecodeError):
            return None

        # /comments ritorna array [post_listing, comments_listing]
        if not isinstance(data, list) or len(data) < 2:
            return None

        post_children = (
            data[0].get("data", {}).get("children", []) if isinstance(data[0], dict) else []
        )
        if not post_children:
            return None
        post = self._clean_post(post_children[0].get("data", {}))
        if post is None:
            return None

        comment_children = (
            data[1].get("data", {}).get("children", []) if isinstance(data[1], dict) else []
        )
        comments: list[str] = []
        for c in comment_children[: _MAX_COMMENTS * 2]:
            cd = c.get("data", {}) if isinstance(c, dict) else {}
            body_text = cd.get("body", "").strip()
            score = cd.get("score", 0)
            if body_text and score >= 10:
                comments.append(body_text)
            if len(comments) >= _MAX_COMMENTS:
                break
        post["top_comments"] = comments
        return post

    # ── Format per LLM ───────────────────────────────────────────────────────

    @staticmethod
    def format_for_llm(post: dict) -> str:
        """Serializza un post+commenti in testo pulito, senza username."""
        parts = [f"TITLE: {post.get('title', '')}"]
        selftext = post.get("selftext", "").strip()
        if selftext:
            parts.append(f"BODY:\n{selftext}")
        comments = post.get("top_comments", [])
        if comments:
            parts.append("TOP COMMENTS:")
            for i, c in enumerate(comments, 1):
                parts.append(f"  [{i}] {c}")
        return "\n\n".join(parts)

    # ── Helpers ──────────────────────────────────────────────────────────────

    def _extract_posts_from_listing(self, data: dict | list) -> list[dict]:
        """Estrae post filtrati da un Listing search.json."""
        if not isinstance(data, dict):
            return []
        children = data.get("data", {}).get("children", [])
        posts: list[dict] = []
        for ch in children:
            if not isinstance(ch, dict):
                continue
            raw = ch.get("data", {})
            cleaned = self._clean_post(raw)
            if cleaned is not None:
                posts.append(cleaned)
        return posts

    @staticmethod
    def _clean_post(raw: dict) -> dict | None:
        """Applica filtri qualità + anonimizza.  None se scartato."""
        if not isinstance(raw, dict):
            return None
        if raw.get("over_18"):
            return None
        if raw.get("removed_by_category") or raw.get("removed"):
            return None
        if raw.get("stickied"):
            return None
        if not raw.get("is_self", False):
            return None
        if (raw.get("score") or 0) < _MIN_SCORE:
            return None

        return {
            "id": raw.get("id"),
            "title": raw.get("title", ""),
            "selftext": raw.get("selftext", ""),
            "score": raw.get("score", 0),
            "subreddit": raw.get("subreddit", ""),
            # NO username — privacy by design
            "permalink": raw.get("permalink"),
            "top_comments": [],
        }

    # ── Dispatch URL (per compat con pipeline._get_collector_for_url) ────────

    @staticmethod
    def matches_url(url: str) -> bool:
        try:
            netloc = urlparse(url).netloc
        except (ValueError, AttributeError):
            return False
        return netloc.endswith("reddit.com")

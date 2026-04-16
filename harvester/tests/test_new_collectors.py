"""Test per i nuovi collector: Fextralife, IGN, Reddit.

HTML/JSON tutti inventati, MAI copiati da siti reali.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from src.collectors.fextralife import FextralifeCollector
from src.collectors.ign import IGNCollector
from src.collectors.reddit import RedditCollector

# ── Fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture
def fextra() -> FextralifeCollector:
    return FextralifeCollector(global_semaphore=asyncio.Semaphore(5))


@pytest.fixture
def ign() -> IGNCollector:
    return IGNCollector(global_semaphore=asyncio.Semaphore(5))


@pytest.fixture
def reddit() -> RedditCollector:
    return RedditCollector(global_semaphore=asyncio.Semaphore(5))


# ── Fextralife ───────────────────────────────────────────────────────────────

_FEXTRA_VALID = """
<!DOCTYPE html>
<html>
<head><title>Made Up Boss | Fake Game Wiki</title></head>
<body>
  <nav>nav links</nav>
  <div class="ad-container">ad junk</div>
  <div id="wiki-content-block">
    <h1>Made Up Boss</h1>
    <p>This boss has 12000 HP and is weak to fictional fire damage. Dodge roll
    to the left when it raises its sword. The boss drops the Invented Blade
    after defeat, a weapon that does not exist in any real game.</p>
    <h2>Strategy</h2>
    <p>Stay close and punish attack recoveries. Use a shield build for an easy
    time, or go aggressive with a two-handed imaginary greatsword.</p>
    <h2>Notes & Tips</h2>
    <ul>
      <li>Parry window is wide on the first swing.</li>
      <li>Summon the NPC phantom near the fog gate.</li>
    </ul>
  </div>
  <footer>fake footer</footer>
</body>
</html>
"""

_FEXTRA_JS_ONLY = """
<!DOCTYPE html>
<html><head><title>Loading</title></head>
<body><div id="app"></div><script>render();</script></body></html>
"""


def test_fextralife_extract_valid(fextra: FextralifeCollector) -> None:
    result = asyncio.run(
        fextra.extract(_FEXTRA_VALID, "https://wiki.fextralife.com/fake-game/made-up-boss")
    )
    assert result is not None
    assert "Made Up Boss" in result["title"]
    assert "Invented Blade" in result["raw_content"]
    assert result["guide_type"] == "boss"
    assert result["source_domain"] == "wiki.fextralife.com"
    assert result["game_name"] == "Fake Game"
    assert result["topic"] == "Made Up Boss"
    assert len(result["content_hash"]) == 64


def test_fextralife_js_only_returns_none(fextra: FextralifeCollector) -> None:
    result = asyncio.run(
        fextra.extract(_FEXTRA_JS_ONLY, "https://wiki.fextralife.com/fake/js")
    )
    assert result is None


# ── IGN ──────────────────────────────────────────────────────────────────────

_IGN_VALID = """
<!DOCTYPE html>
<html>
<head><title>Fake Walkthrough - IGN</title></head>
<body>
  <nav>nav</nav>
  <div class="ad">ad block</div>
  <article>
    <div class="wiki-article">
      <h1>Fake Game Walkthrough - Chapter 1</h1>
      <section>
        <h2>Opening area</h2>
        <p>Head north from the starting room to reach the invented courtyard.
        Collect the imaginary key on the table and fight the made-up enemy
        blocking the door. The key opens the fictional east wing.</p>
        <h3>Collectibles</h3>
        <p>Three collectibles hidden: in the fountain, behind the curtain,
        and under the fabricated throne.</p>
      </section>
    </div>
  </article>
  <footer>IGN fake</footer>
</body>
</html>
"""

_IGN_EMPTY = """<html><body><div class="wiki-article">tiny</div></body></html>"""


def test_ign_extract_valid(ign: IGNCollector) -> None:
    result = asyncio.run(
        ign.extract(_IGN_VALID, "https://www.ign.com/wikis/fake-game/chapter-1")
    )
    assert result is not None
    assert "Fake Game" in result["title"]
    assert "imaginary key" in result["raw_content"]
    assert result["source_domain"] == "ign.com"
    assert result["game_name"] == "Fake Game"
    assert result["topic"] == "Chapter 1"


def test_ign_empty_returns_none(ign: IGNCollector) -> None:
    result = asyncio.run(
        ign.extract(_IGN_EMPTY, "https://www.ign.com/wikis/fake/empty")
    )
    assert result is None


# ── Reddit ───────────────────────────────────────────────────────────────────

_REDDIT_SEARCH_JSON = json.dumps(
    {
        "kind": "Listing",
        "data": {
            "children": [
                {
                    "kind": "t3",
                    "data": {
                        "id": "abc123",
                        "title": "Best build for Fake Game 2024",
                        "selftext": (
                            "After 200 hours, the strongest imaginary build is "
                            "Dex/Faith using the Invented Blade +10. Stat spread: "
                            "40 VIG, 60 DEX, 40 FTH. Works vs all fictional bosses."
                        ),
                        "score": 1500,
                        "subreddit": "fakegame",
                        "is_self": True,
                        "over_18": False,
                        "stickied": False,
                        "author": "should_not_leak",
                        "permalink": "/r/fakegame/comments/abc123/",
                    },
                },
                {
                    # Deve essere filtrato: over_18
                    "kind": "t3",
                    "data": {
                        "id": "nsfw1",
                        "title": "NSFW thing",
                        "selftext": "x",
                        "score": 9999,
                        "is_self": True,
                        "over_18": True,
                    },
                },
                {
                    # Deve essere filtrato: score basso
                    "kind": "t3",
                    "data": {
                        "id": "lowscore",
                        "title": "Nobody cares",
                        "selftext": "meh",
                        "score": 3,
                        "is_self": True,
                        "over_18": False,
                    },
                },
                {
                    # Deve essere filtrato: non self post (link esterno)
                    "kind": "t3",
                    "data": {
                        "id": "linkpost",
                        "title": "Link",
                        "selftext": "",
                        "score": 500,
                        "is_self": False,
                        "over_18": False,
                    },
                },
            ]
        },
    }
)


def test_reddit_extract_filters_and_anonymizes(reddit: RedditCollector) -> None:
    result = asyncio.run(
        reddit.extract(
            _REDDIT_SEARCH_JSON,
            "https://www.reddit.com/r/fakegame/search.json?q=build",
        )
    )
    assert result is not None
    content = result["raw_content"]
    # Il post valido deve esserci
    assert "Best build for Fake Game" in content
    assert "Invented Blade" in content
    # NSFW, lowscore e link post devono essere esclusi
    assert "NSFW thing" not in content
    assert "Nobody cares" not in content
    assert "Link" not in content.split("TITLE:")[1] if "TITLE:" in content else True
    # Username NON deve apparire
    assert "should_not_leak" not in content
    assert result["source_domain"] == "reddit.com"
    assert result["guide_type"] == "meta"


def test_reddit_extract_invalid_json_returns_none(reddit: RedditCollector) -> None:
    result = asyncio.run(
        reddit.extract("not json at all {", "https://reddit.com/x")
    )
    assert result is None


def test_reddit_format_for_llm_no_username(reddit: RedditCollector) -> None:
    post = {
        "title": "T",
        "selftext": "BODY",
        "top_comments": ["c1", "c2"],
    }
    out = reddit.format_for_llm(post)
    assert "T" in out
    assert "BODY" in out
    assert "c1" in out and "c2" in out
    # Nessun campo author nel formato
    assert "author" not in out.lower()

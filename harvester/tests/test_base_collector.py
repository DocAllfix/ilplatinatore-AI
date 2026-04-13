"""Test per BaseCollector — rate limiting, robots.txt, fetch, hash."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from src.collectors.base import BaseCollector, PerHostTokenBucket, compute_hash

# ── Concrete stub per istanziare la classe astratta ──────────────────────────


class _StubCollector(BaseCollector):
    domain = "stub.example.com"
    reliability_score = 0.8
    requires_js = False

    async def extract(self, html: str, url: str) -> dict | None:
        return {
            "title": "Test Guide",
            "game_name": "Test Game",
            "trophy_name": None,
            "guide_type": "walkthrough",
            "raw_content": html,
            "source_url": url,
            "source_domain": self.domain,
            "content_hash": compute_hash(html),
        }


# ── Fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture
def semaphore() -> asyncio.Semaphore:
    return asyncio.Semaphore(5)


@pytest.fixture
def collector(semaphore: asyncio.Semaphore) -> _StubCollector:
    return _StubCollector(global_semaphore=semaphore)


# ── Test compute_hash ────────────────────────────────────────────────────────


class TestComputeHash:
    def test_deterministic(self) -> None:
        """Lo stesso input produce sempre lo stesso hash."""
        text = "Guida platino Elden Ring"
        assert compute_hash(text) == compute_hash(text)

    def test_different_input_different_hash(self) -> None:
        """Input diversi producono hash diversi."""
        assert compute_hash("aaa") != compute_hash("bbb")

    def test_hex_format(self) -> None:
        """L'hash è una stringa esadecimale di 64 caratteri (SHA-256)."""
        h = compute_hash("test")
        assert len(h) == 64
        assert all(c in "0123456789abcdef" for c in h)


# ── Test _respect_delay ──────────────────────────────────────────────────────


class TestRespectDelay:
    @pytest.mark.asyncio
    async def test_waits_correct_time(self, collector: _StubCollector) -> None:
        """Se l'ultima richiesta è recente, _respect_delay aspetta la differenza."""
        with patch("src.collectors.base.settings") as mock_settings:
            mock_settings.scrape_delay_seconds = 3.0

            # Simula una richiesta fatta 1 secondo fa
            import time

            collector._last_request_time = time.monotonic() - 1.0

            with patch("asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
                await collector._respect_delay()
                mock_sleep.assert_called_once()
                # Il delay deve essere ~2 secondi (3 - 1 = 2)
                actual_wait = mock_sleep.call_args[0][0]
                assert 1.5 < actual_wait < 2.5

    @pytest.mark.asyncio
    async def test_no_wait_first_request(self, collector: _StubCollector) -> None:
        """La prima richiesta (last_request_time=0) non deve attendere."""
        with patch("asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            await collector._respect_delay()
            mock_sleep.assert_not_called()


# ── Test fetch ───────────────────────────────────────────────────────────────


class TestFetch:
    @pytest.mark.asyncio
    async def test_returns_none_on_403(self, collector: _StubCollector) -> None:
        """fetch() ritorna None se il server risponde 403."""
        mock_resp = httpx.Response(
            status_code=403,
            request=httpx.Request("GET", "https://stub.example.com/page"),
        )

        with (
            patch.object(collector._client, "get", new_callable=AsyncMock, return_value=mock_resp),
            patch.object(collector, "_is_allowed", new_callable=AsyncMock, return_value=True),
            patch.object(collector, "_respect_delay", new_callable=AsyncMock),
            patch("src.collectors.base.PER_HOST_BUCKET", new_callable=MagicMock) as mock_bucket,
        ):
            mock_bucket.acquire = AsyncMock()
            result = await collector.fetch("https://stub.example.com/page")
            assert result is None

    @pytest.mark.asyncio
    async def test_returns_none_on_429(self, collector: _StubCollector) -> None:
        """fetch() ritorna None se il server risponde 429 (rate limited)."""
        mock_resp = httpx.Response(
            status_code=429,
            request=httpx.Request("GET", "https://stub.example.com/page"),
        )

        with (
            patch.object(collector._client, "get", new_callable=AsyncMock, return_value=mock_resp),
            patch.object(collector, "_is_allowed", new_callable=AsyncMock, return_value=True),
            patch.object(collector, "_respect_delay", new_callable=AsyncMock),
            patch("src.collectors.base.PER_HOST_BUCKET", new_callable=MagicMock) as mock_bucket,
        ):
            mock_bucket.acquire = AsyncMock()
            result = await collector.fetch("https://stub.example.com/page")
            assert result is None

    @pytest.mark.asyncio
    async def test_returns_html_on_200(self, collector: _StubCollector) -> None:
        """fetch() ritorna il body HTML su status 200."""
        mock_resp = httpx.Response(
            status_code=200,
            text="<html><body>Guide</body></html>",
            request=httpx.Request("GET", "https://stub.example.com/page"),
        )

        with (
            patch.object(collector._client, "get", new_callable=AsyncMock, return_value=mock_resp),
            patch.object(collector, "_is_allowed", new_callable=AsyncMock, return_value=True),
            patch.object(collector, "_respect_delay", new_callable=AsyncMock),
            patch("src.collectors.base.PER_HOST_BUCKET", new_callable=MagicMock) as mock_bucket,
        ):
            mock_bucket.acquire = AsyncMock()
            result = await collector.fetch("https://stub.example.com/page")
            assert result == "<html><body>Guide</body></html>"

    @pytest.mark.asyncio
    async def test_returns_none_on_timeout(self, collector: _StubCollector) -> None:
        """fetch() ritorna None su timeout."""
        with (
            patch.object(
                collector._client,
                "get",
                new_callable=AsyncMock,
                side_effect=httpx.TimeoutException("timeout"),
            ),
            patch.object(collector, "_is_allowed", new_callable=AsyncMock, return_value=True),
            patch.object(collector, "_respect_delay", new_callable=AsyncMock),
            patch("src.collectors.base.PER_HOST_BUCKET", new_callable=MagicMock) as mock_bucket,
        ):
            mock_bucket.acquire = AsyncMock()
            result = await collector.fetch("https://stub.example.com/page")
            assert result is None


# ── Test robots.txt ──────────────────────────────────────────────────────────


class TestRobotsTxt:
    @pytest.mark.asyncio
    async def test_returns_none_when_disallowed(self, collector: _StubCollector) -> None:
        """fetch() ritorna None se robots.txt vieta l'URL."""
        from protego import Protego

        robots_txt = "User-agent: *\nDisallow: /secret/"
        collector._robots = Protego.parse(robots_txt)

        with patch("src.collectors.base.settings") as mock_settings:
            mock_settings.user_agent = "IlPlatinatoreBot/1.0"

            result = await collector.fetch("https://stub.example.com/secret/page")
            assert result is None

    @pytest.mark.asyncio
    async def test_allowed_when_no_robots(self, collector: _StubCollector) -> None:
        """_is_allowed ritorna True se robots.txt non è stato caricato (fail-open)."""
        collector._robots = None
        assert await collector._is_allowed("https://stub.example.com/anything") is True

    @pytest.mark.asyncio
    async def test_lazy_load_robots_on_first_fetch(self, collector: _StubCollector) -> None:
        """La prima fetch() triggera _load_robots(); le successive no."""
        mock_resp = httpx.Response(
            status_code=200,
            text="<html></html>",
            request=httpx.Request("GET", "https://stub.example.com/p"),
        )
        with (
            patch.object(collector, "_load_robots", new_callable=AsyncMock) as mock_load,
            patch.object(collector._client, "get", new_callable=AsyncMock, return_value=mock_resp),
            patch.object(collector, "_is_allowed", new_callable=AsyncMock, return_value=True),
            patch.object(collector, "_respect_delay", new_callable=AsyncMock),
            patch("src.collectors.base.PER_HOST_BUCKET", new_callable=MagicMock) as mock_bucket,
        ):
            mock_bucket.acquire = AsyncMock()

            # Prima fetch: _load_robots deve essere chiamato
            # (simula il side effect settando _robots_loaded=True)
            async def set_loaded() -> None:
                collector._robots_loaded = True

            mock_load.side_effect = set_loaded

            await collector.fetch("https://stub.example.com/a")
            assert mock_load.call_count == 1

            # Seconda fetch: _load_robots NON deve essere richiamato
            await collector.fetch("https://stub.example.com/b")
            assert mock_load.call_count == 1


# ── Test User-Agent ──────────────────────────────────────────────────────────


class TestUserAgent:
    def test_user_agent_from_settings(self, collector: _StubCollector) -> None:
        """Il client httpx usa lo User-Agent configurato in settings."""
        ua = collector._client.headers.get("user-agent")
        assert ua == "IlPlatinatoreBot/1.0 (+https://ilplatinatore.it/bot)"


# ── Test PerHostTokenBucket ──────────────────────────────────────────────────


class TestPerHostTokenBucket:
    @pytest.mark.asyncio
    async def test_first_acquire_no_wait(self) -> None:
        """La prima acquire per un host non deve aspettare."""
        bucket = PerHostTokenBucket(rate=0.33, burst=1)
        with patch("asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            await bucket.acquire("example.com")
            mock_sleep.assert_not_called()

    @pytest.mark.asyncio
    async def test_second_acquire_waits(self) -> None:
        """La seconda acquire immediata deve attendere ~3 secondi (rate=0.33)."""
        bucket = PerHostTokenBucket(rate=0.33, burst=1)

        # Prima acquire — consuma il token
        await bucket.acquire("example.com")

        # Seconda acquire — deve aspettare
        with patch("asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            await bucket.acquire("example.com")
            mock_sleep.assert_called_once()
            actual_wait = mock_sleep.call_args[0][0]
            # rate=0.33 → ~3 secondi di attesa
            assert 2.0 < actual_wait < 4.0

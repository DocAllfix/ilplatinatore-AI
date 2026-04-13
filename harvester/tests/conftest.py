import os
from pathlib import Path

import pytest

# Carica .env.test se esiste (valori reali per integration test locali).
if Path(".env.test").exists():
    from dotenv import load_dotenv

    load_dotenv(".env.test", override=False)

# Fallback hardcoded: garantisce che Settings() non crashi durante la raccolta dei test.
# settings = Settings() è a livello modulo — senza questi setdefault fallirebbe con
# ValidationError "Field required" prima ancora di entrare in qualsiasi test.
os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost:5432/test_db")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/1")
os.environ.setdefault("GEMINI_API_KEY", "test-gemini-key-not-real")
os.environ.setdefault("GOOGLE_EMBEDDING_API_KEY", "test-embedding-key-not-real")


@pytest.fixture
def mock_settings():
    """
    Settings con valori di test, senza connessioni reali a DB o Redis.
    Utile per unit test che devono ispezionare la config senza infrastruttura.
    """
    from src.config.settings import Settings

    return Settings(
        database_url="postgresql://test:test@localhost:5432/test_db",
        redis_url="redis://localhost:6379/1",
        gemini_api_key="test-gemini-key-not-real",
        google_embedding_api_key="test-embedding-key-not-real",
    )

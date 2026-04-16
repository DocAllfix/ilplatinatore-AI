import sys

from pydantic import AliasChoices, Field, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        # populate_by_name=True consente di passare kwargs per field name
        # nei test (mock_settings fixture) invece degli alias env
        populate_by_name=True,
    )

    # ── Obbligatori — processo crasha se mancanti ────────────────────────────────
    database_url: str
    redis_url: str
    gemini_api_key: str
    google_embedding_api_key: str

    # ── Provider transformer (deepseek | gemini) ────────────────────────────────
    deepseek_api_key: str = ""
    transformer_provider: str = Field(
        default="deepseek",
        validation_alias=AliasChoices("TRANSFORMER_PROVIDER", "HARVESTER_TRANSFORMER_PROVIDER"),
    )

    # ── PSN (opzionale — il sistema funziona anche senza) ───────────────────────
    psn_npsso: str = ""  # Cookie NPSSO da PlayStation.com — se vuoto: fetcher disabilitato

    # ── Opzionali senza prefisso HARVESTER_ ─────────────────────────────────────
    igdb_client_id: str = ""
    igdb_client_secret: str = ""
    steam_api_key: str = ""  # Steam Web API key — se vuoto: Steam fetcher disabilitato
    youtube_api_key: str = ""  # YouTube Data API v3 key — se vuoto: YouTube fetcher disabilitato

    # ── Opzionali con prefisso HARVESTER_ ───────────────────────────────────────
    # AliasChoices: prova HARVESTER_LOG_LEVEL prima, poi LOG_LEVEL come fallback
    log_level: str = Field(
        default="INFO",
        validation_alias=AliasChoices("HARVESTER_LOG_LEVEL", "LOG_LEVEL"),
    )
    daily_gemini_limit: int = Field(
        default=5000,
        validation_alias=AliasChoices("HARVESTER_DAILY_GEMINI_LIMIT", "DAILY_GEMINI_LIMIT"),
    )
    daily_embedding_limit: int = Field(
        default=50000,
        validation_alias=AliasChoices(
            "HARVESTER_DAILY_EMBEDDING_LIMIT", "DAILY_EMBEDDING_LIMIT"
        ),
    )
    daily_youtube_quota_limit: int = Field(
        default=8000,
        validation_alias=AliasChoices(
            "HARVESTER_DAILY_YOUTUBE_QUOTA_LIMIT", "DAILY_YOUTUBE_QUOTA_LIMIT"
        ),
    )
    scrape_delay_seconds: float = Field(
        default=3.0,
        validation_alias=AliasChoices(
            "HARVESTER_SCRAPE_DELAY_SECONDS", "SCRAPE_DELAY_SECONDS"
        ),
    )
    max_concurrent_collectors: int = Field(
        default=3,
        validation_alias=AliasChoices(
            "HARVESTER_MAX_CONCURRENT_COLLECTORS", "MAX_CONCURRENT_COLLECTORS"
        ),
    )
    user_agent: str = Field(
        default="IlPlatinatoreBot/1.0 (+https://ilplatinatore.it/bot)",
        validation_alias=AliasChoices("HARVESTER_USER_AGENT", "USER_AGENT"),
    )


try:
    settings = Settings()
except ValidationError as _exc:
    # structlog non è ancora configurato: scriviamo su stderr direttamente.
    # Questo è un errore fatale di avvio — il processo non può continuare.
    _missing = [str(e["loc"][0]).upper() for e in _exc.errors() if e["type"] == "missing"]
    for _field in _missing:
        sys.stderr.write(f"[FATAL] Variabile d'ambiente obbligatoria mancante: {_field}\n")
    sys.exit(1)

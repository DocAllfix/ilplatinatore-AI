from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Database
    database_url: str

    # Redis
    redis_url: str = "redis://localhost:6379/1"

    # API Keys
    gemini_api_key: str = ""
    google_embedding_api_key: str = ""

    # IGDB
    igdb_client_id: str = ""
    igdb_client_secret: str = ""

    # Harvester config
    harvester_log_level: str = "INFO"
    harvester_daily_gemini_limit: int = 5000
    harvester_daily_embedding_limit: int = 50000
    harvester_scrape_delay_seconds: float = 3.0
    harvester_max_concurrent_collectors: int = 3
    harvester_user_agent: str = "IlPlatinatoreBot/1.0 (+https://ilplatinatore.it/bot)"


settings = Settings()

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    backend_cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    ai_api_base_url: str = "http://127.0.0.1:8001"
    ai_api_service_token: str = "dev-change-me"
    # Default: SQLite under apps/backend (no Docker). Override with DATABASE_URL for Postgres.
    database_url: str = "sqlite+aiosqlite:///./data/inkecho.db"
    # Screen recordings / short MP4s often exceed 80 MiB; cap is configurable (bytes).
    max_upload_bytes: int = Field(default=512 * 1024 * 1024, validation_alias="MAX_UPLOAD_BYTES")

    @property
    def database_url_async(self) -> str:
        u = self.database_url.strip()
        if u.startswith("postgresql+asyncpg://"):
            return u
        if u.startswith("postgresql://"):
            return u.replace("postgresql://", "postgresql+asyncpg://", 1)
        if u.startswith("sqlite://") and not u.startswith("sqlite+aiosqlite://"):
            return u.replace("sqlite://", "sqlite+aiosqlite://", 1)
        return u


settings = Settings()

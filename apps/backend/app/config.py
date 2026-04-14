from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    backend_cors_origins: str = "http://localhost:5173"
    ai_api_base_url: str = "http://127.0.0.1:8001"
    ai_api_service_token: str = "dev-change-me"
    database_url: str = "postgresql://inkecho:inkecho@localhost:5432/inkecho"


settings = Settings()

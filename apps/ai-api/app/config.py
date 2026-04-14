from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def _discover_env_files() -> tuple[str, ...]:
    """Load .env from apps/ai-api and/or repo root so STT keys work no matter what cwd uvicorn uses."""
    app_dir = Path(__file__).resolve().parent
    ai_api_root = app_dir.parent
    repo_root = ai_api_root.parent.parent
    candidates = [ai_api_root / ".env", repo_root / ".env"]
    seen: set[Path] = set()
    out: list[str] = []
    for p in candidates:
        try:
            r = p.resolve()
        except OSError:
            continue
        if r.is_file() and r not in seen:
            seen.add(r)
            out.append(str(r))
    return tuple(out) if out else (".env",)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_discover_env_files(),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    service_token: str = Field(default="dev-change-me", validation_alias="AI_API_SERVICE_TOKEN")
    openai_api_key: str | None = Field(default=None, validation_alias="OPENAI_API_KEY")
    openai_base_url: str = Field(default="https://api.openai.com/v1", validation_alias="OPENAI_BASE_URL")

    # Speech-to-text provider: auto | openai | openrouter
    # auto: OpenAI if OPENAI_API_KEY is set, else OpenRouter if OPENROUTER_API_KEY, else mock.
    stt_provider: Literal["auto", "openai", "openrouter"] = Field(default="auto", validation_alias="STT_PROVIDER")
    openrouter_api_key: str | None = Field(default=None, validation_alias="OPENROUTER_API_KEY")
    openrouter_base_url: str = Field(default="https://openrouter.ai/api/v1", validation_alias="OPENROUTER_BASE_URL")
    openrouter_transcribe_model: str = Field(
        # Mistral-hosted audio model — often avoids Google/OpenAI regional or moderation403s via OpenRouter.
        default="mistralai/voxtral-small-24b-2507",
        validation_alias="OPENROUTER_TRANSCRIBE_MODEL",
    )
    openrouter_http_referer: str | None = Field(default=None, validation_alias="OPENROUTER_HTTP_REFERER")
    openrouter_x_title: str = Field(default="InkEcho", validation_alias="OPENROUTER_X_TITLE")

    @field_validator("openai_api_key", "openrouter_api_key", mode="before")
    @classmethod
    def _empty_api_key_to_none(cls, v: object) -> object:
        if v == "":
            return None
        return v

    def resolved_stt_backend(self) -> Literal["openai", "openrouter", "mock"]:
        if self.stt_provider == "openai":
            return "openai" if self.openai_api_key else "mock"
        if self.stt_provider == "openrouter":
            return "openrouter" if self.openrouter_api_key else "mock"
        if self.openai_api_key:
            return "openai"
        if self.openrouter_api_key:
            return "openrouter"
        return "mock"


settings = Settings()

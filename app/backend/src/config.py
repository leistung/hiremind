from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    database_url: str = Field("mysql+pymysql://hiremind:hiremind@mysql:3306/hiremind", alias="DATABASE_URL")
    redis_url: str = Field("redis://redis:6379/0", alias="REDIS_URL")
    jwt_secret: str = Field("replace-this-in-production", alias="JWT_SECRET")
    legacy_source: str = Field("/legacy", alias="LEGACY_SOURCE")
    runtime_root: str = Field("/runtime/users", alias="RUNTIME_ROOT")
    secure_cookie: bool = Field(False, alias="SECURE_COOKIE")
    cors_origins: str = Field("http://localhost:3000,http://127.0.0.1:5174", alias="CORS_ORIGINS")

    @property
    def origins(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",")]


settings = Settings()
if settings.jwt_secret in ("replace-this-in-production", "change-this-secret-before-production"):
    import secrets
    from pathlib import Path
    secret_file = Path("/service-state/session.key")
    secret_file.parent.mkdir(parents=True, exist_ok=True)
    if not secret_file.exists():
        secret_file.write_text(secrets.token_urlsafe(48))
        secret_file.chmod(0o600)
    settings.jwt_secret = secret_file.read_text().strip()

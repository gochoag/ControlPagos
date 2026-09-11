import os
from pathlib import Path

from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parent.parent
INSTANCE_DIR = PROJECT_ROOT / "instance"
load_dotenv(PROJECT_ROOT / ".env")


def database_url():
    value = os.getenv("DATABASE_URL", "sqlite:///controlpagos.sqlite3")
    # Compatibilidad con la ruta usada antes de definir instance_path.
    if value.startswith("sqlite:///instance/"):
        return "sqlite:///" + value.removeprefix("sqlite:///instance/")
    return value


class Config:
    SECRET_KEY = os.getenv("SECRET_KEY") or "dev-only-change-me"
    SQLALCHEMY_DATABASE_URI = database_url()
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    SESSION_COOKIE_SECURE = os.getenv("SESSION_COOKIE_SECURE", "false").lower() == "true"
    MAX_CONTENT_LENGTH = 2 * 1024 * 1024

    @classmethod
    def validate(cls):
        if cls.SESSION_COOKIE_SECURE and cls.SECRET_KEY == "dev-only-change-me":
            raise RuntimeError("SECRET_KEY es obligatoria cuando SESSION_COOKIE_SECURE=true")

import os
from datetime import timedelta
from pathlib import Path

from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parent.parent
INSTANCE_DIR = PROJECT_ROOT / "instance"
load_dotenv(PROJECT_ROOT / ".env")


def database_url():
    return normalize_database_url(os.getenv("DATABASE_URL", "sqlite:///controlpagos.sqlite3"))


def normalize_database_url(value):
    # Compatibilidad con la ruta usada antes de definir instance_path.
    if value.startswith("sqlite:///instance/"):
        return "sqlite:///" + value.removeprefix("sqlite:///instance/")
    # vps-new-db entrega la URL sin driver; SQLAlchemy necesita psycopg 3 explícito.
    if value.startswith("postgresql://"):
        return "postgresql+psycopg://" + value.removeprefix("postgresql://")
    return value


class Config:
    SECRET_KEY = os.getenv("SECRET_KEY")
    SQLALCHEMY_DATABASE_URI = database_url()
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    SESSION_COOKIE_SECURE = os.getenv("SESSION_COOKIE_SECURE", "false").lower() == "true"
    PERMANENT_SESSION_LIFETIME = timedelta(days=30)
    SESSION_REFRESH_EACH_REQUEST = True
    MAX_CONTENT_LENGTH = 2 * 1024 * 1024
    RATELIMIT_STORAGE_URI = "memory://"
    # Súbelo en el mismo PR que exige instalar un APK nuevo (cambio nativo o de dominio).
    MIN_APP_BUILD = 2
    APP_DOWNLOAD_URL = "https://github.com/gochoag/ControlPagos/releases/latest/download/controlpagos.apk"

import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path

from flask import current_app

from ..extensions import db


class BackupUnavailable(RuntimeError):
    pass


def create_sqlite_snapshot():
    """Create a consistent SQLite snapshot without interrupting the live app."""
    url = db.engine.url
    if url.get_backend_name() != "sqlite" or not url.database or url.database == ":memory:":
        raise BackupUnavailable("La copia completa solo está disponible cuando se usa SQLite")

    source_path = Path(url.database).resolve()
    if not source_path.is_file():
        raise BackupUnavailable("No se encontró el archivo de la base de datos")

    temp = tempfile.NamedTemporaryFile(
        prefix="controlpagos_", suffix=".sqlite3", dir=current_app.instance_path, delete=False
    )
    temp.close()
    snapshot_path = Path(temp.name)
    try:
        with closing(sqlite3.connect(source_path)) as source, closing(sqlite3.connect(snapshot_path)) as destination:
            source.backup(destination)
        return snapshot_path
    except Exception:
        snapshot_path.unlink(missing_ok=True)
        raise

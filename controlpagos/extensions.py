from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_migrate import Migrate
from flask_sqlalchemy import SQLAlchemy


db = SQLAlchemy()
migrate = Migrate()
# shortcut: almacenamiento en memoria por worker (límite efectivo ×4 con 2 workers y azul/verde); pasar a Redis si hay más usuarios.
limiter = Limiter(key_func=get_remote_address)

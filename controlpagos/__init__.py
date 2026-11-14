from flask import Flask, jsonify, render_template, request
from werkzeug.middleware.proxy_fix import ProxyFix

from .blueprints.api import api_bp
from .blueprints.auth import auth_bp
from .blueprints.web import web_bp
from .cli import register_commands
from .config import Config, INSTANCE_DIR
from .extensions import db, limiter, migrate
from .security import csrf_token


def create_app(test_config=None):
    app = Flask(
        __name__,
        instance_path=str(INSTANCE_DIR),
        template_folder="templates",
        static_folder="static",
        static_url_path="/static",
    )
    app.config.from_object(Config)
    if test_config:
        app.config.update(test_config)
    if not app.config.get("SECRET_KEY"):
        raise RuntimeError("SECRET_KEY es obligatoria (defínela en .env)")
    if app.config["SQLALCHEMY_DATABASE_URI"].startswith("postgresql"):
        # 2 workers × (3 + 1) × 2 versiones en el deploy azul/verde = 16 < 20 conexiones del rol.
        app.config.setdefault("SQLALCHEMY_ENGINE_OPTIONS", {"pool_size": 3, "max_overflow": 1, "pool_pre_ping": True})

    # nginx (detrás de Cloudflare) envía la IP real y el esquema en X-Forwarded-*.
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1)

    db.init_app(app)
    migrate.init_app(app, db)
    limiter.init_app(app)
    app.jinja_env.globals["csrf_token"] = csrf_token
    app.register_blueprint(auth_bp)
    app.register_blueprint(web_bp)
    app.register_blueprint(api_bp)
    register_commands(app)

    # Cabeceras de seguridad (nosniff, X-Frame-Options, Referrer-Policy, Permissions-Policy) y HSTS:
    # las ponen nginx del VPS (templates/vps-cabeceras.conf) y Cloudflare. Duplicarlas aquí daba valores en conflicto.

    @app.errorhandler(404)
    def not_found(_error):
        if request.path.startswith("/api/"):
            return jsonify(error="No encontrado"), 404
        return "No encontrado", 404

    @app.errorhandler(429)
    def too_many_requests(_error):
        message = "Demasiados intentos. Espera un minuto e inténtalo de nuevo."
        if request.path.startswith("/api/"):
            return jsonify(error=message), 429
        return render_template("login.html", error=message), 429

    return app


__all__ = ["create_app", "db"]

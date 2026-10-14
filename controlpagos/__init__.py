from flask import Flask, jsonify, request

from .blueprints.api import api_bp
from .blueprints.auth import auth_bp
from .blueprints.web import web_bp
from .cli import register_commands
from .config import Config, INSTANCE_DIR
from .extensions import db, migrate
from .security import csrf_token


def create_app(test_config=None):
    Config.validate()
    INSTANCE_DIR.mkdir(exist_ok=True)
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

    db.init_app(app)
    migrate.init_app(app, db)
    app.jinja_env.globals["csrf_token"] = csrf_token
    app.register_blueprint(auth_bp)
    app.register_blueprint(web_bp)
    app.register_blueprint(api_bp)
    register_commands(app)

    @app.after_request
    def security_headers(response):
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        return response

    @app.errorhandler(404)
    def not_found(_error):
        if request.path.startswith("/api/"):
            return jsonify(error="No encontrado"), 404
        return "No encontrado", 404

    return app


__all__ = ["create_app", "db"]

from flask import Blueprint, current_app, render_template, session

from ..security import login_required


web_bp = Blueprint("web", __name__)


@web_bp.get("/")
@login_required
def index():
    fresh_authentication = bool(
        session.pop("fresh_password_login", False)
        or session.pop("fresh_device_login", False)
    )
    return render_template(
        "index.html",
        auth_method=session.get("auth_method", "unknown"),
        fresh_authentication=fresh_authentication,
    )


@web_bp.get("/manifest.webmanifest")
def manifest():
    return current_app.send_static_file("manifest.webmanifest")


@web_bp.get("/service-worker.js")
def service_worker():
    response = current_app.send_static_file("service-worker.js")
    response.headers["Service-Worker-Allowed"] = "/"
    response.headers["Cache-Control"] = "no-cache"
    return response


@web_bp.get("/offline.html")
def offline():
    return current_app.send_static_file("offline.html")

import secrets
from functools import wraps

from flask import abort, jsonify, redirect, request, session, url_for


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("user_id"):
            if request.path.startswith("/api/"):
                return jsonify(error="Autenticación requerida"), 401
            return redirect(url_for("auth.login_page", next=request.path))
        return view(*args, **kwargs)

    return wrapped


def csrf_token():
    token = session.get("csrf_token")
    if not token:
        token = secrets.token_urlsafe(32)
        session["csrf_token"] = token
    return token


def check_csrf():
    expected = session.get("csrf_token")
    supplied = request.headers.get("X-CSRF-Token") or request.form.get("csrf_token")
    if expected and supplied and secrets.compare_digest(expected, supplied):
        return None
    if request.path.startswith("/api/"):
        return jsonify(error="Token CSRF inválido"), 400
    abort(400, "Token CSRF inválido")

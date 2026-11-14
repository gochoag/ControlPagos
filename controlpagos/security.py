import secrets
from functools import wraps

from argon2 import PasswordHasher, profiles
from argon2.exceptions import InvalidHashError, VerificationError
from flask import abort, jsonify, redirect, request, session, url_for


# Argon2id con el perfil de RFC 9106 para poca memoria: t=3, m=64 MiB, p=4.
_hasher = PasswordHasher.from_parameters(profiles.RFC_9106_LOW_MEMORY)
# Hash de relleno: si el usuario no existe se verifica igual, para no revelar por tiempo qué usuarios existen.
_DUMMY_HASH = _hasher.hash(secrets.token_urlsafe(16))


def hash_password(password):
    return _hasher.hash(password)


def verify_password(user, password):
    """Comprueba la contraseña (user puede ser None). Si los parámetros cambiaron, rehace el hash."""
    try:
        _hasher.verify(user.password_hash if user else _DUMMY_HASH, password)
    except (VerificationError, InvalidHashError):
        return False
    if user is None:
        return False
    if _hasher.check_needs_rehash(user.password_hash):
        user.password_hash = hash_password(password)
    return True


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

import hashlib
import secrets

from flask import Blueprint, jsonify, redirect, render_template, request, session, url_for
from sqlalchemy import func

from ..extensions import db, limiter
from ..models import DeviceCredential, User
from ..security import check_csrf, csrf_token, login_required, verify_password
from ..services.data_service import utc_now


auth_bp = Blueprint("auth", __name__)

# Solo cuentan los intentos fallidos: un login correcto no consume el cupo.
LOGIN_LIMIT = "5 per minute;30 per hour"


def _failed(response):
    return response.status_code == 401


@auth_bp.get("/login")
def login_page():
    if session.get("user_id"):
        return redirect(url_for("web.index"))
    return render_template("login.html", error=None)


@auth_bp.post("/login")
@limiter.limit(LOGIN_LIMIT, deduct_when=_failed)
def login():
    csrf_error = check_csrf()
    if csrf_error:
        return csrf_error
    username = request.form.get("username", "").strip()
    password = request.form.get("password", "")
    user = User.query.filter(func.lower(User.username) == username.lower()).first()
    if not verify_password(user, password):
        return render_template("login.html", error="Usuario o contraseña incorrectos"), 401
    db.session.commit()  # guarda el rehash si verify_password actualizó el hash
    session.clear()
    session.permanent = True
    session["user_id"] = user.id
    session["auth_method"] = "password"
    session["fresh_password_login"] = True
    csrf_token()
    next_url = request.args.get("next", "")
    return redirect(next_url if next_url.startswith("/") and not next_url.startswith("//") else url_for("web.index"))


@auth_bp.post("/logout")
@login_required
def logout():
    csrf_error = check_csrf()
    if csrf_error:
        return csrf_error
    session.clear()
    return redirect(url_for("auth.login_page"))


def _hash_device_token(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


@auth_bp.post("/api/auth/device/register")
@login_required
def register_device():
    csrf_error = check_csrf()
    if csrf_error:
        return csrf_error
    if session.get("auth_method") != "password":
        return jsonify(error="Confirma primero tu contraseña"), 403
    payload = request.get_json(silent=True) or {}
    label = str(payload.get("label", "Android")).strip()[:120] or "Android"
    token = secrets.token_urlsafe(48)
    credential = DeviceCredential(
        user_id=session["user_id"],
        token_hash=_hash_device_token(token),
        label=label,
        created_at=utc_now(),
    )
    db.session.add(credential)
    db.session.commit()
    return jsonify(token=token, label=credential.label), 201


@auth_bp.post("/api/auth/device/login")
@limiter.limit(LOGIN_LIMIT, deduct_when=_failed)
def device_login():
    csrf_error = check_csrf()
    if csrf_error:
        return csrf_error
    payload = request.get_json(silent=True) or {}
    token = str(payload.get("token", ""))
    if not token:
        return jsonify(error="Credencial del dispositivo ausente"), 400
    credential = DeviceCredential.query.filter_by(token_hash=_hash_device_token(token)).first()
    if not credential:
        return jsonify(error="El acceso rápido ya no es válido"), 401
    credential.last_used_at = utc_now()
    db.session.commit()
    session.clear()
    session.permanent = True
    session["user_id"] = credential.user_id
    session["auth_method"] = "device"
    session["fresh_device_login"] = True
    return jsonify(success=True, redirect=url_for("web.index"), csrfToken=csrf_token())


@auth_bp.delete("/api/auth/device")
@login_required
def revoke_device():
    csrf_error = check_csrf()
    if csrf_error:
        return csrf_error
    payload = request.get_json(silent=True) or {}
    token = str(payload.get("token", ""))
    if token:
        DeviceCredential.query.filter_by(
            user_id=session["user_id"], token_hash=_hash_device_token(token)
        ).delete()
        db.session.commit()
    return "", 204

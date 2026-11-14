import io
import json
import os
import re
import secrets

import pytest

from controlpagos import create_app, db
from controlpagos.config import normalize_database_url
from controlpagos.models import DeviceCredential, Receivable, User
from controlpagos.security import hash_password, verify_password
from controlpagos.services.data_service import database_payload, import_payload, utc_now


# En CI se ejecuta contra PostgreSQL (TEST_DATABASE_URL); en local, SQLite en memoria si no se define.
TEST_DATABASE_URL = normalize_database_url(os.getenv("TEST_DATABASE_URL", "sqlite://"))
TEST_USER = "alex"
# Contraseñas generadas en cada ejecución: sin credenciales literales en el repo (evita falsos positivos de escáneres).
TEST_PASSWORD = secrets.token_urlsafe(12)
WRONG_PASSWORD = TEST_PASSWORD + "-mal"


def form(token, password=None, username=TEST_USER):
    return {"username": username, "password": password or TEST_PASSWORD, "csrf_token": token}


@pytest.fixture()
def make_app():
    created = []

    def factory(**overrides):
        app = create_app({
            "TESTING": True,
            "SECRET_KEY": "test-secret",
            "SQLALCHEMY_DATABASE_URI": TEST_DATABASE_URL,
            "SESSION_COOKIE_SECURE": False,
            **overrides,
        })
        with app.app_context():
            db.drop_all()
            db.create_all()
            db.session.add(User(username=TEST_USER, password_hash=hash_password(TEST_PASSWORD)))
            db.session.commit()
        created.append(app)
        return app

    yield factory
    for app in created:
        with app.app_context():
            db.session.remove()
            db.drop_all()
            db.engine.dispose()


@pytest.fixture()
def application(make_app):
    return make_app()


@pytest.fixture()
def client(application):
    return application.test_client()


@pytest.fixture()
def cli(application):
    return application.test_cli_runner()


def csrf_from_html(response):
    match = re.search(rb'name="csrf_token" value="([^"]+)"', response.data)
    assert match
    return match.group(1).decode()


def login(client):
    token = csrf_from_html(client.get("/login"))
    response = client.post(
        "/login",
        data=form(token),
    )
    assert response.status_code == 302
    with client.session_transaction() as session:
        return session["csrf_token"]


def sample_backup():
    return {
        "receivables": [
            {"id": 101, "name": "Ana", "amount": "12.34", "desc": "Diseño", "date": "2026-09-01T12:00:00Z"},
        ],
        "receivableContacts": [{"id": 201, "name": "Ana"}],
        "payables": [{"id": 301, "name": "Internet", "amount": 20, "desc": "Plan", "date": "2026-09-02T12:00:00Z"}],
        "classes": [{"id": 401, "student": "Luis", "hours": "1.5", "desc": "Álgebra", "date": "2026-09-03T12:00:00Z"}],
        "memberships": [{"id": 501, "name": "GPT", "cost": "20.00", "desc": "Plus", "date": "2026-09-04T12:00:00Z", "nextPayment": "2026-10-04", "active": True}],
        "savings": [{"id": 601, "name": "Caja", "amount": "8.75", "desc": "Reserva", "date": "2026-09-05T12:00:00Z"}],
    }


def restore(client, headers, payload):
    return client.post(
        "/api/backup/restore",
        data={"file": (io.BytesIO(json.dumps(payload).encode()), "backup.json")},
        headers=headers,
        content_type="multipart/form-data",
    )


# --- Autenticación y sesión ---------------------------------------------------

def test_authentication_protects_view_and_api(client):
    assert client.get("/").status_code == 302
    response = client.get("/api/data")
    assert response.status_code == 401
    assert response.get_json()["error"] == "Autenticación requerida"

    token = csrf_from_html(client.get("/login"))
    rejected = client.post(
        "/login",
        data=form(token, WRONG_PASSWORD),
    )
    assert rejected.status_code == 401
    assert b"incorrectos" in rejected.data


def test_login_cookie_and_csrf_protection(client):
    token = login(client)
    page = client.get("/")
    assert page.status_code == 200
    assert b'name="csrf-token"' in page.data

    missing_csrf = client.post("/api/payables", json={"name": "X", "amount": 1})
    assert missing_csrf.status_code == 400

    created = client.post(
        "/api/payables",
        json={"name": "X", "amount": "1.25", "desc": "", "date": "2026-09-01T00:00:00Z"},
        headers={"X-CSRF-Token": token},
    )
    assert created.status_code == 201
    assert created.get_json()["amount"] == "1.25"


def test_password_login_creates_a_persistent_session_and_marks_it_fresh(client):
    token = csrf_from_html(client.get("/login"))
    client.post(
        "/login",
        data=form(token),
    )
    with client.session_transaction() as active_session:
        assert active_session.permanent is True
        assert active_session["fresh_password_login"] is True

    first_page = client.get("/")
    assert b'name="auth-fresh" content="true"' in first_page.data
    second_page = client.get("/")
    assert b'name="auth-fresh" content="false"' in second_page.data


def test_device_credential_login_stores_only_hash(client, application):
    token = login(client)
    registered = client.post(
        "/api/auth/device/register",
        json={"label": "Android de prueba"},
        headers={"X-CSRF-Token": token},
    )
    assert registered.status_code == 201
    device_token = registered.get_json()["token"]
    with application.app_context():
        credential = DeviceCredential.query.one()
        assert credential.label == "Android de prueba"
        assert credential.token_hash != device_token
        assert len(credential.token_hash) == 64

    client.post("/logout", data={"csrf_token": token})
    login_csrf = csrf_from_html(client.get("/login"))
    unlocked = client.post(
        "/api/auth/device/login",
        json={"token": device_token},
        headers={"X-CSRF-Token": login_csrf},
    )
    assert unlocked.status_code == 200
    assert client.get("/api/data").status_code == 200

    with client.session_transaction() as active_session:
        revoke_csrf = active_session["csrf_token"]
    revoked = client.delete(
        "/api/auth/device",
        json={"token": device_token},
        headers={"X-CSRF-Token": revoke_csrf},
    )
    assert revoked.status_code == 204
    with application.app_context():
        assert DeviceCredential.query.count() == 0


def test_production_session_cookie_is_secure(make_app):
    secure_client = make_app(SESSION_COOKIE_SECURE=True).test_client()
    token = csrf_from_html(secure_client.get("/login"))
    secure_client.post(
        "/login",
        data=form(token),
    )
    cookie = secure_client.get_cookie("session")
    assert cookie.secure is True
    assert cookie.http_only is True
    assert cookie.same_site == "Lax"


def test_app_refuses_to_start_without_secret_key():
    with pytest.raises(RuntimeError, match="SECRET_KEY"):
        create_app({"TESTING": True, "SECRET_KEY": None, "SQLALCHEMY_DATABASE_URI": "sqlite://"})


# --- Rate limit ---------------------------------------------------------------

def failed_login(client, token, ip="203.0.113.10"):
    return client.post(
        "/login",
        data=form(token, WRONG_PASSWORD),
        headers={"X-Forwarded-For": ip},
    )


def test_login_is_rate_limited_after_five_failures_per_ip(client):
    token = csrf_from_html(client.get("/login"))
    for _ in range(5):
        assert failed_login(client, token).status_code == 401
    blocked = failed_login(client, token)
    assert blocked.status_code == 429
    assert "Demasiados intentos".encode() in blocked.data
    # Otra IP (la real, vía X-Forwarded-For de nginx) no comparte el cupo.
    assert failed_login(client, token, ip="198.51.100.7").status_code == 401


def test_successful_login_does_not_consume_the_limit(client):
    token = csrf_from_html(client.get("/login"))
    for _ in range(4):
        assert failed_login(client, token).status_code == 401
    ok = client.post(
        "/login",
        data=form(token),
        headers={"X-Forwarded-For": "203.0.113.10"},
    )
    assert ok.status_code == 302
    client.post("/logout", data={"csrf_token": login_csrf(client)})
    assert failed_login(client, csrf_from_html(client.get("/login"))).status_code == 401


def login_csrf(client):
    with client.session_transaction() as session:
        return session["csrf_token"]


def test_device_login_is_rate_limited_as_json(client):
    token = csrf_from_html(client.get("/login"))
    headers = {"X-CSRF-Token": token, "X-Forwarded-For": "203.0.113.20"}
    for _ in range(5):
        assert client.post("/api/auth/device/login", json={"token": "falso"}, headers=headers).status_code == 401
    blocked = client.post("/api/auth/device/login", json={"token": "falso"}, headers=headers)
    assert blocked.status_code == 429
    assert "Demasiados intentos" in blocked.get_json()["error"]


# --- Endpoints públicos -------------------------------------------------------

def test_health_is_public_and_fast(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.data == b"ok"


def test_app_version_is_public(client, application):
    data = client.get("/api/app/version").get_json()
    assert data["minBuild"] == application.config["MIN_APP_BUILD"]
    assert data["downloadUrl"].startswith("https://github.com/")


# --- Datos --------------------------------------------------------------------

def test_import_preserves_collections_and_exact_units(application):
    with application.app_context():
        counts = import_payload(sample_backup(), require_empty=True)
        assert counts == {
            "receivables": 1,
            "receivableContacts": 1,
            "payables": 1,
            "classes": 1,
            "memberships": 1,
            "savings": 1,
        }
        payload = database_payload()
        assert payload["receivables"][0]["amount"] == "12.34"
        assert payload["classes"][0]["hours"] == "1.5"
        assert payload["memberships"][0]["nextPayment"] == "2026-10-04"


def test_new_records_after_restore_continue_after_imported_ids(client):
    # En PostgreSQL las secuencias no avanzan con ids explícitos: sin reset_sequences esto daría duplicate key.
    headers = {"X-CSRF-Token": login(client)}
    assert restore(client, headers, sample_backup()).status_code == 200
    created = client.post("/api/receivables", json={
        "name": "Nuevo", "amount": "5", "desc": "", "date": "2026-09-10T00:00:00Z"
    }, headers=headers)
    assert created.status_code == 201
    assert created.get_json()["id"] == 102
    membership = client.post("/api/memberships", json={
        "name": "Otra", "cost": "1", "desc": "", "date": "2026-09-10T00:00:00Z"
    }, headers=headers)
    assert membership.get_json()["id"] == 502
    contact = client.post("/api/receivableContacts", json={"name": "Beto"}, headers=headers)
    assert contact.status_code == 201


def test_record_crud_does_not_replace_other_records(client):
    token = login(client)
    headers = {"X-CSRF-Token": token}
    first = client.post("/api/receivables", json={
        "name": "Ana", "amount": "10.00", "desc": "Uno", "date": "2026-09-01T00:00:00Z"
    }, headers=headers).get_json()
    second = client.post("/api/receivables", json={
        "name": "Beto", "amount": "20.00", "desc": "Dos", "date": "2026-09-01T00:00:00Z"
    }, headers=headers).get_json()

    updated = client.patch(f"/api/receivables/{first['id']}", json={
        **first, "amount": "11.50"
    }, headers=headers)
    assert updated.status_code == 200
    payload = client.get("/api/data").get_json()
    by_id = {item["id"]: item for item in payload["receivables"]}
    assert by_id[first["id"]]["amount"] == "11.5"
    assert by_id[second["id"]]["amount"] == "20"

    assert client.delete(f"/api/receivables/{first['id']}", headers=headers).status_code == 204
    assert len(client.get("/api/data").get_json()["receivables"]) == 1


def test_text_longer_than_column_is_a_validation_error(client):
    headers = {"X-CSRF-Token": login(client)}
    response = client.post("/api/payables", json={
        "name": "x" * 161, "amount": "1", "desc": "", "date": "2026-09-01T00:00:00Z"
    }, headers=headers)
    assert response.status_code == 400
    assert "160" in response.get_json()["error"]


def test_boolean_fields_are_parsed_strictly(client, application):
    headers = {"X-CSRF-Token": login(client)}
    note = client.post("/api/receivables", json={
        "name": "Ana", "amount": "3", "isNote": "false", "desc": "", "date": "2026-09-01T00:00:00Z"
    }, headers=headers)
    assert note.status_code == 201
    assert "isNote" not in note.get_json()
    membership = client.post("/api/memberships", json={
        "name": "GPT", "cost": "20", "active": "false", "desc": "", "date": "2026-09-01T00:00:00Z"
    }, headers=headers)
    assert membership.get_json()["active"] is False
    invalid = client.post("/api/memberships", json={
        "name": "GPT", "cost": "20", "active": "quizas", "desc": "", "date": "2026-09-01T00:00:00Z"
    }, headers=headers)
    assert invalid.status_code == 400


def test_contact_rename_is_transactional(client):
    token = login(client)
    headers = {"X-CSRF-Token": token}
    client.post("/api/receivables", json={
        "name": "Ana", "amount": "10", "desc": "", "date": "2026-09-01T00:00:00Z"
    }, headers=headers)
    contact = client.get("/api/data").get_json()["receivableContacts"][0]
    response = client.patch(
        f"/api/receivableContacts/{contact['id']}",
        json={"name": "Ana María"},
        headers=headers,
    )
    assert response.status_code == 200
    payload = client.get("/api/data").get_json()
    assert payload["receivables"][0]["name"] == "Ana María"


def test_backup_restore_is_atomic_on_invalid_data(client, application):
    token = login(client)
    headers = {"X-CSRF-Token": token}
    with application.app_context():
        import_payload(sample_backup())
        original = database_payload()

    invalid = sample_backup()
    invalid["classes"][0]["hours"] = "no-es-numero"
    response = restore(client, headers, invalid)
    assert response.status_code == 400
    with application.app_context():
        assert database_payload() == original

    download = client.get("/api/backup")
    assert download.status_code == 200
    assert "attachment" in download.headers["Content-Disposition"]


def test_sqlite_database_download_was_removed(client):
    login(client)
    assert client.get("/api/backup/database").status_code == 404


# --- CLI (python manage.py ...) ---------------------------------------------

def test_createsuperuser_creates_a_hashed_user(cli, application):
    result = cli.invoke(args=["createsuperuser", "--username", "maria"], input="una-clave-larga\nuna-clave-larga\n")
    assert result.exit_code == 0, result.output
    with application.app_context():
        user = User.query.filter_by(username="maria").one()
        assert verify_password(user, "una-clave-larga")


def test_createsuperuser_rejects_duplicates_and_short_passwords(cli, application):
    duplicate = cli.invoke(args=["createsuperuser", "--username", "ALEX", "--password", "una-clave-larga"])
    assert duplicate.exit_code != 0
    assert "ya existe" in duplicate.output
    short = cli.invoke(args=["createsuperuser", "--username", "otro", "--password", "corta"])
    assert short.exit_code != 0
    with application.app_context():
        assert User.query.count() == 1


def test_changepassword_revokes_device_credentials(cli, application):
    with application.app_context():
        user = User.query.one()
        db.session.add(DeviceCredential(user_id=user.id, token_hash="a" * 64, label="Android", created_at=utc_now()))
        db.session.commit()
    result = cli.invoke(args=["changepassword", "alex", "--password", "otra-clave-larga"])
    assert result.exit_code == 0, result.output
    assert "revocados: 1" in result.output
    with application.app_context():
        assert DeviceCredential.query.count() == 0
        assert verify_password(User.query.one(), "otra-clave-larga")


def test_listusers_shows_users(cli):
    result = cli.invoke(args=["listusers"])
    assert result.exit_code == 0
    assert "alex" in result.output


def test_loaddata_dry_run_validates_without_writing(cli, application, tmp_path):
    source = tmp_path / "bd.json"
    source.write_text(json.dumps(sample_backup()), encoding="utf-8")
    result = cli.invoke(args=["loaddata", str(source), "--dry-run"])
    assert result.exit_code == 0, result.output
    assert "receivables: 1" in result.output
    with application.app_context():
        assert Receivable.query.count() == 0


def test_loaddata_from_stdin_requires_force_to_replace(cli, application):
    payload = json.dumps(sample_backup())
    first = cli.invoke(args=["loaddata", "-"], input=payload)
    assert first.exit_code == 0, first.output
    again = cli.invoke(args=["loaddata", "-"], input=payload)
    assert again.exit_code != 0
    assert "--force" in again.output
    forced = cli.invoke(args=["loaddata", "-", "--force"], input=payload)
    assert forced.exit_code == 0, forced.output
    with application.app_context():
        assert Receivable.query.count() == 1
        assert User.query.count() == 1  # loaddata nunca toca usuarios


def test_dumpdata_round_trips_with_loaddata(cli, application):
    with application.app_context():
        import_payload(sample_backup())
        original = database_payload()
    dumped = cli.invoke(args=["dumpdata"])
    assert dumped.exit_code == 0
    assert json.loads(dumped.output) == original
    reloaded = cli.invoke(args=["loaddata", "-", "--force"], input=dumped.output)
    assert reloaded.exit_code == 0, reloaded.output
    with application.app_context():
        assert database_payload() == original


def test_invalid_json_is_rejected_by_loaddata(cli):
    result = cli.invoke(args=["loaddata", "-"], input="{no es json")
    assert result.exit_code != 0
    assert "JSON válido" in result.output


# --- PWA ----------------------------------------------------------------------

def test_pwa_files_never_cache_api_or_authenticated_html(client):
    worker = client.get("/service-worker.js")
    assert worker.status_code == 200
    source = worker.get_data(as_text=True)
    assert 'url.pathname.startsWith("/api/")' in source
    shell_section = source.split("];", 1)[0]
    assert '"/"' not in shell_section
    assert '"/login"' not in shell_section
    manifest = client.get("/manifest.webmanifest").get_json()
    assert manifest["display"] == "standalone"
    assert {icon["sizes"] for icon in manifest["icons"]} == {"192x192", "512x512"}


# --- Argon2id -----------------------------------------------------------------

def test_passwords_are_hashed_with_argon2id(application):
    with application.app_context():
        stored = User.query.one().password_hash
        assert stored.startswith("$argon2id$v=19$m=65536,t=3,p=4$")
        assert TEST_PASSWORD not in stored


def test_login_rehashes_passwords_with_outdated_parameters(client, application):
    from argon2 import PasswordHasher

    with application.app_context():
        user = User.query.one()
        user.password_hash = PasswordHasher(time_cost=1, memory_cost=8192, parallelism=1).hash(TEST_PASSWORD)
        db.session.commit()
    login(client)
    with application.app_context():
        assert User.query.one().password_hash.startswith("$argon2id$v=19$m=65536,t=3,p=4$")


def test_unknown_user_and_corrupt_hash_are_rejected(client, application):
    token = csrf_from_html(client.get("/login"))
    unknown = client.post("/login", data=form(token, WRONG_PASSWORD, username="nadie"))
    assert unknown.status_code == 401
    with application.app_context():
        User.query.one().password_hash = "no-es-un-hash"
        db.session.commit()
    corrupt = client.post("/login", data=form(token))
    assert corrupt.status_code == 401

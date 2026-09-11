import io
import json
import re
from pathlib import Path

import pytest
from werkzeug.security import generate_password_hash

from controlpagos import create_app, db
from controlpagos.models import DeviceCredential, Receivable, User
from controlpagos.services.data_service import database_payload, import_payload


@pytest.fixture()
def application():
    app = create_app({
        "TESTING": True,
        "SECRET_KEY": "test-secret",
        "SQLALCHEMY_DATABASE_URI": "sqlite://",
        "SESSION_COOKIE_SECURE": False,
    })
    with app.app_context():
        db.create_all()
        db.session.add(User(username="alex", password_hash=generate_password_hash("correcta")))
        db.session.commit()
    yield app


@pytest.fixture()
def client(application):
    return application.test_client()


def csrf_from_html(response):
    match = re.search(rb'name="csrf_token" value="([^"]+)"', response.data)
    assert match
    return match.group(1).decode()


def login(client):
    token = csrf_from_html(client.get("/login"))
    response = client.post(
        "/login",
        data={"username": "alex", "password": "correcta", "csrf_token": token},
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


def test_authentication_protects_view_and_api(client):
    assert client.get("/").status_code == 302
    response = client.get("/api/data")
    assert response.status_code == 401
    assert response.get_json()["error"] == "Autenticación requerida"

    token = csrf_from_html(client.get("/login"))
    rejected = client.post(
        "/login",
        data={"username": "alex", "password": "incorrecta", "csrf_token": token},
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
        data={"username": "alex", "password": "correcta", "csrf_token": token},
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


def test_production_session_cookie_is_secure():
    secure_app = create_app({
        "TESTING": True,
        "SECRET_KEY": "secure-test-secret",
        "SQLALCHEMY_DATABASE_URI": "sqlite://",
        "SESSION_COOKIE_SECURE": True,
    })
    with secure_app.app_context():
        db.create_all()
        db.session.add(User(username="alex", password_hash=generate_password_hash("correcta")))
        db.session.commit()
    secure_client = secure_app.test_client()
    token = csrf_from_html(secure_client.get("/login"))
    secure_client.post(
        "/login",
        data={"username": "alex", "password": "correcta", "csrf_token": token},
    )
    cookie = secure_client.get_cookie("session")
    assert cookie.secure is True
    assert cookie.http_only is True
    assert cookie.same_site == "Lax"


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
    response = client.post(
        "/api/backup/restore",
        data={"file": (io.BytesIO(json.dumps(invalid).encode()), "backup.json")},
        headers=headers,
        content_type="multipart/form-data",
    )
    assert response.status_code == 400
    with application.app_context():
        assert database_payload() == original

    download = client.get("/api/backup")
    assert download.status_code == 200
    assert "attachment" in download.headers["Content-Disposition"]


def test_sqlite_database_backup_is_a_consistent_download(tmp_path):
    database_path = tmp_path / "backup-test.sqlite3"
    app = create_app({
        "TESTING": True,
        "SECRET_KEY": "backup-test-secret",
        "SQLALCHEMY_DATABASE_URI": f"sqlite:///{database_path.as_posix()}",
        "SESSION_COOKIE_SECURE": False,
    })
    with app.app_context():
        db.create_all()
        db.session.add(User(username="alex", password_hash=generate_password_hash("correcta")))
        db.session.commit()
    backup_client = app.test_client()
    login(backup_client)
    response = backup_client.get("/api/backup/database")
    assert response.status_code == 200
    assert response.data.startswith(b"SQLite format 3\x00")
    assert "attachment" in response.headers["Content-Disposition"]
    assert response.headers["Content-Disposition"].endswith(".sqlite3")


def test_real_db_json_has_expected_migration_counts(application):
    source = Path(__file__).parents[1] / "db.json"
    if not source.exists():
        pytest.skip("db.json es privado y no está presente")
    with source.open(encoding="utf-8") as file:
        payload = json.load(file)
    with application.app_context():
        counts = import_payload(payload, require_empty=True)
    assert counts == {
        "receivables": 44,
        "receivableContacts": 9,
        "payables": 0,
        "classes": 1,
        "memberships": 1,
        "savings": 2,
    }


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

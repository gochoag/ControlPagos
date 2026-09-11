import json
import io
from datetime import date
from pathlib import Path

from flask import Blueprint, abort, jsonify, request, send_file
from sqlalchemy import func

from ..extensions import db
from ..models import Receivable, ReceivableContact, RESOURCE_MODELS
from ..security import check_csrf, login_required
from ..services.backup_service import BackupUnavailable, create_sqlite_snapshot
from ..services.data_service import (
    ValidationError,
    apply_payload,
    database_payload,
    import_payload,
    required_text,
    serialize_record,
)


api_bp = Blueprint("api", __name__, url_prefix="/api")


def json_body():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        raise ValidationError("El cuerpo debe ser un objeto JSON")
    return payload


@api_bp.get("/data")
@login_required
def get_data():
    return jsonify(database_payload())


@api_bp.post("/<resource>")
@login_required
def create_record(resource):
    csrf_error = check_csrf()
    if csrf_error:
        return csrf_error
    model = RESOURCE_MODELS.get(resource)
    if not model:
        abort(404)
    try:
        record = model()
        apply_payload(record, json_body())
        db.session.add(record)
        if isinstance(record, Receivable):
            existing = ReceivableContact.query.filter(func.lower(ReceivableContact.name) == record.name.lower()).first()
            if not existing:
                db.session.add(ReceivableContact(name=record.name))
        db.session.commit()
        return jsonify(serialize_record(record)), 201
    except ValidationError as exc:
        db.session.rollback()
        return jsonify(error=str(exc)), 400


@api_bp.patch("/<resource>/<int:record_id>")
@login_required
def update_record(resource, record_id):
    csrf_error = check_csrf()
    if csrf_error:
        return csrf_error
    model = RESOURCE_MODELS.get(resource)
    if not model:
        abort(404)
    record = db.session.get(model, record_id)
    if not record:
        abort(404)
    try:
        apply_payload(record, json_body())
        db.session.commit()
        return jsonify(serialize_record(record))
    except ValidationError as exc:
        db.session.rollback()
        return jsonify(error=str(exc)), 400


@api_bp.delete("/<resource>/<int:record_id>")
@login_required
def delete_record(resource, record_id):
    csrf_error = check_csrf()
    if csrf_error:
        return csrf_error
    model = RESOURCE_MODELS.get(resource)
    if not model:
        abort(404)
    record = db.session.get(model, record_id)
    if not record:
        abort(404)
    db.session.delete(record)
    db.session.commit()
    return "", 204


@api_bp.post("/receivableContacts")
@login_required
def create_contact():
    csrf_error = check_csrf()
    if csrf_error:
        return csrf_error
    try:
        name = required_text(json_body(), "name", "Nombre")
        existing = ReceivableContact.query.filter(func.lower(ReceivableContact.name) == name.lower()).first()
        if existing:
            return jsonify(serialize_record(existing))
        contact = ReceivableContact(name=name)
        db.session.add(contact)
        db.session.commit()
        return jsonify(serialize_record(contact)), 201
    except ValidationError as exc:
        return jsonify(error=str(exc)), 400


@api_bp.patch("/receivableContacts/<int:record_id>")
@login_required
def update_contact(record_id):
    csrf_error = check_csrf()
    if csrf_error:
        return csrf_error
    contact = db.session.get(ReceivableContact, record_id)
    if not contact:
        abort(404)
    try:
        new_name = required_text(json_body(), "name", "Nombre")
        duplicate = ReceivableContact.query.filter(
            func.lower(ReceivableContact.name) == new_name.lower(), ReceivableContact.id != contact.id
        ).first()
        if duplicate:
            raise ValidationError("Ya existe un cliente con ese nombre")
        old_name = contact.name
        contact.name = new_name
        Receivable.query.filter(Receivable.name == old_name).update({"name": new_name})
        db.session.commit()
        return jsonify(serialize_record(contact))
    except ValidationError as exc:
        db.session.rollback()
        return jsonify(error=str(exc)), 400


@api_bp.delete("/receivableContacts/<int:record_id>")
@login_required
def delete_contact(record_id):
    csrf_error = check_csrf()
    if csrf_error:
        return csrf_error
    contact = db.session.get(ReceivableContact, record_id)
    if not contact:
        abort(404)
    if Receivable.query.filter_by(name=contact.name, is_note=False).first():
        return jsonify(error="El cliente todavía tiene registros"), 409
    Receivable.query.filter_by(name=contact.name).delete()
    db.session.delete(contact)
    db.session.commit()
    return "", 204


@api_bp.get("/backup")
@login_required
def download_backup():
    response = jsonify(database_payload())
    response.headers["Content-Disposition"] = f'attachment; filename="control_pagos_backup_{date.today().isoformat()}.json"'
    return response


@api_bp.get("/backup/database")
@login_required
def download_database_backup():
    try:
        snapshot = create_sqlite_snapshot()
    except BackupUnavailable as exc:
        return jsonify(error=str(exc)), 409

    snapshot_bytes = Path(snapshot).read_bytes()
    Path(snapshot).unlink(missing_ok=True)
    return send_file(
        io.BytesIO(snapshot_bytes),
        mimetype="application/vnd.sqlite3",
        as_attachment=True,
        download_name=f"controlpagos_db_{date.today().isoformat()}.sqlite3",
    )


@api_bp.post("/backup/restore")
@login_required
def restore_backup():
    csrf_error = check_csrf()
    if csrf_error:
        return csrf_error
    uploaded = request.files.get("file")
    if not uploaded:
        return jsonify(error="Falta el archivo de respaldo"), 400
    try:
        counts = import_payload(json.load(uploaded.stream))
        return jsonify(success=True, counts=counts, data=database_payload())
    except (json.JSONDecodeError, UnicodeDecodeError):
        db.session.rollback()
        return jsonify(error="El archivo no contiene JSON válido"), 400
    except ValidationError as exc:
        db.session.rollback()
        return jsonify(error=str(exc)), 400

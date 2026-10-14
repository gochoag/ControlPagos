from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from ..extensions import db
from ..models import (
    ClassEntry,
    Membership,
    Payable,
    Receivable,
    ReceivableContact,
    RESOURCE_MODELS,
    Saving,
)


COLLECTIONS = (
    "receivables",
    "receivableContacts",
    "payables",
    "classes",
    "memberships",
    "savings",
)


class ValidationError(ValueError):
    pass


def utc_now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def parse_datetime(value):
    if not value:
        return utc_now()
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValidationError("Fecha inválida") from exc
    if parsed.tzinfo:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def serialize_datetime(value):
    return value.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


def required_text(payload, key, label):
    value = str(payload.get(key, "")).strip()
    if not value:
        raise ValidationError(f"{label} es obligatorio")
    return value


def optional_text(payload, key):
    return str(payload.get(key, "") or "").strip()


def to_scaled_integer(value, scale, label, allow_empty=False):
    if value in (None, ""):
        if allow_empty:
            return None
        raise ValidationError(f"{label} es obligatorio")
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise ValidationError(f"{label} debe ser numérico") from exc
    if not number.is_finite():
        raise ValidationError(f"{label} debe ser finito")
    return int((number * scale).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def format_scaled(value, scale):
    if value is None:
        return ""
    places = 2 if scale == 100 else 1
    return f"{Decimal(value) / scale:.{places}f}".rstrip("0").rstrip(".")


def serialize_record(record):
    if isinstance(record, ReceivableContact):
        return {"id": record.id, "name": record.name}
    result = {
        "id": record.id,
        "desc": record.description,
        "date": serialize_datetime(record.created_at),
    }
    if isinstance(record, Receivable):
        result.update(name=record.name, amount=format_scaled(record.amount_cents, 100))
        if record.is_note:
            result["isNote"] = True
    elif isinstance(record, Payable):
        result.update(name=record.name, amount=format_scaled(record.amount_cents, 100))
    elif isinstance(record, ClassEntry):
        result.update(student=record.student, hours=format_scaled(record.minutes, 60))
    elif isinstance(record, Membership):
        result.update(
            name=record.name,
            cost=format_scaled(record.cost_cents, 100),
            nextPayment=record.next_payment.isoformat() if record.next_payment else "",
            active=record.active,
        )
    elif isinstance(record, Saving):
        result.update(name=record.name, amount=format_scaled(record.amount_cents, 100))
        if record.is_note:
            result["isNote"] = True
    else:
        raise TypeError("Tipo de registro no soportado")
    return result


def apply_payload(record, payload):
    if not isinstance(payload, dict):
        raise ValidationError("El cuerpo debe ser un objeto JSON")
    record.description = optional_text(payload, "desc")
    record.created_at = parse_datetime(payload.get("date"))
    if isinstance(record, Receivable):
        record.name = required_text(payload, "name", "Nombre")
        record.is_note = bool(payload.get("isNote", False))
        record.amount_cents = to_scaled_integer(payload.get("amount"), 100, "Monto", record.is_note)
    elif isinstance(record, Payable):
        record.name = required_text(payload, "name", "Nombre")
        record.amount_cents = to_scaled_integer(payload.get("amount"), 100, "Monto")
    elif isinstance(record, ClassEntry):
        record.student = required_text(payload, "student", "Estudiante")
        record.minutes = to_scaled_integer(payload.get("hours"), 60, "Horas")
    elif isinstance(record, Membership):
        record.name = required_text(payload, "name", "Nombre")
        record.cost_cents = to_scaled_integer(payload.get("cost"), 100, "Costo")
        next_payment = payload.get("nextPayment")
        try:
            record.next_payment = None if not next_payment else datetime.strptime(next_payment, "%Y-%m-%d").date()
        except ValueError as exc:
            raise ValidationError("Fecha de pago inválida") from exc
        record.active = bool(payload.get("active", True))
    elif isinstance(record, Saving):
        record.name = required_text(payload, "name", "Nombre")
        record.is_note = bool(payload.get("isNote", False))
        record.amount_cents = to_scaled_integer(payload.get("amount"), 100, "Monto", record.is_note)
    else:
        raise ValidationError("Recurso no soportado")


def empty_payload():
    return {name: [] for name in COLLECTIONS}


def database_payload():
    return {
        "receivables": [serialize_record(item) for item in Receivable.query.order_by(Receivable.id)],
        "receivableContacts": [serialize_record(item) for item in ReceivableContact.query.order_by(ReceivableContact.name)],
        "payables": [serialize_record(item) for item in Payable.query.order_by(Payable.id)],
        "classes": [serialize_record(item) for item in ClassEntry.query.order_by(ClassEntry.id)],
        "memberships": [serialize_record(item) for item in Membership.query.order_by(Membership.id)],
        "savings": [serialize_record(item) for item in Saving.query.order_by(Saving.id)],
    }


def validate_backup_shape(payload):
    if not isinstance(payload, dict):
        raise ValidationError("El respaldo debe ser un objeto JSON")
    normalized = empty_payload()
    for name in COLLECTIONS:
        value = payload.get(name, [])
        if not isinstance(value, list):
            raise ValidationError(f"{name} debe ser una lista")
        normalized[name] = value
    return normalized


def clear_business_data():
    for model in (Receivable, ReceivableContact, Payable, ClassEntry, Membership, Saving):
        db.session.query(model).delete()


def import_payload(payload, require_empty=False):
    payload = validate_backup_shape(payload)
    if require_empty and any(model.query.first() for model in RESOURCE_MODELS.values()):
        raise ValidationError("La base ya contiene registros")
    if require_empty and ReceivableContact.query.first():
        raise ValidationError("La base ya contiene contactos")

    clear_business_data()
    contacts_by_name = {}
    for item in payload["receivableContacts"]:
        name = required_text(item, "name", "Nombre de contacto")
        key = name.casefold()
        if key not in contacts_by_name:
            contact = ReceivableContact(id=item.get("id"), name=name)
            db.session.add(contact)
            contacts_by_name[key] = contact

    for item in payload["receivables"]:
        record = Receivable(id=item.get("id"))
        apply_payload(record, item)
        db.session.add(record)
        key = record.name.casefold()
        if key not in contacts_by_name:
            contact = ReceivableContact(name=record.name)
            db.session.add(contact)
            contacts_by_name[key] = contact

    for collection, model in RESOURCE_MODELS.items():
        if collection == "receivables":
            continue
        for item in payload[collection]:
            record = model(id=item.get("id"))
            apply_payload(record, item)
            db.session.add(record)

    db.session.commit()
    return {name: len(payload[name]) for name in COLLECTIONS}

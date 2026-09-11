from sqlalchemy import BigInteger, Integer

from .extensions import db


ID_TYPE = BigInteger().with_variant(Integer, "sqlite")


class User(db.Model):
    __tablename__ = "users"
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)


class DeviceCredential(db.Model):
    __tablename__ = "device_credentials"
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    token_hash = db.Column(db.String(64), unique=True, nullable=False, index=True)
    label = db.Column(db.String(120), nullable=False, default="Android")
    created_at = db.Column(db.DateTime, nullable=False)
    last_used_at = db.Column(db.DateTime, nullable=True)


class ReceivableContact(db.Model):
    __tablename__ = "receivable_contacts"
    id = db.Column(ID_TYPE, primary_key=True, autoincrement=True)
    name = db.Column(db.String(160), unique=True, nullable=False)


class Receivable(db.Model):
    __tablename__ = "receivables"
    id = db.Column(ID_TYPE, primary_key=True, autoincrement=True)
    name = db.Column(db.String(160), nullable=False, index=True)
    amount_cents = db.Column(db.BigInteger, nullable=True)
    description = db.Column(db.Text, nullable=False, default="")
    created_at = db.Column(db.DateTime, nullable=False)
    is_note = db.Column(db.Boolean, nullable=False, default=False)


class Payable(db.Model):
    __tablename__ = "payables"
    id = db.Column(ID_TYPE, primary_key=True, autoincrement=True)
    name = db.Column(db.String(160), nullable=False, index=True)
    amount_cents = db.Column(db.BigInteger, nullable=False)
    description = db.Column(db.Text, nullable=False, default="")
    created_at = db.Column(db.DateTime, nullable=False)


class ClassEntry(db.Model):
    __tablename__ = "classes"
    id = db.Column(ID_TYPE, primary_key=True, autoincrement=True)
    student = db.Column(db.String(160), nullable=False, index=True)
    minutes = db.Column(db.Integer, nullable=False)
    description = db.Column(db.Text, nullable=False, default="")
    created_at = db.Column(db.DateTime, nullable=False)


class Membership(db.Model):
    __tablename__ = "memberships"
    id = db.Column(ID_TYPE, primary_key=True, autoincrement=True)
    name = db.Column(db.String(160), nullable=False)
    cost_cents = db.Column(db.BigInteger, nullable=False)
    description = db.Column(db.Text, nullable=False, default="")
    created_at = db.Column(db.DateTime, nullable=False)
    next_payment = db.Column(db.Date, nullable=True)
    active = db.Column(db.Boolean, nullable=False, default=True)


class Saving(db.Model):
    __tablename__ = "savings"
    id = db.Column(ID_TYPE, primary_key=True, autoincrement=True)
    name = db.Column(db.String(160), nullable=False, index=True)
    amount_cents = db.Column(db.BigInteger, nullable=True)
    description = db.Column(db.Text, nullable=False, default="")
    created_at = db.Column(db.DateTime, nullable=False)
    is_note = db.Column(db.Boolean, nullable=False, default=False)


RESOURCE_MODELS = {
    "receivables": Receivable,
    "payables": Payable,
    "classes": ClassEntry,
    "memberships": Membership,
    "savings": Saving,
}

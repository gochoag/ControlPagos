"""Comandos de administración al estilo Django: `python manage.py <comando>` (ver README)."""
import json

import click
from flask import Flask
from flask_migrate import upgrade
from sqlalchemy import func

from .extensions import db
from .models import DeviceCredential, User
from .security import hash_password
from .services.data_service import COLLECTIONS, ValidationError, database_payload, has_business_data, import_payload


MIN_PASSWORD_LENGTH = 12


def find_user(username):
    return User.query.filter(func.lower(User.username) == username.strip().lower()).first()


def validate_password(_ctx, _param, value):
    if len(value) < MIN_PASSWORD_LENGTH:
        raise click.BadParameter(f"debe tener al menos {MIN_PASSWORD_LENGTH} caracteres")
    return value


def password_option():
    return click.password_option(
        "--password",
        prompt="Contraseña",
        confirmation_prompt="Repite la contraseña",
        callback=validate_password,
        help="Si no se indica, se pide de forma oculta.",
    )


def print_counts(counts):
    for collection in COLLECTIONS:
        click.echo(f"  {collection}: {counts[collection]}")


def register_commands(app: Flask):
    @app.cli.command("migrate")
    def migrate_command():
        """Aplica las migraciones pendientes (alembic upgrade head)."""
        upgrade()
        click.echo("Migraciones aplicadas")

    @app.cli.command("createsuperuser")
    @click.option("--username", prompt="Usuario", help="Nombre de usuario.")
    @password_option()
    def createsuperuser_command(username, password):
        """Crea un usuario con acceso a la app."""
        username = username.strip()
        if not username or len(username) > 80:
            raise click.ClickException("El usuario debe tener entre 1 y 80 caracteres")
        if find_user(username):
            raise click.ClickException("Ese usuario ya existe")
        db.session.add(User(username=username, password_hash=hash_password(password)))
        db.session.commit()
        click.echo(f"Usuario '{username}' creado")

    @app.cli.command("changepassword")
    @click.argument("username")
    @password_option()
    def changepassword_command(username, password):
        """Cambia la contraseña y cierra el acceso rápido de todos sus dispositivos."""
        user = find_user(username)
        if not user:
            raise click.ClickException("Ese usuario no existe")
        user.password_hash = hash_password(password)
        revoked = DeviceCredential.query.filter_by(user_id=user.id).delete()
        db.session.commit()
        click.echo(f"Contraseña cambiada; dispositivos revocados: {revoked}")

    @app.cli.command("listusers")
    def listusers_command():
        """Lista los usuarios y sus dispositivos registrados."""
        rows = (
            db.session.query(User.id, User.username, func.count(DeviceCredential.id))
            .outerjoin(DeviceCredential, DeviceCredential.user_id == User.id)
            .group_by(User.id, User.username)
            .order_by(User.id)
            .all()
        )
        if not rows:
            click.echo("No hay usuarios. Crea uno con: python manage.py createsuperuser")
        for user_id, username, devices in rows:
            click.echo(f"{user_id}\t{username}\tdispositivos: {devices}")

    @app.cli.command("loaddata")
    @click.argument("source", type=click.File("r", encoding="utf-8"))
    @click.option("--dry-run", is_flag=True, help="Valida y muestra los conteos sin guardar nada.")
    @click.option("--force", is_flag=True, help="Reemplaza los datos si la base ya tiene registros.")
    def loaddata_command(source, dry_run, force):
        """Importa un respaldo JSON (archivo o '-' para stdin). No toca usuarios."""
        try:
            payload = json.load(source)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise click.ClickException("El archivo no contiene JSON válido") from exc
        if not dry_run and not force and has_business_data():
            raise click.ClickException("La base ya tiene datos; usa --force para reemplazarlos")
        try:
            counts = import_payload(payload, commit=not dry_run)
        except ValidationError as exc:
            db.session.rollback()
            raise click.ClickException(str(exc)) from exc
        if dry_run:
            db.session.rollback()
            click.echo("Validación correcta (no se guardó nada):")
        else:
            click.echo("Datos importados:")
        print_counts(counts)

    @app.cli.command("dumpdata")
    @click.argument("target", type=click.File("w", encoding="utf-8"), default="-")
    def dumpdata_command(target):
        """Exporta los datos a JSON (archivo o stdout). Mismo formato que /api/backup."""
        json.dump(database_payload(), target, ensure_ascii=False, indent=2)
        target.write("\n")

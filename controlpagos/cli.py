import json
from pathlib import Path

import click
from flask import Flask
from sqlalchemy import func
from werkzeug.security import generate_password_hash

from .extensions import db
from .models import User
from .services.data_service import COLLECTIONS, ValidationError, import_payload


def register_commands(app: Flask):
    @app.cli.command("init-db")
    def init_db_command():
        db.create_all()
        click.echo("Base de datos inicializada")

    @app.cli.command("create-user")
    @click.option("--username", prompt="Usuario")
    @click.password_option(confirmation_prompt=True)
    def create_user_command(username, password):
        username = username.strip()
        if not username:
            raise click.ClickException("El usuario no puede estar vacío")
        if not password:
            raise click.ClickException("La contraseña no puede estar vacía")
        existing = User.query.filter(func.lower(User.username) == username.lower()).first()
        if existing:
            raise click.ClickException("Ese usuario ya existe")
        db.session.add(User(username=username, password_hash=generate_password_hash(password)))
        db.session.commit()
        click.echo("Usuario creado")

    @app.cli.command("import-json")
    @click.argument("filename", type=click.Path(exists=True, dir_okay=False, path_type=Path))
    @click.option("--require-empty", is_flag=True)
    def import_json_command(filename, require_empty):
        try:
            with filename.open("r", encoding="utf-8") as source:
                counts = import_payload(json.load(source), require_empty=require_empty)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise click.ClickException("El archivo no contiene JSON válido") from exc
        except ValidationError as exc:
            db.session.rollback()
            raise click.ClickException(str(exc)) from exc
        for collection in COLLECTIONS:
            click.echo(f"{collection}: {counts[collection]}")

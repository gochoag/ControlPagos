"""Administración de ControlPagos: `python manage.py --help`."""
from flask.cli import FlaskGroup

from controlpagos import create_app


cli = FlaskGroup(create_app=create_app, help="Comandos de ControlPagos (migrate, createsuperuser, loaddata...).")


if __name__ == "__main__":
    cli()

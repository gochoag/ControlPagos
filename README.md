# ControlPagos 💰

Aplicación personal para controlar cuentas por cobrar y pagar, clases, membresías y ahorros. La misma instalación ofrece una vista web responsive, una API privada, una PWA y una app Android (Capacitor). Los datos se guardan en PostgreSQL y el acceso requiere usuario y contraseña.

Producción: `https://controlpagos.cfd`, desplegada en el VPS del equipo con [infra-vps-tecnomovil](https://github.com/JuanRZAR/infra-vps-tecnomovil).

## Arquitectura

El proyecto aplica **Application Factory + Blueprints + Service Layer**:

```text
controlpagos/
├── __init__.py              # Fábrica y composición de la aplicación
├── config.py                # Configuración y entorno
├── extensions.py            # SQLAlchemy, Flask-Migrate y Flask-Limiter
├── models.py                # Modelo relacional
├── security.py              # Sesión, autenticación y CSRF
├── cli.py                   # Comandos de administración (manage.py)
├── blueprints/              # Controladores HTTP: web, auth y API
├── services/                # Reglas de datos, importación y respaldos
├── templates/               # Vistas HTML
└── static/                  # CSS compilado, JS, iconos
deploy/
├── deploy-dev/              # PostgreSQL (y la app en Docker) para tu equipo
└── deploy-produccion/       # Lo que lee el VPS (compose, .env.example)
mobile/                      # App Android (ver mobile/README.md)
```

`wsgi.py` es el punto de entrada de gunicorn y `manage.py` el de los comandos de administración.

## Desarrollo local

Requisitos: Python 3.12, Docker y (para los tests de JS) Bun.

```powershell
python -m venv .venv
.venv\Scripts\pip install -r requirements-dev.txt
Copy-Item .env.example .env                                   # y pon una SECRET_KEY larga
Copy-Item deploy\deploy-dev\.env.example deploy\deploy-dev\.env
docker compose -f deploy/deploy-dev/compose.yml up -d db      # PostgreSQL 17 en 127.0.0.1:5433
.venv\Scripts\python manage.py migrate
.venv\Scripts\python manage.py createsuperuser
.venv\Scripts\python manage.py run --debug                    # http://127.0.0.1:5000
```

Genera la `SECRET_KEY` con `python -c "import secrets; print(secrets.token_hex(32))"`. Sin ella la app no arranca.

Para probar la **misma imagen que producción** (gunicorn, usuario 10001, solo lectura): `docker compose -f deploy/deploy-dev/compose.yml up --build` → `http://127.0.0.1:8000`.

Si modificas `controlpagos/static/css/source.css` o las clases usadas por las plantillas/JavaScript: `npm install` y `npm run build:css`.

## Comandos de administración

Al estilo de Django: `python manage.py <comando>` (en el VPS, dentro del contenedor; ver [deploy/deploy-produccion/README.md](deploy/deploy-produccion/README.md)).

| Comando | Qué hace |
|---|---|
| `migrate` | Aplica las migraciones pendientes |
| `createsuperuser [--username X]` | Crea un usuario; pide la contraseña oculta dos veces (mínimo 12 caracteres) |
| `changepassword <usuario>` | Cambia la contraseña y revoca el acceso con huella/PIN de todos sus dispositivos |
| `listusers` | Lista los usuarios y sus dispositivos |
| `loaddata <archivo\|->` | Importa un respaldo JSON (archivo o stdin). `--dry-run` valida sin guardar; `--force` reemplaza si ya hay datos. No toca usuarios |
| `dumpdata [archivo\|-]` | Exporta los datos a JSON (mismo formato que **Respaldos JSON**) |
| `db ...` | Comandos de Flask-Migrate (`db migrate -m "..."` para crear una migración nueva) |

## Pruebas

```powershell
docker compose -f deploy/deploy-dev/compose.yml exec db createdb -U app pruebas   # una vez
$env:TEST_DATABASE_URL = "postgresql://app:app@127.0.0.1:5433/pruebas"
.venv\Scripts\python -m pytest       # sin TEST_DATABASE_URL usa SQLite en memoria
bun test
```

Los tests borran y recrean las tablas de la base `pruebas`: nunca apuntes `TEST_DATABASE_URL` a la base `app`.

## Despliegue (CI/CD)

`.github/workflows/deploy.yml` llama al flujo compartido del VPS:

```text
PR a main:    Pruebas (pytest sobre PostgreSQL + bun) → Imagen (vps-check, hadolint, build, Trivy, prueba de consumo)
push a main:  lo anterior → imagen a GHCR → despliegue azul/verde (volcado + migrate + /health) → aviso a Telegram si falla
tag app-v*:   APK firmado → GitHub Release (ver mobile/README.md)
```

Las migraciones deben ser compatibles con la versión anterior: durante unos segundos conviven las dos.

## Seguridad

- Contraseñas con **Argon2id** (perfil RFC 9106 de baja memoria: t=3, 64 MiB, p=4). Si cambian los parámetros, el hash se rehace solo en el siguiente login correcto. Un usuario inexistente tarda lo mismo que una contraseña errónea.
- Sesión firmada con cookie `HttpOnly`, `SameSite=Lax` y `Secure` en producción.
- CSRF en todas las mutaciones.
- Rate limit en el login y en el acceso con huella/PIN: 5 intentos fallidos por minuto y 30 por hora por IP (los aciertos no cuentan). La IP real llega de Cloudflare → nginx vía `X-Forwarded-For`.
- `GET /health` y `GET /api/app/version` son públicos y no exponen datos.

## API privada

La API usa la misma sesión segura de la vista web y exige el token CSRF en todas las mutaciones.

- `GET /api/data`: carga las seis colecciones.
- `POST /api/{receivables|payables|classes|memberships|savings}`: crea un registro.
- `PATCH /api/<recurso>/<id>`: actualiza un registro.
- `DELETE /api/<recurso>/<id>`: elimina un registro.
- `POST/PATCH/DELETE /api/receivableContacts[/<id>]`: administra clientes; los cambios de nombre actualizan su historial en una transacción.
- `GET /api/backup`: descarga un respaldo JSON.
- `POST /api/backup/restore`: valida y restaura un respaldo completo en una transacción.
- `GET /api/app/version` (público): build mínima del APK y URL de descarga.

Las peticiones sin sesión reciben `401`; las mutaciones sin CSRF, `400`; demasiados intentos de login, `429`.

## Respaldos

Desde **Datos > Respaldos JSON** se puede exportar los datos en JSON y restaurar un JSON validado de forma atómica. En Android se abre el panel nativo para guardar o compartir el archivo. Además, el VPS hace un volcado diario de la base y otro antes de cada migración.

`.env`, `bd.json` y los respaldos son privados y están en `.gitignore`: este repositorio es público.

## Acceso rápido en Android

Después de entrar con usuario y contraseña, la app ofrece activar el acceso con huella o PIN. La contraseña no se guarda: Android cifra una credencial aleatoria mediante Keystore y el servidor conserva únicamente su hash. **Más > Desactivar huella/PIN** la revoca; `changepassword` revoca todas.

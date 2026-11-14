# PROJECT_MEMORY — ControlPagos

Bitácora para ponerse al día rápido: qué se hizo y qué se decidió, por fecha (lo más reciente arriba). Breve: el detalle está en el código y en `git log`. Reglas de trabajo en [CLAUDE.md](CLAUDE.md).

## Estado actual

- **Hecho en local (sin subir):** migración a PostgreSQL, CLI de administración, hardening, actualización forzada del APK, Docker + CI.
- **Pendiente:**
  1. Crear el usuario: `python manage.py createsuperuser`.
  2. El usuario hace commit y PR de ControlPagos (GitHub Desktop).
  3. PR a `infra-vps-tecnomovil`, rama `plantillas-agnosticas`.
  4. Cloudflare para `controlpagos.cfd`.
  5. Alta en el VPS (`projects.yml`, cert, `vps-new-project`, `.env`, clave CI, OAuth Tailscale) y los secrets de GitHub (7 de despliegue + 4 de Android).
  6. Primer despliegue y `loaddata` de `bd.json`.
  7. Generar el keystore y publicar el tag `app-v2`.
  8. Apagar PythonAnywhere.

---

## 2026-11-14 — Paso de PythonAnywhere al VPS

**Decisiones**
- Despliegue en el VPS compartido "tecnomovil" (el usuario es su admin) siguiendo `infra-vps-tecnomovil`. Dominio `controlpagos.cfd` en la raíz. Puertos esperados: 8111/8112. Postgres compartido.
- `bd.json` es la fuente de verdad de los datos. La SQLite local (`instance/controlpagos.sqlite3`, 44 registros) eran pruebas y se descarta.
- PG local con Docker (`deploy/deploy-dev`, puerto 5433), no con el PG 17 nativo de Windows.
- APK distribuido por **GitHub Releases** (el repo es público). La app consulta `/api/app/version` y bloquea si `versionCode < MIN_APP_BUILD`.
- Hash de contraseñas: **Argon2id**, perfil RFC 9106 low-memory (t=3, 64 MiB, p=4).
  - Comparado con el scrypt de Werkzeug y con el perfil OWASP de 19 MiB, se mantiene este: la RAM se usa solo durante unos 65 ms por login.
  - Sin compatibilidad con scrypt: no había usuarios que migrar.
- CLI al estilo Django en `manage.py`. `loaddata` lee de stdin para cargar datos en el VPS con `docker exec -i` sin copiar archivos.
- Rate limit con Flask-Limiter en memoria (shortcut: el límite efectivo se multiplica por 4 con 2 workers × azul/verde; pasar a Redis si hay más usuarios).
- `infra-vps-tecnomovil` debe ser la única guía: se crearon `plantillas/` **agnósticas del lenguaje** con `<MARCADORES>` y tabla por lenguaje en guía 02 §2.4. ControlPagos es la primera adaptación (Python). No copiar de DawerTech.
- El PR al repo infra lo sube el usuario (cuando prefiera; ControlPagos no depende de él porque el workflow reutilizable `@v1` no cambió).
- **Git:** los agentes no hacen commit ni push; el usuario usa GitHub Desktop.

**Hecho**
- **PostgreSQL:**
  - `psycopg` y normalización de `postgresql://` a `+psycopg`.
  - Pool limitado a 16 conexiones en el peor caso.
  - Corregido el bug de las secuencias tras importar con ids explícitos (`reset_sequences`).
  - `bd.json` importado en el PG local: 42/9/0/10/3/0, ids idénticos y sin desfase entre modelos y migraciones.
- **Eliminado:**
  - `iniciar.bat`, el `debug=True` de `wsgi.py`, los scripts de ADB y la sección de PythonAnywhere del README.
  - El endpoint y el botón de copia SQLite (`/api/backup/database`, `backup_service.py`), porque exponían hashes y no funcionan en PG.
- **Seguridad:**
  - Rate limit 5/min y 30/h por IP en el login y en el login por dispositivo.
  - `ProxyFix`.
  - `SECRET_KEY` obligatoria.
  - Validación de longitud y de booleanos estricta.
  - `changepassword` revoca los dispositivos.
  - Login en tiempo constante para usuarios inexistentes.
  - `/health`.
- **Móvil:**
  - `server.url` pasa a `https://controlpagos.cfd`.
  - `@capacitor/app` y overlay de actualización obligatoria en `native-bridge`.
  - Firma release por variables de entorno.
  - `versionCode 2`.
- **Infra:**
  - Dockerfile, `.dockerignore`, `deploy/deploy-dev` y `deploy/deploy-produccion` adaptados de las plantillas.
  - Workflows `deploy.yml` (Pruebas → Imagen → Desplegar) y `apk.yml` (tag `app-v*`).
  - Verificado en local: `vps-check` OK, hadolint OK, Trivy 0 críticas, imagen de 256 MB, unos 116 MiB en reposo.
- **Tests:** 31 pytest (en SQLite y en PG) + 16 bun.
- Plan completo de la migración: `~/.claude/plans/mira-tengo-un-proyecto-expressive-dolphin.md` (en el PC del usuario).

## 2026-10-14 — Refactor a Python

- Merge del PR #1 (`refactor/to_python`): el backend pasa de Node + `db.json` a Flask + SQLAlchemy + Alembic sobre SQLite, con login por sesión, CSRF y credenciales de dispositivo (huella/PIN) guardadas como hash.

## 2026-03 a 2026-09 — Antes del refactor

- App en PythonAnywhere con un JSON como base de datos.
- Se quitaron la integración con WhatsApp y los campos de teléfono.
- npm → bun para los tests de JS.

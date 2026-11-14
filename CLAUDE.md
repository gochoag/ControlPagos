# CLAUDE.md — reglas para agentes en ControlPagos

Lee también [PROJECT_MEMORY.md](PROJECT_MEMORY.md): historial por fecha de lo hecho y las decisiones tomadas. Actualízalo al terminar un cambio relevante (una entrada breve bajo la fecha del día).

## Git: solo lectura

- **No ejecutes comandos de git que escriban**: nada de `commit`, `push`, `pull`, `merge`, `rebase`, `reset`, `checkout`/`switch`, `branch -d`, `tag`, `stash` ni `gh pr create`. El usuario hace los commits, el push y los PR con **GitHub Desktop**.
- Sí puedes leer: `git status`, `git diff`, `git log`, `git show`, `git check-ignore`.
- Al terminar, deja los cambios en el árbol de trabajo y resume qué archivos tocaste para que el usuario los revise y los suba.
- Esto aplica también al repo `infra-vps-tecnomovil`.

## El repo es público

- Nunca subas `.env`, `bd.json`, respaldos (`*.dump`, `*.sql`), keystores (`*.jks`, `*.keystore`), APKs ni IPs/credenciales del VPS. Ya están en `.gitignore`: compruébalo con `git check-ignore <archivo>` antes de crear algo sensible.
- `bd.json` (datos reales de PythonAnywhere) es privado y es la fuente de verdad de los datos. No contiene usuarios.

## Stack y comandos

- Flask 3 (application factory + blueprints + services), SQLAlchemy, Alembic (Flask-Migrate), PostgreSQL 17, gunicorn, Capacitor 8 (Android).
- Administración al estilo Django: `python manage.py <migrate|createsuperuser|changepassword|listusers|loaddata|dumpdata|db ...>`. No reintroduzcas `create_all` ni `init-db`: el esquema solo cambia con migraciones.
- PG local: `docker compose -f deploy/deploy-dev/compose.yml up -d db` (127.0.0.1:5433; base `app`, base de tests `pruebas`).
- Tests: `TEST_DATABASE_URL=postgresql://app:app@127.0.0.1:5433/pruebas python -m pytest` (con `python -m`: el `pytest` a secas no encuentra el paquete) (sin la variable usa SQLite en memoria) y `bun test`. Los tests borran y recrean tablas: **nunca** apuntes `TEST_DATABASE_URL` a la base `app`.
- Toda lógica nueva no trivial lleva su test. Antes de dar algo por terminado, corre pytest (idealmente contra PG) y bun.

## Reglas de seguridad que no se relajan

- Contraseñas: **Argon2id** (`controlpagos/security.py`, perfil RFC 9106 low-memory). Usa siempre `hash_password` / `verify_password`; nunca `werkzeug.security`.
- Rate limit (Flask-Limiter) en `POST /login` y `POST /api/auth/device/login`: solo cuentan los fallos. La IP real llega por `ProxyFix(x_for=1)`.
- Todas las mutaciones exigen CSRF (`check_csrf()`), y todas las rutas privadas `@login_required`.
- `SECRET_KEY` es obligatoria (la app no arranca sin ella). `SESSION_COOKIE_SECURE=true` en producción.
- `/health` y `/api/app/version` son públicos: sin base de datos ni datos sensibles.
- Valida en el borde: textos con `required_text` (máx. 160) y booleanos con `parse_bool`.

## Base de datos

- Migraciones **compatibles con la versión anterior** (en el despliegue azul/verde conviven dos versiones): añadir columnas que admitan nulos; renombrar o borrar en dos despliegues.
- Tras insertar ids explícitos en PG hay que reajustar las secuencias (`reset_sequences()` en `data_service.py`; ya lo hace `import_payload`).
- Pool: 3 + 1 por worker. 2 workers × 4 × 2 versiones = 16, por debajo del límite de 20 conexiones del rol. No subas workers ni pool sin rehacer esa cuenta.

## Despliegue (VPS tecnomovil)

- La única fuente de verdad es el repo `infra-vps-tecnomovil` (guía + `plantillas/` agnósticas del lenguaje). **No copies de otros proyectos** (p. ej. DawerTech).
- `deploy/deploy-produccion/compose.yml` debe pasar `vps-check`. Usuario 10001, solo lectura, `/tmp` como tmpfs. El healthcheck usa `python -c urllib` (la imagen slim no trae `wget`).
- CI (`.github/workflows/deploy.yml`): Pruebas → Imagen (vps-check, hadolint, build, Trivy, prueba de consumo) → Desplegar. La prueba de consumo arranca sin base ni secretos (`env_prueba`).
- Dominio: `controlpagos.cfd` (raíz, detrás de Cloudflare).

## App móvil

- Es un WebView remoto: los cambios web llegan solos. Solo los cambios **nativos** (plugins, `capacitor.config.json`, `android/`) requieren APK nuevo.
- Si un cambio exige APK nuevo, en el mismo PR: sube `versionCode` en `mobile/android/app/build.gradle` e iguala `MIN_APP_BUILD` en `controlpagos/config.py`. El tag `app-v<versionCode>` (workflow `apk.yml`) se sube sobre el último commit del PR **antes del merge**: si se despliega antes de que exista el release, el bloqueo descarga el APK viejo.
- Si tocas `mobile/src/native-bridge.js`, ejecuta `npm run build:bridge` (en `mobile/`): el bundle servido vive en `controlpagos/static/js/mobile/`.

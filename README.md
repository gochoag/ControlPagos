# ControlPagos 💰

Aplicación personal para controlar cuentas por cobrar y pagar, clases, membresías y ahorros. La misma instalación ofrece una vista web responsive, una API privada y una PWA instalable en Android. Los datos se guardan en SQLite y el acceso requiere usuario y contraseña.

## Arquitectura

El proyecto aplica **Application Factory + Blueprints + Service Layer**:

```text
controlpagos/
├── __init__.py              # Fábrica y composición de la aplicación
├── config.py                # Configuración y entorno
├── extensions.py            # SQLAlchemy y Flask-Migrate
├── models.py                # Modelo relacional
├── security.py              # Sesión, autenticación y CSRF
├── blueprints/              # Controladores HTTP: web, auth y API
├── services/                # Reglas de datos, migración y respaldos
├── templates/               # Vistas HTML
└── static/
    ├── css/
    ├── images/
    └── js/
        ├── config/          # Configuración visual
        ├── core/            # Estado de la app y cliente API
        ├── domain/          # Reglas reutilizables del frontend
        └── ui/              # Interacciones de interfaz
```

`wsgi.py` es el único punto de entrada. Las rutas reciben peticiones, los servicios contienen las reglas y los modelos se limitan a persistencia; así cada capa puede probarse sin mezclar responsabilidades.

## Ejecutar en Windows

Requisitos: Python 3.11 o posterior.

1. Copia `.env.example` como `.env` y reemplaza `SECRET_KEY` por una clave larga. Puedes generarla con:

   ```powershell
   python -c "import secrets; print(secrets.token_hex(32))"
   ```

2. Ejecuta `iniciar.bat`. La primera ejecución crea `.venv`, instala las dependencias, aplica las migraciones y abre `http://127.0.0.1:5000`.

Los estilos se entregan desde el propio servidor, sin depender de CDN. Si modificas `controlpagos/static/css/source.css` o las clases usadas por las plantillas/JavaScript, ejecuta:

```powershell
npm install
npm run build:css
```
3. Antes del primer ingreso, crea tu usuario desde una terminal en la carpeta del proyecto:

   ```powershell
   .venv\Scripts\python.exe -m flask --app wsgi create-user
   ```

4. Para importar el `db.json` histórico una sola vez:

   ```powershell
   .venv\Scripts\python.exe -m flask --app wsgi import-json db.json --require-empty
   ```

El comando debe informar estos conteos para el archivo actual: 44 `receivables`, 9 `receivableContacts`, 0 `payables`, 1 `classes`, 1 `memberships` y 2 `savings`.

## Publicar gratis en PythonAnywhere

La cuenta gratuita sirve para este uso personal: ofrece un subdominio `tuusuario.pythonanywhere.com`, un proceso web y SQLite. Debes entrar al panel aproximadamente una vez al mes y extender la aplicación; si vence, PythonAnywhere detiene la web pero conserva sus archivos y configuración.

### 1. Descargar el proyecto

Crea una cuenta, abre una consola **Bash** y ejecuta:

```bash
git clone https://github.com/gochoag/ControlPagos.git
cd ControlPagos
python3.13 -m venv ~/.virtualenvs/controlpagos
source ~/.virtualenvs/controlpagos/bin/activate
pip install -r requirements.txt
```

Si PythonAnywhere ofrece otra versión estable, usa esa misma versión tanto al crear el entorno como al configurar la aplicación web.

### 2. Configurar secretos y base

Crea `/home/tuusuario/ControlPagos/.env` desde la pestaña **Files**. No subas este archivo a Git:

```dotenv
SECRET_KEY=PEGA_AQUI_UNA_CLAVE_ALEATORIA_DE_64_CARACTERES
DATABASE_URL=sqlite:////home/tuusuario/ControlPagos/instance/controlpagos.sqlite3
SESSION_COOKIE_SECURE=true
```

Genera la clave desde Bash con `python -c "import secrets; print(secrets.token_hex(32))"`. Luego ejecuta:

```bash
cd ~/ControlPagos
source ~/.virtualenvs/controlpagos/bin/activate
flask --app wsgi db upgrade
flask --app wsgi create-user
```

El último comando solicita usuario y contraseña sin dejar la contraseña escrita en el historial.

### 3. Importar los datos privados

`db.json` está ignorado por Git. Súbelo con **Files → Upload** a `/home/tuusuario/ControlPagos/db.json` y ejecuta:

```bash
cd ~/ControlPagos
source ~/.virtualenvs/controlpagos/bin/activate
flask --app wsgi import-json db.json --require-empty
```

Comprueba los seis conteos. Inicia sesión cuando la web esté publicada y usa **Respaldos JSON → Guardar copia** para verificar la exportación. Después de comprobarla, puedes borrar del servidor el `db.json` subido; SQLite será la base activa.

### 4. Crear la aplicación web

1. Abre **Web → Add a new web app**.
2. Elige **Manual configuration** y la misma versión de Python usada en el entorno.
3. En **Virtualenv**, configura `/home/tuusuario/.virtualenvs/controlpagos`.
4. Edita el archivo WSGI que muestra PythonAnywhere y deja este contenido, sustituyendo `tuusuario`:

   ```python
   import sys

   project_path = "/home/tuusuario/ControlPagos"
   if project_path not in sys.path:
       sys.path.insert(0, project_path)

   from wsgi import app as application
   ```

5. En **Static files** configura:

   | URL | Directorio |
   | --- | --- |
   | `/static/` | `/home/tuusuario/ControlPagos/controlpagos/static` |

6. Activa **Force HTTPS**, pulsa **Reload** y abre `https://tuusuario.pythonanywhere.com`.
7. Si aparece un error, revisa los enlaces de **Error log** y **Server log** en la pestaña Web.

### 5. Instalar en Android

1. Abre la URL HTTPS en Chrome e inicia sesión.
2. Abre el menú de Chrome y selecciona **Instalar aplicación** o **Agregar a pantalla principal**.
3. Abre ControlPagos desde el nuevo icono. La PWA necesita Internet para leer o modificar datos.

## Actualizar la web

Antes de actualizar, descarga un respaldo JSON. En Bash:

```bash
cd ~/ControlPagos
source ~/.virtualenvs/controlpagos/bin/activate
git pull
pip install -r requirements.txt
flask --app wsgi db upgrade
```

Después pulsa **Reload** en la pestaña Web. En el plan gratuito, revisa también la fecha **Expiry/Best before date** y extiéndela antes de que venza.

## API privada

La API usa la misma sesión segura de la vista web y exige el token CSRF en todas las mutaciones.

- `GET /api/data`: carga las seis colecciones.
- `POST /api/{receivables|payables|classes|memberships|savings}`: crea un registro.
- `PATCH /api/<recurso>/<id>`: actualiza un registro.
- `DELETE /api/<recurso>/<id>`: elimina un registro.
- `POST/PATCH/DELETE /api/receivableContacts[/<id>]`: administra clientes; los cambios de nombre actualizan su historial en una transacción.
- `GET /api/backup`: descarga un respaldo JSON.
- `POST /api/backup/restore`: valida y restaura un respaldo completo en una transacción.

Las peticiones sin sesión reciben `401`; las mutaciones sin CSRF reciben `400`.

## Pruebas

```bash
python -m pytest
bun test
node --check controlpagos/static/js/core/app.js
node --check controlpagos/static/js/core/api.js
```

La base activa (`instance/controlpagos.sqlite3`), `.env` y `db.json` son privados y no se incluyen en Git. Conserva respaldos JSON periódicos fuera de PythonAnywhere.
## Respaldos

Desde **Datos > Respaldos JSON** se puede:

- exportar los datos financieros en JSON;
- restaurar un JSON validado de forma atómica;
- descargar una copia consistente de la base SQLite completa.

La copia SQLite también contiene usuarios y credenciales de dispositivos, por lo que debe guardarse en un lugar privado. En Android, la aplicación abre el panel nativo para guardar o compartir el archivo. En PC usa la descarga normal del navegador.

## Acceso rápido en Android

Después de entrar con usuario y contraseña, la APK ofrece activar el acceso con huella o PIN. La contraseña no se guarda: Android cifra una credencial aleatoria mediante Keystore y el servidor conserva únicamente su hash. La opción **Más > Desactivar huella/PIN** revoca esa credencial.

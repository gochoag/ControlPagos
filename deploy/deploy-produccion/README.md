# Despliegue de producción de ControlPagos

- **Qué se despliega**: la app Flask (HTML + API) servida por gunicorn (2 workers) en `https://controlpagos.cfd`. No hay web estática aparte.
- **Imagen**: construida desde `Dockerfile` (raíz) por GitHub Actions.
- **Salud**: `GET /health` (sin base de datos ni autenticación).
- **Base de datos**: Postgres compartido del VPS (red `infra`). Pool: 3 + 1 conexiones por worker → 16 en el peor caso del azul/verde (límite 20).
- **Migraciones**: `python manage.py migrate` (servicio `migrate`). Deben ser compatibles con la versión anterior (guía 02, 2.8).

## Variables (`/srv/apps/controlpagos/.env`)

| Variable | Para qué | Quién la genera |
|---|---|---|
| `DATABASE_URL` | Conexión a Postgres | admin (`vps-new-db`) |
| `SECRET_KEY` | Firma de la cookie de sesión. Sin ella la app no arranca | admin (`openssl rand -base64 48`) |
| `SESSION_COOKIE_SECURE` | `true`: la cookie solo viaja por HTTPS | fijo |

## Administración (dentro del contenedor activo; el color lo muestra `vps-status`)

```bash
docker exec -it controlpagos-<color>-app-1 python manage.py createsuperuser
docker exec -it controlpagos-<color>-app-1 python manage.py changepassword <usuario>
docker exec controlpagos-<color>-app-1 python manage.py listusers
docker exec controlpagos-<color>-app-1 python manage.py dumpdata > respaldo.json
# Carga inicial desde tu PC (Git Bash), sin copiar el archivo al servidor:
ssh <usuario>@<vps> "docker exec -i controlpagos-<color>-app-1 python manage.py loaddata - --dry-run" < bd.json
ssh <usuario>@<vps> "docker exec -i controlpagos-<color>-app-1 python manage.py loaddata -" < bd.json
```

En PowerShell (no tiene `<`): `Get-Content bd.json -Raw -Encoding utf8 | ssh <usuario>@<vps> "docker exec -i controlpagos-<color>-app-1 python manage.py loaddata -"`.

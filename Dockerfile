# Adaptado de infra-vps-tecnomovil/plantillas/Dockerfile (fila Python de guia/02, 2.4).

# --- Etapa 1: instala dependencias ---
FROM python:3.12-slim AS build
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# --- Etapa 2: solo lo necesario para ejecutar ---
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY --from=build /install /usr/local
COPY controlpagos ./controlpagos
COPY migrations ./migrations
COPY wsgi.py manage.py ./
# FIJO: el VPS ejecuta como 10001; la app solo escribe en /tmp
USER 10001:10001
# FIJO: la app escucha en 0.0.0.0:8000 dentro del contenedor
EXPOSE 8000
CMD ["gunicorn", "--workers", "2", "--bind", "0.0.0.0:8000", "--access-logfile", "-", "--graceful-timeout", "15", "--no-control-socket", "wsgi:app"]

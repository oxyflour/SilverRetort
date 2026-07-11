FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN pip install --no-cache-dir uv

WORKDIR /app

COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-dev

COPY . .

ENV WATCH_STDIN=0 \
    LISTEN_HOST=0.0.0.0 \
    LISTEN_PORT=23002 \
    MCP_URL=http://host.docker.internal:23001/mcp/ \
    HERMES_WORKSPACES_DIR=/var/lib/silverretort/workspaces

RUN mkdir -p /var/lib/silverretort/workspaces
VOLUME ["/var/lib/silverretort/workspaces"]

EXPOSE 23002

CMD ["uv", "run", "--frozen", "--no-dev", "--project", ".", "python", "main.py"]

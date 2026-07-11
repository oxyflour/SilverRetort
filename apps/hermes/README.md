# silverretort-hermes

`apps/hermes` packages `hermes gateway` for SilverRetort:

- exposes an OpenAI-compatible API for `apps/uvicorn`
- injects the `silverretort-ui` MCP toolset into Hermes
- optionally fronts remote deployments with a relay/bridge layer

## Modes

- Local process: spawned by `apps/desktop`; exits when stdin closes
- Local Docker: container talks directly to `host.docker.internal` for `/mcp/`
- Remote Docker: container enables relay; local uvicorn dials back into `/bridge`
- Desktop-managed Docker: desktop uses `docker run` against the current `DOCKER_HOST`, but runtime semantics are still the same as Remote Docker

## Environment

- `LISTEN_HOST`: public bind host; defaults to `127.0.0.1`, Docker defaults it to `0.0.0.0`
- `LISTEN_PORT`: public API port; defaults to `23002`
- `HERMES_API_KEY`: public Bearer token; relay `/bridge` reuses the same token
- `MCP_URL`: direct MCP server URL, for example `http://127.0.0.1:23001/mcp/`
- `HERMES_ENV_FILE`: optional shared env file; defaults to `apps/desktop/.env` when present
- `HERMES_RELAY_ENABLED=1`: enable relay mode; public port becomes the relay and the internal gateway moves to `HERMES_GATEWAY_PORT`
- `HERMES_GATEWAY_HOST` / `HERMES_GATEWAY_PORT`: internal gateway bind target in relay mode; default host is `127.0.0.1`, default port is `LISTEN_PORT + 1`
- `OPENAI_*`: model configuration can be passed directly in env or via `HERMES_ENV_FILE`
- `HERMES_WORKSPACES_DIR`: persistent root for workspace directories. Docker defaults to `/var/lib/silverretort/workspaces`.

## Workspace API

Relay mode exposes authenticated `/workspace-api` endpoints for capability discovery,
idempotent workspace lifecycle, and streaming file transfer. Chat requests may include
`workspace_id`; the relay resolves it to a server-owned directory and adds that location
to Hermes instructions. Hermes Agent 0.14 does not expose a request-level cwd sandbox
hook, so capability currently reports `cwdEnforced: false`.

Workspace storage is the sole source of truth for files. Attachments are
identified by `workspaceId + relativePath`; SilverRetort no longer maintains a
separate file database or file IDs. Existing legacy `DATA_DIR/files` content is
discarded during migration and is not copied into workspaces.

Iframe artifacts reference a static-site entry inside the workspace, for
example `{"path":"artifacts/demo/index.html"}`. Inline HTML and external iframe
URLs are not supported. Relative CSS, JavaScript, image, and font assets are
served from the entry file's directory. Local-process mode lets uvicorn read
the shared directory directly; Docker and remote modes stream through relay.

## Desktop-Managed Docker

If desktop should start the container for you, put these fields in `DATA_DIR/settings.json`:

```json
{
  "hermesDockerImage": "silverretort-hermes"
}
```

Optional fields:

- `hermesApiKey`
- `hermesDockerUser` (defaults to the desktop OS username)
- `hermesDockerHost` (a hostname or IP address reachable from the desktop)
- `hermesDockerContainerPrefix` (defaults to `silverretort-hermes`)
- `hermesDockerContainerPort`

Behavior:

- desktop treats this as a remote Hermes service, not a special local mode
- desktop derives a stable, user-scoped container name from `hermesDockerUser`
- Docker publishes `hermesDockerContainerPort` on an ephemeral host port, so users do not contend for one fixed port
- desktop discovers the published port and passes the resulting URL to local uvicorn
- desktop starts the container with `HERMES_RELAY_ENABLED=1`
- if `hermesApiKey` is omitted here, desktop generates a random per-launch key and passes the same key to both the container and uvicorn
- `hermesUrl` is ignored in desktop-managed Docker mode; it is reserved for externally managed remote Hermes
- `hermesDockerContainerName` is no longer supported; use `hermesDockerContainerPrefix`
- stale containers are removed only when their SilverRetort ownership label matches the current user

For a shared remote Docker daemon:

- if `hermesDockerHost` is omitted, desktop derives the host from `DOCKER_HOST` or the active Docker context
- local `npipe` and `unix` endpoints resolve to `127.0.0.1`; `ssh` and `tcp` endpoints use their hostname
- set `hermesDockerHost` explicitly when the Docker endpoint hostname is not reachable from the desktop
- users with the same OS username on different machines must set distinct `hermesDockerUser` values

Example:

```json
{
  "hermesDockerImage": "silverretort-hermes",
  "hermesDockerHost": "my-box",
  "hermesDockerUser": "alice"
}
```

Published ports bind to all Docker host interfaces by default. Restrict access with the host firewall; Hermes API authentication remains enabled.

## Local Docker

Build:

```bash
cd apps/hermes
docker build -t silverretort-hermes .
```

Run:

```bash
docker run --rm -p 23002:23002 \
  -e HERMES_API_KEY=replace-with-32-plus-chars \
  -e OPENAI_API_KEY=replace-with-your-key \
  -e OPENAI_BASE_URL=https://openrouter.ai/api/v1 \
  -e OPENAI_MODEL_ID=deepseek/deepseek-chat-v3-0324 \
  silverretort-hermes
```

Image defaults:

- `WATCH_STDIN=0`
- `LISTEN_HOST=0.0.0.0`
- `LISTEN_PORT=23002`
- `MCP_URL=http://host.docker.internal:23001/mcp/`

Desktop settings stay unchanged:

```json
{
  "hermesUrl": "http://127.0.0.1:23002",
  "hermesApiKey": "replace-with-32-plus-chars"
}
```

If you prefer a mounted env file:

```bash
docker run --rm -p 23002:23002 \
  -e HERMES_API_KEY=replace-with-32-plus-chars \
  -e HERMES_ENV_FILE=/run/config/hermes.env \
  -v /abs/path/to/hermes.env:/run/config/hermes.env:ro \
  silverretort-hermes
```

## Remote Docker With Bridge

Enable relay mode in the container:

```bash
docker run --rm -p 23002:23002 \
  -e HERMES_API_KEY=replace-with-32-plus-chars \
  -e HERMES_RELAY_ENABLED=1 \
  -e OPENAI_API_KEY=replace-with-your-key \
  silverretort-hermes
```

In relay mode:

- public `http://<host>:23002` is served by the relay
- `/v1/*`, `/health`, and `/v1/models` are proxied to the internal gateway
- Hermes resolves MCP via `http://127.0.0.1:<LISTEN_PORT>/mcp/`
- local uvicorn auto-derives `<HERMES_URL>/bridge` unless `HERMES_BRIDGE_URL` is set explicitly

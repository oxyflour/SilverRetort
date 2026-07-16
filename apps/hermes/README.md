# silverretort-hermes

`apps/hermes` packages `hermes gateway` for SilverRetort:

- exposes an OpenAI-compatible API for `apps/uvicorn`
- injects the `silverretort-ui` MCP toolset into Hermes
- optionally fronts remote deployments with a relay/bridge layer

## Modes

- Local process: spawned by `apps/desktop`; exits when stdin closes
- Packaged binary: built with PyInstaller and bundled into desktop resources; runs with the same local-process environment
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
served from the entry file's directory. Put those resources in the same
directory as the entry HTML or in child directories, and reference them with
relative URLs such as `./style.css` or `./assets/app.js`; files in parent
directories are not valid artifact assets. Local-process mode lets uvicorn read
the shared directory directly; Docker and remote modes stream through relay.

Interactive iframe artifacts can save JSON context for the user's next chat
turn. Load the host bridge and call it when meaningful state changes:

```html
<button id="submit-selection">Submit</button>
<script src="/artifact-bridge-v1.js"></script>
<script>
  document.querySelector("#submit-selection").addEventListener("click", async () => {
    await window.silverRetort.setContext(
      "confirm-selection",
      { selectedIds: ["a", "b"] },
      { displayText: "Selected two items" },
    );
  });
</script>
```

The host saves only the latest context revision and does not start an agent
run. The context is attached when the user next sends a normal chat message.
Context is JSON-only and limited to 64 KiB. Complex interfaces should debounce
rapid state changes. `submit()` remains as a compatibility alias for
`setContext()` and has the same deferred behavior.

## User-Scoped Docker Switch

Desktop no longer manages Docker containers. Run `apps/switch` next to the
Docker daemon and configure desktop with the user-scoped switch URL:

```json
{
  "switchUrl": "https://switch.example/endpoint/$USERNAME",
  "hermesApiKey": "same-value-as-config/alice.json"
}
```

The switch reads `config/alice.json`, creates or recovers `hermes-alice`, waits for its
health endpoint, and proxies HTTP and `/bridge` WebSocket traffic. See
`apps/switch/README.md` for configuration and single-executable packaging.

## Packaged Binary

Build the desktop-managed Hermes binary with:

```bash
pnpm --filter silverretort-hermes run build
```

The desktop build script runs this automatically and bundles `apps/hermes/dist` into Electron resources. If the bundled executable is present, packaged desktop starts Hermes locally just like development mode; `switchUrl` remains available as an optional remote/switch configuration.

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

Direct raw Hermes URLs do not provide the relay bridge used by SilverRetort MCP tools; use `apps/switch` for desktop remote mode.

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

### Forward local MCP servers

Remote relay mode can also expose explicitly configured local HTTP MCP servers
through the bridge. Add them to desktop `DATA_DIR/settings.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "url": "http://127.0.0.1:9901/mcp/",
      "headers": {
        "Authorization": "Bearer local-token"
      }
    }
  }
}
```

Only loopback `http://127.0.0.1`, `http://localhost`, or `http://[::1]`
servers are forwarded. The relay writes these names into remote Hermes
`mcp_servers` as `http://127.0.0.1:<LISTEN_PORT>/mcp/<name>/` and tunnels the
HTTP MCP traffic back to the configured local URL.

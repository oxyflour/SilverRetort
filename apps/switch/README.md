# silverretort-switch

Zero-runtime-dependency HTTP and WebSocket switch for user-scoped Hermes
containers. Requests under `/endpoint/{userId}` are routed to a container named
`hermes-{userId}`.

## Run

```bash
pnpm --filter silverretort-switch dev
```

The switch reads `config/{userId}.json` from `SWITCH_CONFIG_DIR` (default:
`config`). Each file must contain `hermesApiKey`, and can override container
startup parameters, environment variables, and mounted volumes:

```json
{
  "hermesApiKey": "replace-with-a-long-random-key",
  "image": "silverretort-hermes",
  "containerPort": 23002,
  "env": {
    "OPENAI_API_KEY": "replace-with-your-key",
    "OPENAI_BASE_URL": "https://example.com/v1",
    "OPENAI_MODEL_ID": "model-name"
  },
  "volumes": [
    "alice-cache:/cache",
    { "source": "/host/read-only", "target": "/mnt/read-only", "readOnly": true }
  ],
  "args": []
}
```

Desktop configuration points at the user-scoped base URL and uses the same key:

```json
{
  "switchUrl": "https://switch.example/endpoint/$USERNAME",
  "hermesApiKey": "replace-with-a-long-random-key"
}
```

Open `/status/{userId}` in a browser to view a simple HTML status page for the
user container. The switch creates missing containers from the configured image,
enables the Hermes relay, dynamically publishes the configured container port,
and persists workspace and Hermes home in named Docker volumes. Existing stopped
containers are started; unhealthy running containers are restarted. Containers
with no traffic for more than 60 minutes are stopped by the idle sweeper.

Configuration:

- `SWITCH_HOST` / `SWITCH_PORT`: listener, default `0.0.0.0:23004`
- `SWITCH_CONFIG_DIR`: JSON config directory, default `config`
- `HERMES_DOCKER_IMAGE`: default `silverretort-hermes`
- `HERMES_CONTAINER_PORT`: default `23002`
- `HERMES_DOCKER_HOST`: address used to reach Docker-published ports
- `DOCKER_COMMAND`: Docker CLI path
- `SWITCH_DOCKER_TIMEOUT_MS`: default `30000`
- `SWITCH_HEALTH_TIMEOUT_MS`: default `2000`
- `SWITCH_RECOVERY_TIMEOUT_MS`: default `60000`
- `SWITCH_HEALTH_INTERVAL_MS`: default `500`
- `SWITCH_IDLE_STOP_MS`: default `3600000`
- `SWITCH_IDLE_SWEEP_MS`: default `60000`

Terminate TLS in front of the switch when it is reachable over a network.

## Single executable

Node.js 25.5 or newer can build a platform-specific single executable:

```bash
pnpm --filter silverretort-switch build
```

The output is written to `apps/switch/dist`. Build separately on each target
platform and sign Windows/macOS binaries as part of release packaging.

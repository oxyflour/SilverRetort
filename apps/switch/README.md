# silverretort-switch

Zero-runtime-dependency HTTP and WebSocket switch for user-scoped Hermes
containers. Requests under `/endpoint/{userId}` are routed to a container named
`hermes-{userId}`.

## Run

```bash
pnpm --filter silverretort-switch dev
```

The switch reads `{userId}.conf` from `SWITCH_CONFIG_DIR`. Each file uses Docker
`--env-file` syntax and must contain `HERMES_API_KEY`:

```dotenv
HERMES_API_KEY=replace-with-a-long-random-key
OPENAI_API_KEY=replace-with-your-key
OPENAI_BASE_URL=https://example.com/v1
OPENAI_MODEL_ID=model-name
```

Desktop configuration points at the user-scoped base URL and uses the same key:

```json
{
  "hermesUrl": "https://switch.example/endpoint/alice",
  "hermesApiKey": "replace-with-a-long-random-key"
}
```

The switch creates missing containers from `HERMES_DOCKER_IMAGE`, enables the
Hermes relay, dynamically publishes `HERMES_CONTAINER_PORT`, and persists the
workspace and Hermes home in named Docker volumes. Existing stopped containers
are started; unhealthy running containers are restarted.

Configuration:

- `SWITCH_HOST` / `SWITCH_PORT`: listener, default `0.0.0.0:8080`
- `SWITCH_CONFIG_DIR`: `.conf` directory, default current directory
- `HERMES_DOCKER_IMAGE`: default `silverretort-hermes`
- `HERMES_CONTAINER_PORT`: default `23002`
- `HERMES_DOCKER_HOST`: address used to reach Docker-published ports
- `DOCKER_COMMAND`: Docker CLI path
- `SWITCH_DOCKER_TIMEOUT_MS`: default `30000`
- `SWITCH_HEALTH_TIMEOUT_MS`: default `2000`
- `SWITCH_RECOVERY_TIMEOUT_MS`: default `60000`
- `SWITCH_HEALTH_INTERVAL_MS`: default `500`

Terminate TLS in front of the switch when it is reachable over a network.

## Single executable

Node.js 25.5 or newer can build a platform-specific single executable:

```bash
pnpm --filter silverretort-switch build
```

The output is written to `apps/switch/dist`. Build separately on each target
platform and sign Windows/macOS binaries as part of release packaging.

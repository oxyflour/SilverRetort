// @ts-check
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { spawn: nodeSpawn } = require("node:child_process");
const { ensureDir, joinUrl, normalizeBaseUrl } = require("./desktop-config.cjs");

function randomApiKey() {
    return crypto.randomBytes(32).toString("hex");
}

function defaultSwitchHermesUrl(username = os.userInfo().username, switchBaseUrl = "http://localhost:8080") {
    return joinUrl(switchBaseUrl, `endpoint/${encodeURIComponent(username)}`);
}

function resolveHermesRuntime(config) {
    if (!config.isPackaged) {
        return {
            command: "uv",
            args: ["run", "--project", ".", "python", "main.py"],
            cwd: path.join(config.serviceRoot, "hermes"),
        };
    }
    return null;
}

function resolveHermesMode(
    config,
    pythonPort,
    hermesPort,
    randomApiKeyFn = randomApiKey,
) {
    const hermesApiKey = `${config.settings.hermesApiKey || ""}`.trim();
    const removedDockerKeys = Object.keys(config.settings).filter((key) => key.startsWith("hermesDocker"));
    if (removedDockerKeys.length) {
        throw new Error(
            `${removedDockerKeys.join(", ")} are no longer supported; configure hermesUrl instead`,
        );
    }

    const hermesUrl = normalizeBaseUrl(config.settings.hermesUrl);
    if (hermesUrl) {
        if (!hermesApiKey) {
            throw new Error("DATA_DIR/settings.json has hermesUrl but missing hermesApiKey");
        }
        return {
            mode: "remote",
            url: hermesUrl,
            apiKey: hermesApiKey,
            healthUrl: joinUrl(hermesUrl, "health"),
        };
    }

    const runtime = resolveHermesRuntime(config);
    if (runtime === null) {
        return { mode: "needs-switch-config", url: defaultSwitchHermesUrl() };
    }
    const apiKey = randomApiKeyFn();
    const url = `http://127.0.0.1:${hermesPort}`;
    const workspacesDir = ensureDir(path.join(config.dataDir, "hermes-workspaces"));
    return {
        mode: "local",
        url,
        apiKey,
        healthUrl: `${url}/health`,
        runtime,
        workspacesDir,
        env: {
            LISTEN_PORT: `${hermesPort}`,
            HERMES_API_KEY: apiKey,
            MCP_URL: `http://127.0.0.1:${pythonPort}/mcp/`,
            HERMES_HOME: ensureDir(path.join(config.dataDir, "hermes-home")),
            HERMES_ENV_FILE: config.envPath,
            HERMES_RELAY_ENABLED: "1",
            HERMES_WORKSPACES_DIR: workspacesDir,
        },
    };
}

async function startHermes(mode, config, supervisor, spawn = nodeSpawn) {
    if (mode.mode === "local") {
        const proc = spawn(mode.runtime.command, mode.runtime.args, {
            cwd: mode.runtime.cwd,
            env: config.buildChildEnv(mode.env),
            stdio: "pipe",
        });
        supervisor.monitor("hermes", proc);
        return mode;
    }
    return mode;
}

module.exports = {
    defaultSwitchHermesUrl,
    randomApiKey,
    resolveHermesRuntime,
    resolveHermesMode,
    startHermes,
};

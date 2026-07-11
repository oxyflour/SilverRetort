// @ts-check
const crypto = require("node:crypto");
const path = require("node:path");
const { spawn: nodeSpawn } = require("node:child_process");
const { ensureDir, joinUrl, normalizeBaseUrl } = require("./desktop-config.cjs");
const {
    MANAGED_LABEL,
    OWNER_LABEL,
    normalizeDockerHost,
    resolveDockerIdentity,
    startManagedDocker,
} = require("./docker-runtime.cjs");

const DEFAULT_HERMES_CONTAINER_PORT = 23002;

function randomApiKey() {
    return crypto.randomBytes(32).toString("hex");
}

function hashSuffix(input) {
    return crypto.createHash("sha256").update(input).digest("hex").slice(0, 12);
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

function resolveHermesDockerConfig(
    config,
    hermesApiKey,
    randomApiKeyFn = randomApiKey,
    getUsername,
) {
    const { settings } = config;
    const image = `${settings.hermesDockerImage || ""}`.trim();
    if (!image) {
        return null;
    }
    if (`${settings.hermesUrl || ""}`.trim()) {
        console.warn("[main] hermesUrl is ignored in desktop-managed Docker mode");
    }
    const identity = resolveDockerIdentity(settings, hashSuffix, getUsername);
    const effectiveApiKey = hermesApiKey || randomApiKeyFn();
    const containerPort = Number(settings.hermesDockerContainerPort || DEFAULT_HERMES_CONTAINER_PORT);
    if (!Number.isInteger(containerPort) || containerPort <= 0 || containerPort > 65535) {
        throw new Error(`invalid hermesDockerContainerPort: ${settings.hermesDockerContainerPort}`);
    }
    const configuredHost = Object.prototype.hasOwnProperty.call(settings, "hermesDockerHost")
        ? normalizeDockerHost(settings.hermesDockerHost)
        : null;
    const args = [
        "run", "--rm", "-d", "--name", identity.containerName,
        "--label", `${MANAGED_LABEL}=true`,
        "--label", `${OWNER_LABEL}=${identity.ownerHash}`,
        "-p", `${containerPort}`,
        "-e", "WATCH_STDIN=0",
        "-e", "LISTEN_HOST=0.0.0.0",
        "-e", `LISTEN_PORT=${containerPort}`,
        "-e", `HERMES_API_KEY=${effectiveApiKey}`,
        "-e", "HERMES_RELAY_ENABLED=1",
        "-e", "HERMES_WORKSPACES_DIR=/var/lib/silverretort/workspaces",
        "-v", `${identity.containerName}-workspaces:/var/lib/silverretort/workspaces`,
    ];
    for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "OPENAI_MODEL_ID"]) {
        const value = `${config.desktopEnv[key] || config.processEnv[key] || ""}`.trim();
        if (value) {
            args.push("-e", `${key}=${value}`);
        }
    }
    args.push(image);
    return {
        ...identity,
        image,
        apiKey: effectiveApiKey,
        configuredHost,
        containerPort,
        command: "docker",
        runArgs: args,
    };
}

function resolveHermesMode(
    config,
    pythonPort,
    hermesPort,
    randomApiKeyFn = randomApiKey,
    getUsername,
) {
    const hermesApiKey = `${config.settings.hermesApiKey || ""}`.trim();
    const docker = resolveHermesDockerConfig(config, hermesApiKey, randomApiKeyFn, getUsername);
    if (docker) {
        return { mode: "docker", apiKey: docker.apiKey, docker };
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
        console.warn("[main] packaged local hermes is not bundled yet; falling back to mock engine");
        return { mode: "disabled" };
    }
    const apiKey = randomApiKeyFn();
    const url = `http://127.0.0.1:${hermesPort}`;
    return {
        mode: "local",
        url,
        apiKey,
        healthUrl: `${url}/health`,
        runtime,
        env: {
            LISTEN_PORT: `${hermesPort}`,
            HERMES_API_KEY: apiKey,
            MCP_URL: `http://127.0.0.1:${pythonPort}/mcp/`,
            HERMES_HOME: ensureDir(path.join(config.dataDir, "hermes-home")),
            HERMES_ENV_FILE: config.envPath,
            HERMES_RELAY_ENABLED: "1",
            HERMES_WORKSPACES_DIR: ensureDir(path.join(config.dataDir, "hermes-workspaces")),
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
    if (mode.mode === "docker") {
        const runtime = await startManagedDocker(mode.docker, config, supervisor, spawn);
        return {
            ...mode,
            url: runtime.url,
            healthUrl: joinUrl(runtime.url, "health"),
            docker: { ...mode.docker, ...runtime },
        };
    }
    return mode;
}

module.exports = {
    hashSuffix,
    randomApiKey,
    resolveHermesDockerConfig,
    resolveHermesMode,
    startHermes,
};

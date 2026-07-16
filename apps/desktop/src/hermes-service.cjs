// @ts-check
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { existsSync } = require("node:fs");
const { spawn: nodeSpawn } = require("node:child_process");
const { ensureDir, joinUrl, normalizeBaseUrl } = require("./desktop-config.cjs");

function randomApiKey() {
    return crypto.randomBytes(32).toString("hex");
}


function expandSwitchUrl(url, username = os.userInfo().username) {
    return `${url || ""}`.replace(/\$USERNAME/gu, encodeURIComponent(username));
}

function defaultSwitchHermesUrl(username = os.userInfo().username, switchBaseUrl = "http://localhost:23004") {
    return joinUrl(switchBaseUrl, `endpoint/${encodeURIComponent(username)}`);
}

function resolvePackagedHermesRuntime(config) {
    const executable = path.join(
        config.serviceRoot,
        "hermes",
        "silverretort-hermes",
        process.platform === "win32" ? "silverretort-hermes.exe" : "silverretort-hermes",
    );
    if (!existsSync(executable)) {
        return null;
    }
    return { command: executable, args: [], cwd: path.dirname(executable) };
}

function resolveHermesRuntime(config) {
    if (!config.isPackaged) {
        return {
            command: "uv",
            args: ["run", "--project", ".", "python", "main.py"],
            cwd: path.join(config.serviceRoot, "hermes"),
        };
    }
    return resolvePackagedHermesRuntime(config);
}

function localHermesEnabled(config) {
    if (!config.isPackaged) return true;
    const env = config.buildChildEnv ? config.buildChildEnv() : { ...config.processEnv, ...config.desktopEnv };
    return Boolean(`${env.ENABLE_LOCAL_HERMES || ""}`.trim());
}

function resolveHermesMode(
    config,
    pythonPort,
    hermesPort,
    randomApiKeyFn = randomApiKey,
    username,
) {
    const hermesApiKey = `${config.settings.hermesApiKey || ""}`.trim();
    const removedDockerKeys = Object.keys(config.settings).filter((key) => key.startsWith("hermesDocker"));
    if (removedDockerKeys.length) {
        throw new Error(
            `${removedDockerKeys.join(", ")} are no longer supported; configure switchUrl instead`,
        );
    }

    const switchUrl = normalizeBaseUrl(expandSwitchUrl(config.settings.switchUrl, username));
    if (switchUrl) {
        if (!hermesApiKey) {
            throw new Error("DATA_DIR/settings.json has switchUrl but missing hermesApiKey");
        }
        return {
            mode: "remote",
            url: switchUrl,
            apiKey: hermesApiKey,
            healthUrl: joinUrl(switchUrl, "health"),
        };
    }

    if (!localHermesEnabled(config)) {
        return { mode: "needs-switch-config", url: defaultSwitchHermesUrl() };
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
    expandSwitchUrl,
    randomApiKey,
    resolveHermesRuntime,
    resolvePackagedHermesRuntime,
    localHermesEnabled,
    resolveHermesMode,
    startHermes,
};

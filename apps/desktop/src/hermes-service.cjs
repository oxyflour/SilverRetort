// @ts-check
const crypto = require("node:crypto");
const path = require("node:path");
const { spawn: nodeSpawn } = require("node:child_process");
const { ensureDir, joinUrl, normalizeBaseUrl } = require("./desktop-config.cjs");

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

function resolveHermesDockerConfig(config, hermesUrl, hermesApiKey, randomApiKeyFn = randomApiKey) {
    const { settings } = config;
    const image = `${settings.hermesDockerImage || ""}`.trim();
    if (!image) {
        return null;
    }
    if (!hermesUrl) {
        throw new Error("DATA_DIR/settings.json has hermesDockerImage but missing hermesUrl");
    }

    const effectiveApiKey = hermesApiKey || randomApiKeyFn();
    const parsed = new URL(`${hermesUrl}/`);
    const publicPort = parsed.port
        ? Number(parsed.port)
        : parsed.protocol === "https:"
            ? 443
            : 80;
    if (!Number.isInteger(publicPort) || publicPort <= 0) {
        throw new Error(`invalid hermesUrl port: ${hermesUrl}`);
    }

    const containerPort = Number(settings.hermesDockerContainerPort || DEFAULT_HERMES_CONTAINER_PORT);
    if (!Number.isInteger(containerPort) || containerPort <= 0) {
        throw new Error(`invalid hermesDockerContainerPort: ${settings.hermesDockerContainerPort}`);
    }
    const containerName = `${settings.hermesDockerContainerName || `silverretort-hermes-${hashSuffix(hermesUrl)}`}`.trim();
    if (!containerName) {
        throw new Error("hermesDockerContainerName must not be empty");
    }

    const args = [
        "run", "--rm", "-d", "--name", containerName,
        "-p", `${publicPort}:${containerPort}`,
        "-e", "WATCH_STDIN=0",
        "-e", "LISTEN_HOST=0.0.0.0",
        "-e", `LISTEN_PORT=${containerPort}`,
        "-e", `HERMES_API_KEY=${effectiveApiKey}`,
        "-e", "HERMES_RELAY_ENABLED=1",
    ];
    for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "OPENAI_MODEL_ID"]) {
        const value = `${config.desktopEnv[key] || config.processEnv[key] || ""}`.trim();
        if (value) {
            args.push("-e", `${key}=${value}`);
        }
    }
    args.push(image);
    return {
        image,
        apiKey: effectiveApiKey,
        containerName,
        publicPort,
        containerPort,
        command: "docker",
        runArgs: args,
        removeArgs: ["rm", "-f", containerName],
        logsArgs: ["logs", "-f", containerName],
        waitArgs: ["wait", containerName],
    };
}

function resolveHermesMode(config, pythonPort, hermesPort, randomApiKeyFn = randomApiKey) {
    const hermesUrl = normalizeBaseUrl(config.settings.hermesUrl);
    const hermesApiKey = `${config.settings.hermesApiKey || ""}`.trim();
    const docker = resolveHermesDockerConfig(config, hermesUrl, hermesApiKey, randomApiKeyFn);
    if (docker) {
        return {
            mode: "docker",
            url: hermesUrl,
            apiKey: docker.apiKey,
            healthUrl: joinUrl(hermesUrl, "health"),
            docker,
        };
    }
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
        },
    };
}

function waitForExit(proc) {
    return new Promise((resolve, reject) => {
        proc.once("error", reject);
        proc.once("exit", (code, signal) => resolve({ code, signal }));
    });
}

async function startHermesDocker(mode, config, supervisor, spawn) {
    const docker = mode.docker;
    const spawnDocker = (args) => spawn(docker.command, args, {
        cwd: config.serviceRoot,
        env: config.buildChildEnv(),
        stdio: "pipe",
    });

    const removeExisting = spawnDocker(docker.removeArgs);
    supervisor.monitor("hermes-docker-rm", removeExisting, { critical: false });
    await waitForExit(removeExisting);

    const run = spawnDocker(docker.runArgs);
    let stdout = "";
    let stderr = "";
    run.stdout?.on("data", (data) => { stdout += `${data}`; });
    run.stderr?.on("data", (data) => { stderr += `${data}`; });
    supervisor.monitor("hermes-docker", run, { critical: false });
    const { code } = await waitForExit(run);
    if (code !== 0) {
        throw new Error(`docker run failed (${code}): ${(stderr || stdout).trim() || "unknown error"}`);
    }

    supervisor.addCleanup(async () => {
        const stop = spawnDocker(docker.removeArgs);
        supervisor.monitor("hermes-docker-stop", stop, { critical: false });
        await waitForExit(stop);
    });
    const logsProc = spawnDocker(docker.logsArgs);
    supervisor.monitor("hermes-docker-logs", logsProc, { critical: false });
    const waitProc = spawnDocker(docker.waitArgs);
    supervisor.monitor(`hermes docker container ${docker.containerName}`, waitProc);
    return { logsProc, waitProc };
}

async function startHermes(mode, config, supervisor, spawn = nodeSpawn) {
    if (mode.mode === "local") {
        const proc = spawn(mode.runtime.command, mode.runtime.args, {
            cwd: mode.runtime.cwd,
            env: config.buildChildEnv(mode.env),
            stdio: "pipe",
        });
        supervisor.monitor("hermes", proc);
        return proc;
    }
    if (mode.mode === "docker") {
        return startHermesDocker(mode, config, supervisor, spawn);
    }
    return null;
}

module.exports = {
    hashSuffix,
    randomApiKey,
    resolveHermesDockerConfig,
    resolveHermesMode,
    startHermes,
};

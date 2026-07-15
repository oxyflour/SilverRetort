// @ts-check
const path = require("node:path");
const { existsSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { resolveHermesMode, startHermes } = require("./hermes-service.cjs");
const { toWebSocketUrl } = require("./desktop-config.cjs");

const DEFAULT_NEXT_PORT = 23000;
const DEFAULT_PYTHON_PORT = 23001;
const DEFAULT_HERMES_PORT = 23002;

async function assertUrl(url, options = {}, retry = 30, retryDelayMs = 1000) {
    while (retry-- > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        try {
            const response = await fetch(url, options);
            const text = await response.text();
            if (response.status === 200) {
                return text;
            }
            throw new Error(`${response.status}: ${text}`);
        } catch {
            console.warn(`[main] waiting for url ${url} (${retry} retries left)`);
        }
    }
    throw new Error(`failed to request ${url}`);
}

async function waitForHttpResponse(url, options = {}, retry = 30, retryDelayMs = 1000) {
    while (retry-- > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        try {
            const response = await fetch(url, options);
            const text = await response.text();
            return response.status === 200 ? text : `${response.status}: ${text}`;
        } catch {
            console.warn(`[main] waiting for url ${url} (${retry} retries left)`);
        }
    }
    throw new Error(`failed to request ${url}`);
}

function resolveNextEntry(config) {
    const target = path.join(config.serviceRoot, "next", "node_modules", "next", "dist", "bin", "next");
    if (!existsSync(target)) {
        throw new Error(`missing next entrypoint: ${target}`);
    }
    return target;
}

function resolvePackagedFrontendDir(config) {
    const target = path.join(config.serviceRoot, "frontend");
    if (!existsSync(path.join(target, "index.html"))) {
        throw new Error(`missing packaged frontend: ${target}`);
    }
    return target;
}

function resolvePythonRuntime(config, pythonPort) {
    if (!config.isPackaged) {
        return {
            command: "uv",
            args: ["run", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", `${pythonPort}`],
            cwd: path.join(config.serviceRoot, "uvicorn"),
        };
    }
    const executable = path.join(
        config.serviceRoot,
        "uvicorn",
        "silverretort-uvicorn",
        process.platform === "win32" ? "silverretort-uvicorn.exe" : "silverretort-uvicorn",
    );
    if (!existsSync(executable)) {
        throw new Error(`missing packaged python executable: ${executable}`);
    }
    return { command: executable, args: [], cwd: path.dirname(executable) };
}

function startNextServer(config, utilityProcess, nextPort, pythonPort) {
    const command = resolveNextEntry(config);
    return utilityProcess.fork(command, ["dev", "-H", "127.0.0.1", "-p", `${nextPort}`], {
        cwd: path.join(config.serviceRoot, "next"),
        env: config.buildChildEnv({
            PORT: `${nextPort}`,
            HOSTNAME: "127.0.0.1",
            API_REWRITE: `http://127.0.0.1:${pythonPort}/`,
        }),
        stdio: "pipe",
    });
}

function buildUvicornEnv(config, hermesMode, pythonPort) {
    return config.buildChildEnv({
        LISTEN_PORT: `${pythonPort}`,
        DATA_DIR: config.dataDir,
        SILVERRETORT_DESKTOP_MODE: config.isPackaged ? "packaged" : "development",
        SILVERRETORT_HERMES_MODE: hermesMode.mode,
        ...(config.isPackaged ? { FRONTEND_DIST: resolvePackagedFrontendDir(config) } : {}),
        ...(hermesMode.mode === "disabled" ? {} : {
            HERMES_URL: hermesMode.url,
            HERMES_API_KEY: hermesMode.apiKey,
            ...(hermesMode.mode === "local" ? {
                LOCAL_HERMES_WORKSPACES_DIR: hermesMode.workspacesDir,
            } : {}),
            HERMES_BRIDGE_URL: toWebSocketUrl(hermesMode.url, "bridge"),
        }),
    });
}

/**
 * @param {{
 *   config: ReturnType<import("./desktop-config.cjs").loadDesktopConfig>,
 *   supervisor: ReturnType<import("./process-supervisor.cjs").createProcessSupervisor>,
 *   utilityProcess: typeof import("electron").utilityProcess,
 *   ports?: {next?: number, python?: number, hermes?: number},
 * }} options
 */
async function startServiceStack({ config, supervisor, utilityProcess, ports = {} }) {
    const nextPort = ports.next ?? DEFAULT_NEXT_PORT;
    const pythonPort = ports.python ?? DEFAULT_PYTHON_PORT;
    const hermesPort = ports.hermes ?? DEFAULT_HERMES_PORT;
    const hermesMode = resolveHermesMode(config, pythonPort, hermesPort);
    const pythonRuntime = resolvePythonRuntime(config, pythonPort);

    const uvicorn = spawn(pythonRuntime.command, pythonRuntime.args, {
        cwd: pythonRuntime.cwd,
        env: buildUvicornEnv(config, hermesMode, pythonPort),
        stdio: "pipe",
    });
    supervisor.monitor("uvicorn", uvicorn);

    if (hermesMode.mode === "local") {
        await startHermes(hermesMode, config, supervisor);
    }
    if (!config.isPackaged) {
        const nextjs = startNextServer(config, utilityProcess, nextPort, pythonPort);
        supervisor.monitor("nextjs", nextjs);
    }

    const webPort = config.isPackaged ? pythonPort : nextPort;
    const healthChecks = [
        assertUrl(`http://127.0.0.1:${pythonPort}/health`),
        assertUrl(`http://127.0.0.1:${webPort}/health`),
    ];
    if (hermesMode.mode !== "disabled") {
        const hermesHealthCheck = hermesMode.mode === "local" ? waitForHttpResponse : assertUrl;
        healthChecks.push(hermesHealthCheck(hermesMode.healthUrl, {
            headers: { Authorization: `Bearer ${hermesMode.apiKey}` },
        }));
    }
    const [apiHealth, nextHealth, hermesHealth] = await Promise.all(healthChecks);
    const hermesSummary = hermesMode.mode === "disabled"
        ? "hermes=mock"
        : `hermes=${hermesHealth}`;
    console.log(`[main] HEALTH: api=${apiHealth}; web=${nextHealth}; ${hermesSummary}; data=${config.dataDir}`);
    return `http://127.0.0.1:${webPort}`;
}

module.exports = {
    assertUrl,
    waitForHttpResponse,
    buildUvicornEnv,
    resolveNextEntry,
    resolvePackagedFrontendDir,
    resolvePythonRuntime,
    startServiceStack,
};

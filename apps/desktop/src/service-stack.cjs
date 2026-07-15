// @ts-check
const path = require("node:path");
const { existsSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { resolveHermesMode, startHermes } = require("./hermes-service.cjs");
const { toWebSocketUrl } = require("./desktop-config.cjs");

const DEFAULT_NEXT_PORT = 23000;
const DEFAULT_PYTHON_PORT = 23001;
const DEFAULT_HERMES_PORT = 23002;

async function assertUrl(url, options = {}, retry = 30) {
    while (retry-- > 0) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
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

function resolveNextEntry(config) {
    const target = config.isPackaged
        ? path.join(config.serviceRoot, "next", "apps", "next", "server.js")
        : path.join(config.serviceRoot, "next", "node_modules", "next", "dist", "bin", "next");
    if (!existsSync(target)) {
        throw new Error(`missing next entrypoint: ${target}`);
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
    const cwd = config.isPackaged
        ? path.join(config.serviceRoot, "next", "apps", "next")
        : path.join(config.serviceRoot, "next");
    const args = config.isPackaged
        ? []
        : ["dev", "-H", "127.0.0.1", "-p", `${nextPort}`];
    return utilityProcess.fork(command, args, {
        cwd,
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
    const nextjs = startNextServer(config, utilityProcess, nextPort, pythonPort);
    supervisor.monitor("nextjs", nextjs);

    const healthChecks = [
        assertUrl(`http://127.0.0.1:${pythonPort}/health`),
        assertUrl(`http://127.0.0.1:${nextPort}/health`),
    ];
    if (hermesMode.mode !== "disabled") {
        healthChecks.push(assertUrl(hermesMode.healthUrl, {
            headers: { Authorization: `Bearer ${hermesMode.apiKey}` },
        }));
    }
    const [apiHealth, nextHealth, hermesHealth] = await Promise.all(healthChecks);
    const hermesSummary = hermesMode.mode === "disabled"
        ? "hermes=mock"
        : `hermes=${hermesHealth}`;
    console.log(`[main] HEALTH: api=${apiHealth}; web=${nextHealth}; ${hermesSummary}; data=${config.dataDir}`);
    return `http://127.0.0.1:${nextPort}`;
}

module.exports = {
    assertUrl,
    buildUvicornEnv,
    resolveNextEntry,
    resolvePythonRuntime,
    startServiceStack,
};

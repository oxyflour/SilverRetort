// @ts-check
const crypto = require("node:crypto");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } = require("node:fs");
const { spawn: nodeSpawn } = require("node:child_process");

const MANAGED_MCP_VERSION = "0.1.0";
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/u;

function resolveMcpsRoot(config) {
    if (!config.serviceRoot) return "";
    return config.isPackaged
        ? path.join(config.serviceRoot, "mcps")
        : path.resolve(config.serviceRoot, "..", "mcps");
}

function normalizeCatalogEntry(raw, fallbackId) {
    const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const id = `${value.id || fallbackId}`.trim();
    if (!SERVER_NAME_RE.test(id)) return null;
    const serverName = `${value.serverName || id}`.trim();
    if (!SERVER_NAME_RE.test(serverName)) return null;
    const defaultConfig = value.defaultConfig && typeof value.defaultConfig === "object" && !Array.isArray(value.defaultConfig)
        ? value.defaultConfig
        : {};
    const defaultPort = Number.isInteger(value.defaultPort) ? value.defaultPort : 9901;
    return {
        id,
        serverName,
        name: `${value.name || id}`.trim(),
        description: `${value.description || ""}`.trim(),
        version: `${value.version || MANAGED_MCP_VERSION}`.trim(),
        defaultPort,
        defaultConfig,
        configFields: Array.isArray(value.configFields) ? value.configFields : [],
    };
}

function loadCatalog(config) {
    const root = resolveMcpsRoot(config);
    if (!existsSync(root)) return [];
    const entries = [];
    for (const name of readdirSync(root)) {
        const manifestPath = path.join(root, name, "manifest.json");
        if (!existsSync(manifestPath)) continue;
        try {
            const entry = normalizeCatalogEntry(readJsonObject(manifestPath), name);
            if (entry) entries.push(entry);
        } catch {
            continue;
        }
    }
    return entries.sort((left, right) => left.id.localeCompare(right.id));
}

function catalogEntry(catalog, id) {
    const entry = catalog.find((item) => item.id === id);
    if (!entry) throw new Error(`unknown managed MCP: ${id}`);
    return entry;
}

function readJsonObject(filePath) {
    if (!existsSync(filePath)) return {};
    const raw = readFileSync(filePath, "utf8").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function readSettings(config) {
    return readJsonObject(config.settingsPath);
}

function writeSettings(config, settings) {
    writeFileSync(config.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    config.settings = settings;
    return settings;
}

function managedSettings(settings) {
    const raw = settings.managedMcpServers;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function defaultServerConfig(entry) {
    return {
        serverName: entry.serverName,
        enabled: true,
        autoStart: true,
        running: false,
        installedVersion: "",
        port: entry.defaultPort,
        config: { ...entry.defaultConfig },
    };
}

function normalizeServerConfig(entry, raw) {
    const base = defaultServerConfig(entry);
    const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const config = value.config && typeof value.config === "object" && !Array.isArray(value.config)
        ? value.config
        : {};
    const serverName = `${value.serverName || entry.serverName}`.trim();
    return {
        serverName: SERVER_NAME_RE.test(serverName) ? serverName : entry.serverName,
        enabled: value.enabled !== false,
        autoStart: Boolean(value.autoStart),
        running: Boolean(value.running),
        installedVersion: `${value.installedVersion || ""}`.trim(),
        port: Number.isInteger(value.port) ? value.port : base.port,
        config: { ...base.config, ...config },
    };
}

function updateManagedConfig(config, catalog, id, updater) {
    const entry = catalogEntry(catalog, id);
    const settings = readSettings(config);
    const managed = { ...managedSettings(settings) };
    const current = normalizeServerConfig(entry, managed[id]);
    const next = updater(current, entry);
    if (next) {
        managed[id] = next;
    } else {
        delete managed[id];
    }
    if (Object.keys(managed).length) {
        settings.managedMcpServers = managed;
    } else {
        delete settings.managedMcpServers;
    }
    writeSettings(config, settings);
    return next;
}

function isInstalled(record) {
    return Boolean(`${record.installedVersion || ""}`.trim());
}

async function readBody(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (!chunks.length) return {};
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (!text) return {};
    return JSON.parse(text);
}

function sendJson(response, status, payload) {
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
    });
    response.end(JSON.stringify(payload));
}

async function isPortAvailable(port) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once("error", () => resolve(false));
        server.once("listening", () => server.close(() => resolve(true)));
        server.listen(port, "127.0.0.1");
    });
}

async function allocatePort(preferredPort) {
    const start = Number.isInteger(preferredPort) && preferredPort > 0 ? preferredPort : 9901;
    for (let port = start; port < start + 100; port += 1) {
        if (await isPortAvailable(port)) return port;
    }
    throw new Error(`no available port near ${start}`);
}

function resolveAdapterRuntime(config, id, port) {
    if (!config.isPackaged) {
        return {
            command: "uv",
            args: ["run", "--project", ".", "python", "main.py", "managed-mcp", id, "--port", `${port}`],
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
        throw new Error(`missing packaged managed MCP runtime: ${executable}`);
    }
    return { command: executable, args: ["managed-mcp", id, "--port", `${port}`], cwd: path.dirname(executable) };
}

async function waitForHealth(port) {
    const url = `http://127.0.0.1:${port}/health`;
    let lastError = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        try {
            const response = await fetch(url);
            if (response.ok) return true;
            lastError = `HTTP ${response.status}`;
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
    }
    throw new Error(`managed MCP health check failed: ${lastError}`);
}

async function waitForProcessExit(state) {
    if (!state || state.exited) return;
    await Promise.race([
        new Promise((resolve) => state.proc.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
}

function createManagedMcpService({ config, supervisor, spawn = nodeSpawn, logger = console }) {
    const processes = new Map();
    const catalog = loadCatalog(config);

    function appendLog(logPath, source, data) {
        try {
            appendFileSync(logPath, `[${new Date().toISOString()}] [${source}] ${data}`, "utf8");
        } catch {
            return;
        }
    }

    async function statusFor(id) {
        const entry = catalogEntry(catalog, id);
        const settings = readSettings(config);
        const record = normalizeServerConfig(entry, managedSettings(settings)[id]);
        const runtime = processes.get(id);
        return {
            id,
            serverName: record.serverName,
            name: entry.name,
            description: entry.description,
            version: entry.version,
            installedVersion: record.installedVersion,
            installed: isInstalled(record),
            enabled: record.enabled,
            autoStart: record.autoStart,
            running: Boolean(runtime && !runtime.exited),
            port: record.port,
            url: `http://127.0.0.1:${record.port}/mcp/`,
            config: record.config,
            configFields: entry.configFields,
            error: runtime?.error || "",
            startedAt: runtime?.startedAt || "",
            logPath: runtime?.logPath || path.join(config.dataDir, "logs", "managed-mcp", `${id}.log`),
        };
    }

    async function list() {
        return { servers: await Promise.all(catalog.map((entry) => statusFor(entry.id))) };
    }

    async function install(id, options = {}) {
        const entry = catalogEntry(catalog, id);
        const record = updateManagedConfig(config, catalog, id, (current) => ({
            ...current,
            enabled: true,
            autoStart: true,
            running: false,
            installedVersion: entry.version,
            port: current.port || entry.defaultPort,
            config: { ...entry.defaultConfig, ...current.config },
        }));
        mkdirSync(path.join(config.dataDir, "managed-mcp", id), { recursive: true });
        mkdirSync(path.join(config.dataDir, "logs", "managed-mcp"), { recursive: true });
        if (options.start !== false) await start(id);
        return statusFor(id);
    }

    async function start(id) {
        const entry = catalogEntry(catalog, id);
        let record = normalizeServerConfig(entry, managedSettings(readSettings(config))[id]);
        if (!isInstalled(record)) {
            throw new Error(`${id} is not installed`);
        }
        const existing = processes.get(id);
        if (existing && !existing.exited) return statusFor(id);

        const port = await allocatePort(record.port);
        if (port !== record.port) {
            record = updateManagedConfig(config, catalog, id, (current) => ({ ...current, port }));
        }
        const runtime = resolveAdapterRuntime(config, id, port);
        const logPath = path.join(config.dataDir, "logs", "managed-mcp", `${id}.log`);
        const child = spawn(runtime.command, runtime.args, {
            cwd: runtime.cwd,
            env: config.buildChildEnv({
                DATA_DIR: config.dataDir,
                SILVERRETORT_MCPS_ROOT: resolveMcpsRoot(config),
                SILVERRETORT_MANAGED_MCP_ID: id,
                SILVERRETORT_MANAGED_MCP_CONFIG: JSON.stringify(record.config),
            }),
            stdio: "pipe",
        });
        const state = {
            proc: child,
            exited: false,
            error: "",
            startedAt: new Date().toISOString(),
            logPath,
        };
        processes.set(id, state);
        child.stdout?.on("data", (data) => appendLog(logPath, "stdout", data));
        child.stderr?.on("data", (data) => appendLog(logPath, "stderr", data));
        child.once("exit", (code, signal) => {
            state.exited = true;
            state.error = code === 0 || signal ? "" : `exited with code ${code}`;
            updateManagedConfig(config, catalog, id, (current) => ({ ...current, running: false }));
        });
        supervisor.monitor(`managed-mcp:${id}`, child, { critical: false });
        await waitForHealth(port);
        record = updateManagedConfig(config, catalog, id, (current) => ({ ...current, running: true }));
        logger.log(`[managed-mcp] ${id} listening on ${port}`);
        return statusFor(id);
    }

    async function stop(id) {
        catalogEntry(catalog, id);
        const runtime = processes.get(id);
        if (runtime && !runtime.exited) {
            runtime.proc.kill();
            await waitForProcessExit(runtime);
        }
        processes.delete(id);
        updateManagedConfig(config, catalog, id, (current) => ({ ...current, running: false }));
        return statusFor(id);
    }

    async function patch(id, body = {}) {
        updateManagedConfig(config, catalog, id, (current, entry) => {
            const nextConfig = body.config && typeof body.config === "object" && !Array.isArray(body.config)
                ? { ...current.config, ...body.config }
                : current.config;
            return {
                ...current,
                enabled: body.enabled === undefined ? current.enabled : Boolean(body.enabled),
                autoStart: body.autoStart === undefined ? current.autoStart : Boolean(body.autoStart),
                config: { ...entry.defaultConfig, ...nextConfig },
            };
        });
        const status = await statusFor(id);
        if (!status.enabled) await stop(id);
        return statusFor(id);
    }

    async function uninstall(id) {
        await stop(id);
        updateManagedConfig(config, catalog, id, () => null);
        return statusFor(id);
    }

    async function startAuto() {
        for (const entry of catalog) {
            const record = normalizeServerConfig(entry, managedSettings(readSettings(config))[entry.id]);
            if (isInstalled(record) && record.enabled && record.autoStart) {
                try {
                    await start(entry.id);
                } catch (error) {
                    logger.error(`[managed-mcp] failed to autostart ${entry.id}`, error);
                }
            }
        }
    }

    async function handle(request, response) {
        try {
            const auth = `${request.headers.authorization || ""}`;
            if (auth !== `Bearer ${controlToken}`) {
                sendJson(response, 401, { error: "unauthorized" });
                return;
            }
            const url = new URL(request.url || "/", "http://127.0.0.1");
            const parts = url.pathname.split("/").filter(Boolean);
            if (request.method === "GET" && url.pathname === "/managed-mcp/catalog") {
                sendJson(response, 200, { catalog });
                return;
            }
            if (request.method === "GET" && url.pathname === "/managed-mcp") {
                sendJson(response, 200, await list());
                return;
            }
            if (parts[0] === "managed-mcp" && parts[1]) {
                const id = parts[1];
                const action = parts[2] || "";
                const body = await readBody(request);
                if (request.method === "GET" && !action) sendJson(response, 200, await statusFor(id));
                else if (request.method === "POST" && action === "install") sendJson(response, 200, await install(id, body));
                else if (request.method === "POST" && action === "start") sendJson(response, 200, await start(id));
                else if (request.method === "POST" && action === "stop") sendJson(response, 200, await stop(id));
                else if (request.method === "PATCH" && !action) sendJson(response, 200, await patch(id, body));
                else if (request.method === "DELETE" && !action) sendJson(response, 200, await uninstall(id));
                else sendJson(response, 404, { error: "not found" });
                return;
            }
            sendJson(response, 404, { error: "not found" });
        } catch (error) {
            sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
        }
    }

    const controlToken = crypto.randomBytes(32).toString("hex");

    async function startControlServer() {
        const server = http.createServer((request, response) => {
            void handle(request, response);
        });
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        supervisor.addCleanup(() => new Promise((resolve) => server.close(resolve)));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("failed to bind managed MCP control server");
        return {
            url: `http://127.0.0.1:${address.port}`,
            token: controlToken,
        };
    }

    return {
        install,
        list,
        patch,
        start,
        startAuto,
        startControlServer,
        statusFor,
        stop,
        uninstall,
    };
}

module.exports = {
    createManagedMcpService,
    loadCatalog,
    normalizeServerConfig,
    resolveMcpsRoot,
};

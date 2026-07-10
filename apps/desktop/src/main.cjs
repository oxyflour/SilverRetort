// @ts-check
const crypto = require("node:crypto");
const path = require("node:path");
const { existsSync, mkdirSync, readFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { app, BrowserWindow, utilityProcess } = require("electron/main");

const DEFAULT_NEXT_PORT = 23000;
const DEFAULT_PYTHON_PORT = 23001;
const DEFAULT_HERMES_PORT = 23002;

/**
 * 
 * @param { string } label 
 * @param { string } data 
 */
function logWithLabel(label, data) {
    for (const line of `${data}`.split("\n")) {
        if (line) {
            console.log(`[${label}] ${line}`);
        }
    }
}

/**
 * 
 * @param { string } label 
 * @param { import("node:child_process").ChildProcess } proc 
 */
function watchProc(label, proc) {
    proc.stdout?.on("data", (data) => logWithLabel(label, data));
    proc.stderr?.on("data", (data) => logWithLabel(label, data));
    proc.addListener("error", (error) => {
        console.error(`[main] ERR: ${label} failed`, error);
    });
    proc.addListener("exit", (code, signal) => {
        console.log(`[main] BYE: ${label} quit (code=${code}, signal=${signal})`);
        app.quit();
    });
}

/**
 * @type {null | import("electron").BrowserWindow}
 */
let mainWindow = null;

/**
 * 
 * @param { string } url 
 * @param { number } retry 
 * @returns 
 */
async function assertUrl(url, retry = 30) {
    while (retry-- > 0) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        try {
            const req = await fetch(url);
            const text = await req.text();
            if (req.status === 200) {
                return text;
            }
            throw new Error(`${req.status}: ${text}`);
        } catch {
            console.warn(`[main] waiting for url ${url} (${retry} retries left)`);
        }
    }
    throw new Error(`failed to request ${url}`);
}

const desktopRoot = path.resolve(__dirname, "..");
const serviceRoot = app.isPackaged
    ? process.resourcesPath
    : path.resolve(__dirname, "..", "..");
const desktopEnvPath = path.join(desktopRoot, ".env");

function stripEnvValue(rawValue) {
    const value = rawValue.trim();
    if (value.length >= 2 && value[0] === value[value.length - 1] && (`"'`).includes(value[0])) {
        return value.slice(1, -1);
    }
    return value;
}

function loadDesktopEnv() {
    if (!existsSync(desktopEnvPath)) {
        return {};
    }

    /** @type {Record<string, string>} */
    const env = {};
    const text = readFileSync(desktopEnvPath, "utf8");
    for (const rawLine of text.split(/\r?\n/u)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) {
            continue;
        }
        const separator = line.indexOf("=");
        if (separator <= 0) {
            continue;
        }
        const key = line.slice(0, separator).trim();
        const value = stripEnvValue(line.slice(separator + 1));
        if (key) {
            env[key] = value;
        }
    }
    return env;
}

const desktopEnv = loadDesktopEnv();

function buildChildEnv(overrides = {}) {
    return {
        ...process.env,
        ...desktopEnv,
        ...overrides,
    };
}

function ensureDir(dirPath) {
    mkdirSync(dirPath, { recursive: true });
    return dirPath;
}

function resolveDataDir() {
    const configured = `${process.env.SILVERRETORT_DATA_DIR || ""}`.trim();
    const dataDir = configured
        ? path.resolve(configured)
        : path.join(app.getPath("userData"), "data");
    return ensureDir(dataDir);
}

function readJsonObject(filePath) {
    if (!existsSync(filePath)) {
        return {};
    }

    const raw = readFileSync(filePath, "utf8").trim();
    if (!raw) {
        return {};
    }

    const parsed = JSON.parse(raw);
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
        throw new Error(`expected JSON object in ${filePath}`);
    }
    return parsed;
}

function readSettings(dataDir) {
    return readJsonObject(path.join(dataDir, "settings.json"));
}

function normalizeBaseUrl(url) {
    return `${url || ""}`.trim().replace(/\/+$/u, "");
}

function joinUrl(baseUrl, route) {
    return new URL(route, `${normalizeBaseUrl(baseUrl)}/`).toString();
}

function randomApiKey() {
    return crypto.randomBytes(32).toString("hex");
}

function resolveNextEntry() {
    const target = app.isPackaged
        ? path.join(serviceRoot, "next", "apps", "next", "server.js")
        : path.join(serviceRoot, "next", "node_modules", "next", "dist", "bin", "next");
    if (!existsSync(target)) {
        throw new Error(`missing next entrypoint: ${target}`);
    }
    return target;
}

function resolveHermesRuntime() {
    if (!app.isPackaged) {
        return {
            command: "uv",
            args: ["run", "--project", ".", "python", "main.py"],
            cwd: path.join(serviceRoot, "hermes"),
        };
    }
    return null;
}

/**
 * 
 * @param { number } pythonPort 
 * @returns 
 */
function resolvePythonRuntime(pythonPort) {
    if (!app.isPackaged) {
        return {
            command: "uv",
            args: ["run", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", `${pythonPort}`],
            cwd: path.join(serviceRoot, "uvicorn"),
        };
    }

    const executable = path.join(
        serviceRoot,
        "uvicorn",
        "silverretort-uvicorn",
        process.platform === "win32" ? "silverretort-uvicorn.exe" : "silverretort-uvicorn",
    );
    if (!existsSync(executable)) {
        throw new Error(`missing packaged python executable: ${executable}`);
    }

    return {
        command: executable,
        args: [],
        cwd: path.dirname(executable),
    };
}

function resolveHermesMode(dataDir, pythonPort, hermesPort) {
    const settings = readSettings(dataDir);
    const hermesUrl = normalizeBaseUrl(settings.hermesUrl);
    const hermesApiKey = `${settings.hermesApiKey || ""}`.trim();

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

    const runtime = resolveHermesRuntime();
    if (runtime === null) {
        console.warn("[main] packaged local hermes is not bundled yet; falling back to mock engine");
        return { mode: "disabled" };
    }

    const apiKey = randomApiKey();
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
            MCP_URL: `http://127.0.0.1:${pythonPort}/mcp`,
            HERMES_HOME: ensureDir(path.join(dataDir, "hermes-home")),
            HERMES_ENV_FILE: desktopEnvPath,
        },
    };
}

function startHermesProcess(hermesMode) {
    if (hermesMode.mode !== "local") {
        return null;
    }

    const proc = spawn(hermesMode.runtime.command, hermesMode.runtime.args, {
        cwd: hermesMode.runtime.cwd,
        env: buildChildEnv(hermesMode.env),
        stdio: "pipe",
    });
    watchProc("hermes", proc);
    return proc;
}

/**
 * 
 * @param { number } nextJsPort 
 * @param { number } pythonPort 
 * @returns 
 */
function startNextServer(nextJsPort, pythonPort) {
    const command = resolveNextEntry();
    const cwd = app.isPackaged
        ? path.join(serviceRoot, "next", "apps", "next")
        : path.join(serviceRoot, "next");
    const args = app.isPackaged
        ? []
        : ["dev", "-H", "127.0.0.1", "-p", `${nextJsPort}`];

    return utilityProcess.fork(command, args, {
        cwd,
        env: buildChildEnv({
            PORT: `${nextJsPort}`,
            HOSTNAME: "127.0.0.1",
            API_REWRITE: `http://127.0.0.1:${pythonPort}/`,
        }),
        stdio: "pipe",
    });
}

async function startServer(
    nextJsPort = DEFAULT_NEXT_PORT,
    pythonPort = DEFAULT_PYTHON_PORT,
    hermesPort = DEFAULT_HERMES_PORT,
) {
    const dataDir = resolveDataDir();
    const hermesMode = resolveHermesMode(dataDir, pythonPort, hermesPort);
    const pythonRuntime = resolvePythonRuntime(pythonPort);
    watchProc("uvicorn", spawn(pythonRuntime.command, pythonRuntime.args, {
        cwd: pythonRuntime.cwd,
        env: buildChildEnv({
            LISTEN_PORT: `${pythonPort}`,
            DATA_DIR: dataDir,
            ...(hermesMode.mode === "disabled"
                ? {}
                : {
                    HERMES_URL: hermesMode.url,
                    HERMES_API_KEY: hermesMode.apiKey,
                }),
        }),
        stdio: "pipe",
    }));

    startHermesProcess(hermesMode);
    const nextjs = startNextServer(nextJsPort, pythonPort);
    // @ts-ignore
    watchProc("nextjs", nextjs);

    const healthChecks = [
        assertUrl(`http://127.0.0.1:${pythonPort}/health`),
        assertUrl(`http://127.0.0.1:${nextJsPort}/health`),
    ];
    if (hermesMode.mode !== "disabled") {
        healthChecks.push(assertUrl(hermesMode.healthUrl));
    }

    const [apiHealth, nextHealth, hermesHealth] = await Promise.all(healthChecks);
    const hermesSummary = hermesMode.mode === "disabled"
        ? "hermes=mock"
        : `hermes=${hermesHealth}`;
    console.log(`[main] HEALTH: api=${apiHealth}; web=${nextHealth}; ${hermesSummary}; data=${dataDir}`);
    return `http://127.0.0.1:${nextJsPort}`;
}

async function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 640,
        height: 480,
        show: false,
        webPreferences: {
            allowRunningInsecureContent: true,
            webSecurity: false,
        }
    });

    mainWindow.once("ready-to-show", () => {
        mainWindow?.show();
    });

    mainWindow.on("closed", () => {
        mainWindow = null;
    });

    await mainWindow.loadFile(path.join(desktopRoot, "index.html"));

    const url = await startServer();
    await mainWindow.loadURL(url);
}

app.whenReady().then(async () => {
    try {
        await createMainWindow();
    } catch (error) {
        console.error("Failed to start desktop app:", error);
        app.quit();
    }
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});

app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        await createMainWindow();
    }
});

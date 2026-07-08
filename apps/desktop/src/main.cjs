// @ts-check
const path = require("node:path");
const { existsSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { app, BrowserWindow, utilityProcess } = require("electron/main");

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

function resolveNextEntry() {
    const target = app.isPackaged
        ? path.join(serviceRoot, "next", "apps", "next", "server.js")
        : path.join(serviceRoot, "next", "node_modules", "next", "dist", "bin", "next");
    if (!existsSync(target)) {
        throw new Error(`missing next entrypoint: ${target}`);
    }
    return target;
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
        env: {
            ...process.env,
            PORT: `${nextJsPort}`,
            HOSTNAME: "127.0.0.1",
            API_REWRITE: `http://127.0.0.1:${pythonPort}/`,
        },
        stdio: "pipe",
    });
}

async function startServer(nextJsPort = 23000, pythonPort = 23001) {
    const pythonRuntime = resolvePythonRuntime(pythonPort);
    watchProc("uvicorn", spawn(pythonRuntime.command, pythonRuntime.args, {
        cwd: pythonRuntime.cwd,
        env: {
            ...process.env,
            LISTEN_PORT: `${pythonPort}`,
        },
        stdio: "pipe",
    }));

    const nextjs = startNextServer(nextJsPort, pythonPort);
    // @ts-ignore
    watchProc("nextjs", nextjs);

    const [apiHealth, nextHealth] = await Promise.all([
        assertUrl(`http://127.0.0.1:${pythonPort}/health`),
        assertUrl(`http://127.0.0.1:${nextJsPort}/health`),
    ]);
    console.log(`[main] HEALTH: api=${apiHealth}; web=${nextHealth}`);
    return `http://127.0.0.1:${nextJsPort}`;
}

async function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 640,
        height: 480,
        show: false,
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

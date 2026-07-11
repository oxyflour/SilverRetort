// @ts-check
const { app, BrowserWindow, utilityProcess } = require("electron/main");
const { shell } = require("electron");
const { loadDesktopConfig } = require("./desktop-config.cjs");
const { createDesktopWindow } = require("./desktop-window.cjs");
const { createProcessSupervisor } = require("./process-supervisor.cjs");
const { startServiceStack } = require("./service-stack.cjs");

const APP_ID = "com.silverretort.app";
let runtime = null;
let mainWindow = null;
let windowPromise = null;
let isShuttingDown = false;

function getRuntime() {
    if (!runtime) {
        const config = loadDesktopConfig({ app, sourceDir: __dirname });
        const supervisor = createProcessSupervisor({
            onUnexpectedExit: () => app.quit(),
        });
        runtime = {
            config,
            supervisor,
            serviceUrlPromise: startServiceStack({ config, supervisor, utilityProcess }),
        };
    }
    return runtime;
}

async function openMainWindow() {
    if (mainWindow || windowPromise) {
        return;
    }
    const { config, serviceUrlPromise } = getRuntime();
    windowPromise = createDesktopWindow({
        BrowserWindow,
        shell,
        desktopRoot: config.desktopRoot,
        iconPath: config.iconPath,
        serviceUrlPromise,
        onClosed: () => { mainWindow = null; },
    });
    try {
        mainWindow = await windowPromise;
    } finally {
        windowPromise = null;
    }
}

async function startDesktop() {
    try {
        await openMainWindow();
    } catch (error) {
        console.error("Failed to start desktop app:", error);
        app.quit();
    }
}

if (process.platform === "win32") {
    app.setAppUserModelId(APP_ID);
}

app.whenReady().then(startDesktop);

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});

app.on("before-quit", (event) => {
    if (isShuttingDown) {
        return;
    }
    isShuttingDown = true;
    event.preventDefault();
    void (runtime?.supervisor.shutdown() ?? Promise.resolve()).finally(() => app.quit());
});

app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        void startDesktop();
    }
});

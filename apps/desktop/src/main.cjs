// @ts-check
const { app, BrowserWindow, utilityProcess } = require("electron/main");
const { shell } = require("electron");
const { loadDesktopConfig, writeDesktopSettings } = require("./desktop-config.cjs");
const { createDesktopWindow } = require("./desktop-window.cjs");
const { createProcessSupervisor } = require("./process-supervisor.cjs");
const { startServiceStack } = require("./service-stack.cjs");
const { defaultSwitchHermesUrl, randomApiKey, resolveHermesMode } = require("./hermes-service.cjs");

const APP_ID = "com.silverretort.app";
let runtime = null;
let mainWindow = null;
let windowPromise = null;
let isShuttingDown = false;

function switchConfigHtml(defaultUrl) {
    const escaped = `${defaultUrl}`
        .replace(/&/gu, "&amp;")
        .replace(/"/gu, "&quot;")
        .replace(/</gu, "&lt;");
    return `<!doctype html><html><head><meta charset="utf-8"><title>Configure Hermes Switch</title>
<style>body{font-family:system-ui,sans-serif;margin:24px;color:#171717}label,input{display:block;width:100%}input{box-sizing:border-box;margin-top:8px;padding:8px}button{margin-top:16px;padding:8px 14px}</style>
</head><body><h2>Configure Hermes Switch</h2><p>Packaged Hermes is not bundled. Confirm the apps/switch URL, then SilverRetort will save it and restart.</p><label>Switch URL<input id="url" type="url" value="${escaped}" autofocus></label><button id="save">Save and restart</button><script>
const { ipcRenderer } = require('electron');
document.getElementById('save').addEventListener('click', () => ipcRenderer.send('save-switch-url', document.getElementById('url').value));
document.getElementById('url').addEventListener('keydown', (event) => { if (event.key === 'Enter') document.getElementById('save').click(); });
</script></body></html>`;
}

function promptForSwitchUrl(config) {
    return new Promise((resolve) => {
        const { ipcMain } = require("electron/main");
        const defaultUrl = defaultSwitchHermesUrl();
        const promptWindow = new BrowserWindow({
            width: 520,
            height: 300,
            resizable: false,
            title: "Configure Hermes Switch",
            webPreferences: { nodeIntegration: true, contextIsolation: false },
        });
        const finish = (url) => {
            const hermesUrl = `${url || ""}`.trim();
            if (!hermesUrl) return;
            writeDesktopSettings(config, {
                hermesUrl,
                hermesApiKey: `${config.settings.hermesApiKey || ""}`.trim() || randomApiKey(),
            });
            promptWindow.close();
            resolve(true);
        };
        ipcMain.once("save-switch-url", (_event, url) => finish(url));
        promptWindow.once("closed", () => resolve(false));
        void promptWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(switchConfigHtml(defaultUrl))}`);
    });
}

async function ensurePackagedHermesConfig(config) {
    const hermesMode = resolveHermesMode(config, 23001, 23002);
    if (hermesMode.mode !== "needs-switch-config") return true;
    const saved = await promptForSwitchUrl(config);
    if (!saved) return false;
    app.relaunch();
    app.exit(0);
    return false;
}


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
        const config = loadDesktopConfig({ app, sourceDir: __dirname });
        if (!await ensurePackagedHermesConfig(config)) return;
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

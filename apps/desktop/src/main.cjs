// @ts-check
const { app, BrowserWindow, utilityProcess } = require("electron/main");
const { shell } = require("electron");
const { loadDesktopConfig, writeDesktopSettings } = require("./desktop-config.cjs");
const { createDesktopWindow } = require("./desktop-window.cjs");
const { createProcessSupervisor } = require("./process-supervisor.cjs");
const { startServiceStack } = require("./service-stack.cjs");
const { defaultSwitchHermesUrl, resolveHermesMode } = require("./hermes-service.cjs");

const APP_ID = "com.silverretort.app";
let runtime = null;
let mainWindow = null;
let windowPromise = null;
let isShuttingDown = false;

function escapeHtml(value) {
    return `${value}`
        .replace(/&/gu, "&amp;")
        .replace(/"/gu, "&quot;")
        .replace(/</gu, "&lt;");
}

function switchConfigHtml(defaultUrl, defaultApiKey = "") {
    const escapedUrl = escapeHtml(defaultUrl);
    const escapedApiKey = escapeHtml(defaultApiKey);
    return `<!doctype html><html><head><meta charset="utf-8"><title>Configure Hermes Switch</title>
<style>body{font-family:system-ui,sans-serif;margin:24px;color:#171717;line-height:1.45}label,input{display:block;width:100%}label{margin-top:14px;font-weight:600}input{box-sizing:border-box;margin-top:8px;padding:8px;font:inherit}button{margin-top:18px;padding:8px 14px}.hint{color:#666;font-size:13px}.error{color:#b91c1c;font-size:13px;min-height:18px}</style>
</head><body><h2>Configure Hermes Switch</h2><p>Packaged local Hermes is disabled by default. Enter the apps/switch URL and Hermes API Key, then SilverRetort will save them and restart.</p><label>Switch URL<input id="url" type="url" value="${escapedUrl}" autofocus></label><label>Hermes API Key<input id="key" type="password" value="${escapedApiKey}" autocomplete="new-password" placeholder="Paste the apps/switch user hermesApiKey"></label><p class="hint">The key must match the selected apps/switch user configuration.</p><p id="error" class="error"></p><button id="save">Save and restart</button><script>
const { ipcRenderer } = require('electron');
function save() {
  const url = document.getElementById('url').value.trim();
  const hermesApiKey = document.getElementById('key').value.trim();
  if (!url || !hermesApiKey) {
    document.getElementById('error').textContent = 'Switch URL and Hermes API Key are required.';
    return;
  }
  ipcRenderer.send('save-switch-config', { switchUrl: url, hermesApiKey });
}
document.getElementById('save').addEventListener('click', save);
for (const id of ['url', 'key']) document.getElementById(id).addEventListener('keydown', (event) => { if (event.key === 'Enter') save(); });
</script></body></html>`;
}

function promptForSwitchUrl(config) {
    return new Promise((resolve) => {
        const { ipcMain } = require("electron/main");
        const defaultUrl = defaultSwitchHermesUrl();
        const promptWindow = new BrowserWindow({
            width: 520,
            height: 430,
            resizable: false,
            title: "Configure Hermes Switch",
            webPreferences: { nodeIntegration: true, contextIsolation: false },
        });
        const finish = (payload) => {
            const switchUrl = `${payload?.switchUrl || ""}`.trim();
            const hermesApiKey = `${payload?.hermesApiKey || ""}`.trim();
            if (!switchUrl || !hermesApiKey) return;
            writeDesktopSettings(config, { switchUrl, hermesApiKey });
            promptWindow.close();
            resolve(true);
        };
        ipcMain.once("save-switch-config", (_event, payload) => finish(payload));
        promptWindow.once("closed", () => resolve(false));
        void promptWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(switchConfigHtml(
            defaultUrl,
            `${config.settings.hermesApiKey || ""}`.trim(),
        ))}`);
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
            onUnexpectedExit: ({ code }) => {
                if (code === 42) {
                    app.relaunch();
                }
                app.quit();
            },
        });
        const serviceUrlPromise = startServiceStack({ config, supervisor, utilityProcess });
        // createDesktopWindow awaits this shortly afterwards. Attach a rejection
        // handler immediately so startup failures are not reported as temporarily
        // unhandled while Electron is still creating the window.
        void serviceUrlPromise.catch(() => {});
        runtime = {
            config,
            supervisor,
            serviceUrlPromise,
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

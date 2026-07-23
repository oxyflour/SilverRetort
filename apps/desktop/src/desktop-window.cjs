// @ts-check
const path = require("node:path");
const { existsSync } = require("node:fs");

const SHARED_WINDOW_OPTIONS = {
    allowRunningInsecureContent: true,
    webSecurity: false,
};

function classifyWindowOpen(target, baseUrl) {
    let targetUrl;
    try {
        targetUrl = new URL(target);
    } catch {
        return { kind: "deny" };
    }
    const appOrigin = new URL(baseUrl).origin;
    if (targetUrl.origin === appOrigin && targetUrl.pathname.startsWith("/artifacts/")) {
        return { kind: "artifact", url: targetUrl.toString() };
    }
    if (targetUrl.protocol === "http:" || targetUrl.protocol === "https:") {
        return { kind: "external", url: targetUrl.toString() };
    }
    return { kind: "deny" };
}

function configureWindowOpenHandler(window, baseUrl, shell, iconPath) {
    window.webContents.setWindowOpenHandler(({ url }) => {
        const target = classifyWindowOpen(url, baseUrl);
        if (target.kind === "artifact") {
            return {
                action: "allow",
                overrideBrowserWindowOptions: {
                    width: 1000,
                    height: 760,
                    minWidth: 640,
                    minHeight: 480,
                    autoHideMenuBar: true,
                    title: "Artifact",
                    icon: existsSync(iconPath) ? iconPath : undefined,
                    webPreferences: SHARED_WINDOW_OPTIONS,
                },
            };
        }
        if (target.kind === "external") {
            void shell.openExternal(target.url);
        }
        return { action: "deny" };
    });
}

/**
 * @param {{
 *   BrowserWindow: typeof import("electron").BrowserWindow,
 *   shell: typeof import("electron").shell,
 *   desktopRoot: string,
 *   iconPath: string,
 *   serviceUrlPromise: Promise<string>,
 *   onClosed?: () => void,
 * }} options
 */
async function createDesktopWindow({
    BrowserWindow,
    shell,
    desktopRoot,
    iconPath,
    serviceUrlPromise,
    onClosed = () => {},
}) {
    const window = new BrowserWindow({
        width: 640,
        height: 480,
        show: false,
        icon: existsSync(iconPath) ? iconPath : undefined,
        webPreferences: SHARED_WINDOW_OPTIONS,
    });
    window.setMenuBarVisibility(false);
    window.once("ready-to-show", () => window.show());
    window.on("closed", onClosed);
    await window.loadFile(path.join(desktopRoot, "index.html"));
    const url = await serviceUrlPromise;
    configureWindowOpenHandler(window, url, shell, iconPath);
    await window.loadURL(url);
    return window;
}

module.exports = {
    classifyWindowOpen,
    configureWindowOpenHandler,
    createDesktopWindow,
};

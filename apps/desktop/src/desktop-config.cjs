// @ts-check
const path = require("node:path");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");

function stripEnvValue(rawValue) {
    const value = rawValue.trim();
    if (value.length >= 2 && value[0] === value[value.length - 1] && (`"'`).includes(value[0])) {
        return value.slice(1, -1);
    }
    return value;
}

function parseDesktopEnv(text) {
    /** @type {Record<string, string>} */
    const env = {};
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
        if (key) {
            env[key] = stripEnvValue(line.slice(separator + 1));
        }
    }
    return env;
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

function ensureDir(dirPath) {
    mkdirSync(dirPath, { recursive: true });
    return dirPath;
}

function normalizeBaseUrl(url) {
    return `${url || ""}`.trim().replace(/\/+$/u, "");
}

function joinUrl(baseUrl, route) {
    return new URL(route, `${normalizeBaseUrl(baseUrl)}/`).toString();
}

function normalizeSettingsEnv(settings) {
    const rawEnv = settings && typeof settings.env === "object" && !Array.isArray(settings.env)
        ? settings.env
        : {};
    const env = {};
    for (const [rawKey, rawValue] of Object.entries(rawEnv)) {
        const key = `${rawKey}`.trim();
        if (key) {
            env[key] = `${rawValue}`;
        }
    }
    return env;
}

function writeDesktopSettings(config, nextSettings) {
    const settings = { ...config.settings, ...nextSettings };
    writeFileSync(config.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    config.settings = settings;
    return settings;
}

function toWebSocketUrl(baseUrl, route = "") {
    const url = new URL(route, `${normalizeBaseUrl(baseUrl)}/`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
}

/**
 * @param {{
 *   app: Pick<import("electron").App, "isPackaged" | "getPath">,
 *   sourceDir?: string,
 *   resourcesPath?: string,
 *   processEnv?: NodeJS.ProcessEnv,
 * }} options
 */
function loadDesktopConfig({
    app,
    sourceDir = __dirname,
    resourcesPath = process.resourcesPath,
    processEnv = process.env,
}) {
    const desktopRoot = path.resolve(sourceDir, "..");
    const serviceRoot = app.isPackaged
        ? resourcesPath
        : path.resolve(sourceDir, "..", "..");
    const envPath = path.join(desktopRoot, ".env");
    const iconPath = path.join(desktopRoot, "assets", "icon.png");
    const desktopEnv = existsSync(envPath)
        ? parseDesktopEnv(readFileSync(envPath, "utf8"))
        : {};

    const configuredDataDir = `${processEnv.SILVERRETORT_DATA_DIR || ""}`.trim();
    const dataDir = ensureDir(configuredDataDir
        ? path.resolve(configuredDataDir)
        : path.join(app.getPath("userData"), "data"));
    const settingsPath = path.join(dataDir, "settings.json");
    const settings = readJsonObject(settingsPath);

    return {
        isPackaged: app.isPackaged,
        desktopRoot,
        serviceRoot,
        envPath,
        iconPath,
        desktopEnv,
        processEnv,
        dataDir,
        settings,
        settingsPath,
        buildChildEnv(overrides = {}) {
            return {
                ...processEnv,
                ...desktopEnv,
                ...normalizeSettingsEnv(this.settings),
                ...overrides,
            };
        },
    };
}

module.exports = {
    ensureDir,
    joinUrl,
    loadDesktopConfig,
    normalizeBaseUrl,
    normalizeSettingsEnv,
    parseDesktopEnv,
    readJsonObject,
    toWebSocketUrl,
    writeDesktopSettings,
};

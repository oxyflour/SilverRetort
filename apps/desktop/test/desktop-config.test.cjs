const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
    joinUrl,
    loadDesktopConfig,
    normalizeSettingsEnv,
    parseDesktopEnv,
    readJsonObject,
    toWebSocketUrl,
} = require("../src/desktop-config.cjs");

test("parseDesktopEnv preserves values and strips matching quotes", () => {
    assert.deepEqual(parseDesktopEnv([
        "# comment",
        "PLAIN=value",
        "QUOTED=\"hello world\"",
        "SINGLE='value=with=equals'",
        "invalid",
    ].join("\n")), {
        PLAIN: "value",
        QUOTED: "hello world",
        SINGLE: "value=with=equals",
    });
});

test("loadDesktopConfig resolves paths, settings, and child environment", (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "silverretort-config-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const sourceDir = path.join(root, "desktop", "src");
    const dataDir = path.join(root, "data");
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(root, "desktop", ".env"), "FROM_FILE=yes\nSHARED=file\n");
    writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({
        switchUrl: "https://example.test",
        env: { SETTINGS_ONLY: "yes", SHARED: "settings", " ENABLE_LOCAL_HERMES ": 1 },
    }));

    const config = loadDesktopConfig({
        app: { isPackaged: false, getPath: () => path.join(root, "user-data") },
        sourceDir,
        processEnv: { SILVERRETORT_DATA_DIR: dataDir, SHARED: "process", PROCESS_ONLY: "yes" },
    });

    assert.equal(config.desktopRoot, path.join(root, "desktop"));
    assert.equal(config.serviceRoot, root);
    assert.equal(config.templateRoot, path.join(path.dirname(root), "template"));
    assert.equal(config.dataDir, dataDir);
    assert.deepEqual(config.settings, {
        switchUrl: "https://example.test",
        env: { SETTINGS_ONLY: "yes", SHARED: "settings", " ENABLE_LOCAL_HERMES ": 1 },
    });
    assert.deepEqual(config.buildChildEnv({ SHARED: "override" }), {
        SILVERRETORT_DATA_DIR: dataDir,
        SHARED: "override",
        PROCESS_ONLY: "yes",
        FROM_FILE: "yes",
        SETTINGS_ONLY: "yes",
        ENABLE_LOCAL_HERMES: "1",
    });
});

test("normalizeSettingsEnv trims keys and stringifies values", () => {
    assert.deepEqual(normalizeSettingsEnv({ env: { " ENABLE_LOCAL_HERMES ": 1, EMPTY: "", " ": "skip" } }), {
        ENABLE_LOCAL_HERMES: "1",
        EMPTY: "",
    });
});

test("packaged config resolves templates from resources", (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "silverretort-packaged-config-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const config = loadDesktopConfig({
        app: { isPackaged: true, getPath: () => path.join(root, "user-data") },
        sourceDir: path.join(root, "app", "src"),
        resourcesPath: path.join(root, "resources"),
        processEnv: {},
    });

    assert.equal(config.templateRoot, path.join(root, "resources", "template"));
});

test("readJsonObject rejects non-object JSON", (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "silverretort-json-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, "settings.json");
    writeFileSync(file, "[]");
    assert.throws(() => readJsonObject(file), /expected JSON object/u);
});

test("URL helpers preserve routes and convert websocket protocols", () => {
    assert.equal(joinUrl("https://example.test/base///", "health"), "https://example.test/base/health");
    assert.equal(toWebSocketUrl("https://example.test/base", "bridge"), "wss://example.test/base/bridge");
    assert.equal(toWebSocketUrl("http://example.test", "bridge"), "ws://example.test/bridge");
});

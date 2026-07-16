const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { defaultSwitchHermesUrl, expandSwitchUrl, resolveHermesMode, resolveHermesRuntime } = require("../src/hermes-service.cjs");

function makeConfig(t, overrides = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "silverretort-hermes-"));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    return {
        isPackaged: false,
        serviceRoot: path.join(dataDir, "services"),
        dataDir,
        envPath: path.join(dataDir, ".env"),
        settings: {},
        desktopEnv: {},
        processEnv: {},
        ...overrides,
    };
}

test("resolveHermesMode creates the development local mode", (t) => {
    const config = makeConfig(t);
    const mode = resolveHermesMode(config, 23001, 23002, () => "local-key");
    assert.equal(mode.mode, "local");
    assert.equal(mode.apiKey, "local-key");
    assert.equal(mode.runtime.cwd, path.join(config.serviceRoot, "hermes"));
    assert.equal(mode.env.MCP_URL, "http://127.0.0.1:23001/mcp/");
});

test("resolveHermesMode accepts a configured remote service", (t) => {
    const config = makeConfig(t, {
        settings: { switchUrl: "https://example.test/hermes/", hermesApiKey: "secret" },
    });
    assert.deepEqual(resolveHermesMode(config, 23001, 23002), {
        mode: "remote",
        url: "https://example.test/hermes",
        apiKey: "secret",
        healthUrl: "https://example.test/hermes/health",
    });
});

test("resolveHermesMode rejects a remote service without an API key", (t) => {
    const config = makeConfig(t, { settings: { switchUrl: "http://example.test:23002" } });
    assert.throws(() => resolveHermesMode(config, 23001, 23002), /missing hermesApiKey/u);
});

test("removed Docker settings direct users to switchUrl", (t) => {
    const config = makeConfig(t, {
        settings: {
            hermesDockerImage: "silverretort-hermes:test",
            switchUrl: "https://switch.example/endpoint/alice",
            hermesApiKey: "secret",
        },
    });
    assert.throws(
        () => resolveHermesMode(config, 23001, 23002),
        /no longer supported; configure switchUrl instead/u,
    );
});


test("packaged mode uses the bundled Hermes executable when available", (t) => {
    const config = makeConfig(t, { isPackaged: true });
    const executableDir = path.join(config.serviceRoot, "hermes", "silverretort-hermes");
    mkdirSync(executableDir, { recursive: true });
    const executable = path.join(
        executableDir,
        process.platform === "win32" ? "silverretort-hermes.exe" : "silverretort-hermes",
    );
    writeFileSync(executable, "", "utf8");
    const runtime = resolveHermesRuntime(config);
    assert.equal(runtime.command, executable);
    assert.deepEqual(runtime.args, []);
    assert.equal(runtime.cwd, executableDir);
});

test("packaged mode with bundled Hermes stays disabled by default", (t) => {
    const config = makeConfig(t, { isPackaged: true });
    const executableDir = path.join(config.serviceRoot, "hermes", "silverretort-hermes");
    mkdirSync(executableDir, { recursive: true });
    writeFileSync(
        path.join(executableDir, process.platform === "win32" ? "silverretort-hermes.exe" : "silverretort-hermes"),
        "",
        "utf8",
    );
    const mode = resolveHermesMode(config, 23001, 23002, () => "packaged-key");
    assert.deepEqual(mode, { mode: "disabled" });
});

test("packaged mode starts bundled Hermes when explicitly enabled", (t) => {
    const config = makeConfig(t, {
        isPackaged: true,
        settings: { env: { "ENABLE_LOCAL_HERMES ": "1" } },
        buildChildEnv(overrides = {}) {
            const env = { ENABLE_LOCAL_HERMES: "1", ...overrides };
            return env;
        },
    });
    const executableDir = path.join(config.serviceRoot, "hermes", "silverretort-hermes");
    mkdirSync(executableDir, { recursive: true });
    writeFileSync(
        path.join(executableDir, process.platform === "win32" ? "silverretort-hermes.exe" : "silverretort-hermes"),
        "",
        "utf8",
    );
    const mode = resolveHermesMode(config, 23001, 23002, () => "packaged-key");
    assert.equal(mode.mode, "local");
    assert.equal(mode.apiKey, "packaged-key");
    assert.equal(mode.env.HERMES_RELAY_ENABLED, "1");
});

test("packaged mode without Hermes runtime requests switch configuration when local Hermes is enabled", (t) => {
    const config = makeConfig(t, { isPackaged: true, buildChildEnv: () => ({ ENABLE_LOCAL_HERMES: "1" }) });
    assert.deepEqual(resolveHermesMode(config, 23001, 23002), {
        mode: "needs-switch-config",
        url: defaultSwitchHermesUrl(),
    });
});

test("default switch URL points at localhost and encodes the user id", () => {
    assert.equal(
        defaultSwitchHermesUrl("Alice.Smith", "http://localhost:23004"),
        "http://localhost:23004/endpoint/Alice.Smith",
    );
});


test("switchUrl expands the USERNAME placeholder", () => {
    assert.equal(
        expandSwitchUrl("http://localhost:23004/endpoint/$USERNAME", "Alice Smith"),
        "http://localhost:23004/endpoint/Alice%20Smith",
    );
});

test("resolveHermesMode expands USERNAME in switchUrl", (t) => {
    const config = makeConfig(t, {
        settings: { switchUrl: "http://localhost:23004/endpoint/$USERNAME", hermesApiKey: "secret" },
    });
    const mode = resolveHermesMode(config, 23001, 23002, undefined, "Alice");
    assert.equal(mode.url, "http://localhost:23004/endpoint/Alice");
});

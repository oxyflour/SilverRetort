const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { defaultSwitchHermesUrl, resolveHermesMode, resolveHermesRuntime } = require("../src/hermes-service.cjs");

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
        settings: { hermesUrl: "https://example.test/hermes/", hermesApiKey: "secret" },
    });
    assert.deepEqual(resolveHermesMode(config, 23001, 23002), {
        mode: "remote",
        url: "https://example.test/hermes",
        apiKey: "secret",
        healthUrl: "https://example.test/hermes/health",
    });
});

test("resolveHermesMode rejects a remote service without an API key", (t) => {
    const config = makeConfig(t, { settings: { hermesUrl: "http://example.test:23002" } });
    assert.throws(() => resolveHermesMode(config, 23001, 23002), /missing hermesApiKey/u);
});

test("removed Docker settings direct users to hermesUrl", (t) => {
    const config = makeConfig(t, {
        settings: {
            hermesDockerImage: "silverretort-hermes:test",
            hermesUrl: "https://switch.example/endpoint/alice",
            hermesApiKey: "secret",
        },
    });
    assert.throws(
        () => resolveHermesMode(config, 23001, 23002),
        /no longer supported; configure hermesUrl instead/u,
    );
});

test("packaged mode without Hermes executable requests switch configuration", (t) => {
    const config = makeConfig(t, { isPackaged: true });
    assert.deepEqual(resolveHermesMode(config, 23001, 23002), {
        mode: "needs-switch-config",
        url: defaultSwitchHermesUrl(),
    });
});

test("packaged mode uses a bundled Hermes executable when present", (t) => {
    const config = makeConfig(t, { isPackaged: true });
    const hermesDir = path.join(config.serviceRoot, "hermes");
    mkdirSync(hermesDir, { recursive: true });
    const executable = path.join(hermesDir, process.platform === "win32" ? "silverretort-hermes.exe" : "silverretort-hermes");
    writeFileSync(executable, "");
    assert.deepEqual(resolveHermesRuntime(config), {
        command: executable,
        args: [],
        cwd: hermesDir,
    });
});

test("default switch URL points at localhost and encodes the user id", () => {
    assert.equal(
        defaultSwitchHermesUrl("Alice.Smith", "http://localhost:8080"),
        "http://localhost:8080/endpoint/Alice.Smith",
    );
});

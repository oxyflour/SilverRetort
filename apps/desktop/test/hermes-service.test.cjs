const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { resolveHermesMode } = require("../src/hermes-service.cjs");

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

test("packaged mode without Hermes configuration is disabled", (t) => {
    const config = makeConfig(t, { isPackaged: true });
    const originalWarn = console.warn;
    t.after(() => { console.warn = originalWarn; });
    console.warn = () => {};
    assert.deepEqual(resolveHermesMode(config, 23001, 23002), { mode: "disabled" });
});

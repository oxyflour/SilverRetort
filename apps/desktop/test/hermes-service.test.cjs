const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { hashSuffix, resolveHermesMode } = require("../src/hermes-service.cjs");

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
    assert.equal(mode.env.LISTEN_PORT, "23002");
});

test("resolveHermesMode accepts a configured remote service", (t) => {
    const config = makeConfig(t, {
        settings: { hermesUrl: "https://example.test/hermes/", hermesApiKey: "secret" },
    });
    const mode = resolveHermesMode(config, 23001, 23002);
    assert.deepEqual(mode, {
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

test("resolveHermesMode builds desktop-managed Docker arguments", (t) => {
    const url = "http://docker.example.test:24000";
    const config = makeConfig(t, {
        settings: {
            hermesUrl: url,
            hermesDockerImage: "silverretort-hermes:test",
            hermesDockerContainerPort: 25000,
        },
        desktopEnv: { OPENAI_API_KEY: "from-file" },
        processEnv: { OPENAI_MODEL_ID: "model-id" },
    });
    const mode = resolveHermesMode(config, 23001, 23002, () => "generated-key");
    assert.equal(mode.mode, "docker");
    assert.equal(mode.apiKey, "generated-key");
    assert.equal(mode.docker.containerName, `silverretort-hermes-${hashSuffix(url)}`);
    assert.deepEqual(mode.docker.removeArgs, ["rm", "-f", mode.docker.containerName]);
    assert.ok(mode.docker.runArgs.includes("24000:25000"));
    assert.ok(mode.docker.runArgs.includes("HERMES_API_KEY=generated-key"));
    assert.ok(mode.docker.runArgs.includes("OPENAI_API_KEY=from-file"));
    assert.ok(mode.docker.runArgs.includes("OPENAI_MODEL_ID=model-id"));
});

test("resolveHermesMode validates Docker configuration", (t) => {
    const missingUrl = makeConfig(t, { settings: { hermesDockerImage: "image" } });
    assert.throws(() => resolveHermesMode(missingUrl, 23001, 23002), /missing hermesUrl/u);

    const invalidPort = makeConfig(t, {
        settings: {
            hermesUrl: "http://example.test:23002",
            hermesDockerImage: "image",
            hermesDockerContainerPort: "invalid",
        },
    });
    assert.throws(() => resolveHermesMode(invalidPort, 23001, 23002), /invalid hermesDockerContainerPort/u);
});

test("packaged mode without Hermes configuration is disabled", (t) => {
    const config = makeConfig(t, { isPackaged: true });
    const originalWarn = console.warn;
    t.after(() => { console.warn = originalWarn; });
    console.warn = () => {};
    assert.deepEqual(resolveHermesMode(config, 23001, 23002), { mode: "disabled" });
});

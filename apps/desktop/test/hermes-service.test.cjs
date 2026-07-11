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

test("Docker mode builds user-scoped name, labels, and ephemeral publishing", (t) => {
    const config = makeConfig(t, {
        settings: {
            hermesDockerImage: "silverretort-hermes:test",
            hermesDockerUser: " Alice ",
            hermesDockerContainerPrefix: "Team Hermes",
            hermesDockerContainerPort: 25000,
            hermesDockerHost: "docker.example.test",
        },
        desktopEnv: { OPENAI_API_KEY: "from-file" },
        processEnv: { OPENAI_MODEL_ID: "model-id" },
    });
    const mode = resolveHermesMode(config, 23001, 23002, () => "generated-key");
    const ownerHash = hashSuffix("alice");
    assert.equal(mode.mode, "docker");
    assert.equal(mode.apiKey, "generated-key");
    assert.equal(mode.docker.containerName, `team-hermes-alice-${ownerHash}`);
    assert.equal(mode.docker.configuredHost, "docker.example.test");
    assert.deepEqual(
        mode.docker.runArgs.slice(mode.docker.runArgs.indexOf("-p"), mode.docker.runArgs.indexOf("-p") + 2),
        ["-p", "25000"],
    );
    assert.ok(mode.docker.runArgs.includes("com.silverretort.managed=true"));
    assert.ok(mode.docker.runArgs.includes(`com.silverretort.owner=${ownerHash}`));
    assert.ok(mode.docker.runArgs.includes("HERMES_API_KEY=generated-key"));
    assert.ok(mode.docker.runArgs.includes("OPENAI_API_KEY=from-file"));
    assert.ok(mode.docker.runArgs.includes("OPENAI_MODEL_ID=model-id"));
});

test("Docker mode ignores hermesUrl and warns", (t) => {
    const config = makeConfig(t, {
        settings: {
            hermesDockerImage: "image",
            hermesDockerUser: "alice",
            hermesUrl: "http://ignored.example.test:23002",
        },
    });
    const warnings = [];
    const originalWarn = console.warn;
    t.after(() => { console.warn = originalWarn; });
    console.warn = (message) => warnings.push(message);
    const mode = resolveHermesMode(config, 23001, 23002, () => "key");
    assert.equal(mode.mode, "docker");
    assert.equal(mode.url, undefined);
    assert.match(warnings[0], /hermesUrl is ignored/u);
});

test("Docker mode rejects removed names and invalid settings", (t) => {
    const oldName = makeConfig(t, {
        settings: { hermesDockerImage: "image", hermesDockerContainerName: "legacy" },
    });
    assert.throws(
        () => resolveHermesMode(oldName, 23001, 23002),
        /hermesDockerContainerName is no longer supported/u,
    );

    const invalidPort = makeConfig(t, {
        settings: { hermesDockerImage: "image", hermesDockerContainerPort: 70000 },
    });
    assert.throws(() => resolveHermesMode(invalidPort, 23001, 23002), /invalid hermesDockerContainerPort/u);

    const invalidHost = makeConfig(t, {
        settings: { hermesDockerImage: "image", hermesDockerHost: "http://docker.test" },
    });
    assert.throws(() => resolveHermesMode(invalidHost, 23001, 23002), /invalid hermesDockerHost/u);

    const invalidPrefix = makeConfig(t, {
        settings: { hermesDockerImage: "image", hermesDockerContainerPrefix: "---" },
    });
    assert.throws(() => resolveHermesMode(invalidPrefix, 23001, 23002), /must contain Docker-safe/u);
});

test("packaged mode without Hermes configuration is disabled", (t) => {
    const config = makeConfig(t, { isPackaged: true });
    const originalWarn = console.warn;
    t.after(() => { console.warn = originalWarn; });
    console.warn = () => {};
    assert.deepEqual(resolveHermesMode(config, 23001, 23002), { mode: "disabled" });
});

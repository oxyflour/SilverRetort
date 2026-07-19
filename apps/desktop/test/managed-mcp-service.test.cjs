const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { createProcessSupervisor } = require("../src/process-supervisor.cjs");
const { createManagedMcpService } = require("../src/managed-mcp-service.cjs");

function fakeLogger() {
    return { log() {}, error() {} };
}

function makeConfig(t) {
    const dataDir = mkdtempSync(path.join(tmpdir(), "silverretort-managed-mcp-"));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    return {
        isPackaged: false,
        serviceRoot: path.resolve(__dirname, "..", ".."),
        dataDir,
        settingsPath: path.join(dataDir, "settings.json"),
        settings: {},
        buildChildEnv(overrides = {}) {
            return { ...process.env, ...overrides };
        },
    };
}

function spawnFakeAdapter(_command, args, options) {
    const port = args[args.indexOf("--port") + 1];
    const script = [
        "const http = require('node:http');",
        `http.createServer((req, res) => {`,
        "  if (req.url === '/health') { res.end(JSON.stringify({status:'ok'})); return; }",
        "  res.statusCode = 404; res.end('not found');",
        `}).listen(${JSON.stringify(port)}, '127.0.0.1');`,
    ].join("\n");
    return spawn(process.execPath, ["-e", script], { ...options, stdio: "pipe" });
}

test("managed MCP install starts an adapter and persists settings", async (t) => {
    const config = makeConfig(t);
    const supervisor = createProcessSupervisor({ onUnexpectedExit() {}, logger: fakeLogger() });
    t.after(() => supervisor.shutdown());
    const service = createManagedMcpService({
        config,
        supervisor,
        spawn: spawnFakeAdapter,
        logger: fakeLogger(),
    });

    const installed = await service.install("cst_studio");
    assert.equal(installed.installed, true);
    assert.equal(installed.running, true);
    assert.equal(installed.enabled, true);
    assert.equal(installed.autoStart, true);
    assert.equal(installed.serverName, "cst_studio");

    const stopped = await service.stop("cst_studio");
    assert.equal(stopped.running, false);
});

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { createProcessSupervisor } = require("../src/process-supervisor.cjs");

function fakeLogger() {
    return { log() {}, error() {} };
}

function fakeProcess(events) {
    const proc = new EventEmitter();
    proc.killed = false;
    proc.kill = () => {
        proc.killed = true;
        events.push("kill");
        proc.emit("exit", null, "SIGTERM");
    };
    return proc;
}

test("critical process exit requests application shutdown", () => {
    const exits = [];
    const supervisor = createProcessSupervisor({
        onUnexpectedExit: (details) => exits.push(details),
        logger: fakeLogger(),
    });
    const proc = fakeProcess([]);
    supervisor.monitor("uvicorn", proc);
    proc.emit("exit", 3, null);
    assert.deepEqual(exits, [{ label: "uvicorn", code: 3, signal: null }]);
});

test("shutdown is idempotent, runs cleanup in reverse, and suppresses fail-fast", async () => {
    const events = [];
    const exits = [];
    const supervisor = createProcessSupervisor({
        onUnexpectedExit: (details) => exits.push(details),
        logger: fakeLogger(),
    });
    supervisor.addCleanup(() => { events.push("first"); });
    supervisor.monitor("nextjs", fakeProcess(events));
    supervisor.addCleanup(() => { events.push("last"); });

    const firstShutdown = supervisor.shutdown();
    const secondShutdown = supervisor.shutdown();
    assert.strictEqual(firstShutdown, secondShutdown);
    await firstShutdown;
    assert.deepEqual(events, ["last", "kill", "first"]);
    assert.deepEqual(exits, []);
    assert.equal(supervisor.isShuttingDown, true);
});

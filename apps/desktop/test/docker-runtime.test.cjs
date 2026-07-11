const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const {
    buildDockerUrl,
    hostFromDockerEndpoint,
    normalizeDockerHost,
    parsePublishedPort,
    removeOwnedStaleContainer,
    resolveDockerIdentity,
    resolveDockerPublicHost,
    startManagedDocker,
} = require("../src/docker-runtime.cjs");
const { hashSuffix } = require("../src/hermes-service.cjs");

function createHarness(responses) {
    const calls = [];
    const spawn = (command, args) => {
        calls.push({ command, args });
        const proc = new EventEmitter();
        proc.stdout = new PassThrough();
        proc.stderr = new PassThrough();
        proc.killed = false;
        proc.kill = () => {
            proc.killed = true;
            proc.emit("exit", null, "SIGTERM");
        };
        if (args[0] !== "logs" && args[0] !== "wait") {
            const response = responses.shift();
            assert.ok(response, `missing mock response for docker ${args.join(" ")}`);
            queueMicrotask(() => {
                if (response.stdout) proc.stdout.write(response.stdout);
                if (response.stderr) proc.stderr.write(response.stderr);
                proc.emit("exit", response.code ?? 0, null);
            });
        }
        return proc;
    };
    const supervisor = {
        cleanups: [],
        addCleanup(fn) { this.cleanups.push(fn); },
        monitor() {},
    };
    const config = {
        serviceRoot: "C:/services",
        processEnv: {},
        buildChildEnv: () => ({}),
    };
    return { calls, config, spawn, supervisor };
}

test("user identity is stable, case-insensitive, and collision resistant", () => {
    const alice = resolveDockerIdentity({}, hashSuffix, () => " Alice ");
    const sameAlice = resolveDockerIdentity({}, hashSuffix, () => "ＡＬＩＣＥ");
    const unicode = resolveDockerIdentity({ hermesDockerUser: "张三" }, hashSuffix);
    const other = resolveDockerIdentity({ hermesDockerUser: "bob" }, hashSuffix);
    assert.deepEqual(alice, sameAlice);
    assert.match(alice.containerName, /^silverretort-hermes-alice-[a-f0-9]{12}$/u);
    assert.match(unicode.containerName, /^silverretort-hermes-user-[a-f0-9]{12}$/u);
    assert.notEqual(alice.containerName, other.containerName);
});

test("Docker endpoint and explicit host parsing covers local, remote, and IPv6", () => {
    assert.equal(hostFromDockerEndpoint("npipe:////./pipe/docker_engine"), "127.0.0.1");
    assert.equal(hostFromDockerEndpoint("unix:///var/run/docker.sock"), "127.0.0.1");
    assert.equal(hostFromDockerEndpoint("ssh://user@docker.example.test:22"), "docker.example.test");
    assert.equal(hostFromDockerEndpoint("tcp://10.0.0.8:2375"), "10.0.0.8");
    assert.equal(hostFromDockerEndpoint("tcp://[2001:db8::1]:2375"), "2001:db8::1");
    assert.equal(normalizeDockerHost("[2001:db8::2]"), "2001:db8::2");
    assert.equal(buildDockerUrl("2001:db8::2", 49152), "http://[2001:db8::2]:49152");
});

test("published port parser accepts dual-stack output and rejects ambiguity", () => {
    assert.equal(parsePublishedPort("0.0.0.0:49152\n[::]:49152\n"), 49152);
    assert.throws(() => parsePublishedPort(""), /did not publish/u);
    assert.throws(() => parsePublishedPort("0.0.0.0:49152\n[::]:49153"), /conflicting/u);
});

test("Docker public host prefers DOCKER_HOST and otherwise inspects context", async () => {
    const direct = createHarness([]);
    direct.config.processEnv.DOCKER_HOST = "ssh://alice@docker.example.test";
    assert.equal(
        await resolveDockerPublicHost({ configuredHost: null }, direct.config, direct.supervisor, direct.spawn),
        "docker.example.test",
    );
    assert.equal(direct.calls.length, 0);

    const context = createHarness([
        { stdout: "shared-context\n" },
        { stdout: "tcp://10.0.0.9:2375\n" },
    ]);
    assert.equal(
        await resolveDockerPublicHost(
            { command: "docker", configuredHost: null },
            context.config,
            context.supervisor,
            context.spawn,
        ),
        "10.0.0.9",
    );
    assert.deepEqual(context.calls[0].args, ["context", "show"]);
    assert.deepEqual(context.calls[1].args.slice(0, 3), ["context", "inspect", "shared-context"]);
});

test("stale cleanup removes only a container with matching managed and owner labels", async () => {
    const owned = createHarness([
        { stdout: "old-container\n" },
        { stdout: "true|owner123\n" },
        {},
    ]);
    const docker = { command: "docker", containerName: "hermes-alice", ownerHash: "owner123" };
    await removeOwnedStaleContainer(docker, owned.config, owned.supervisor, owned.spawn);
    assert.deepEqual(owned.calls[2].args, ["rm", "-f", "old-container"]);

    const foreign = createHarness([
        { stdout: "foreign-container\n" },
        { stdout: "true|someone-else\n" },
    ]);
    await assert.rejects(
        removeOwnedStaleContainer(docker, foreign.config, foreign.supervisor, foreign.spawn),
        /refusing to remove/u,
    );
    assert.equal(foreign.calls.length, 2);
});

test("managed Docker resolves dynamic port and uses container ID after startup", async () => {
    const harness = createHarness([
        { stdout: "" },
        { stdout: `${"a".repeat(64)}\n` },
        { stdout: "0.0.0.0:49160\n[::]:49160\n" },
    ]);
    const docker = {
        command: "docker",
        configuredHost: "docker.example.test",
        containerName: "silverretort-hermes-alice-owner",
        containerPort: 23002,
        ownerHash: "owner",
        runArgs: ["run", "--rm", "-d", "-p", "23002", "image"],
    };
    const runtime = await startManagedDocker(
        docker, harness.config, harness.supervisor, harness.spawn,
    );
    assert.equal(runtime.url, "http://docker.example.test:49160");
    assert.equal(runtime.containerId, "a".repeat(64));
    assert.deepEqual(harness.calls[2].args, ["port", "a".repeat(64), "23002/tcp"]);
    assert.deepEqual(harness.calls[3].args, ["logs", "-f", "a".repeat(64)]);
    assert.deepEqual(harness.calls[4].args, ["wait", "a".repeat(64)]);
});

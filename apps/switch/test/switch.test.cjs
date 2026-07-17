const assert = require("node:assert/strict");
const test = require("node:test");

const {
    SwitchError,
    adminCookieValue,
    authorize,
    forwardedHeaders,
    normalizeUserConfig,
    parseForm,
    parseRoute,
    parseStatusRoute,
    shouldRecycleContainer,
    shouldStopIdleHermes,
} = require("../switch.cjs");

test("parseRoute accepts encoded Windows-style account names", () => {
    assert.deepEqual(parseRoute("/endpoint/Alice.Smith-01/api/health?verbose=1"), {
        id: "Alice.Smith-01",
        prefix: "/endpoint/Alice.Smith-01",
        target: "/api/health?verbose=1",
    });
});

test("parseRoute rejects unsupported user identifiers", () => {
    assert.throws(() => parseRoute("/endpoint/%E6%B5%8B%E8%AF%95"), /unsupported/u);
    assert.throws(() => parseRoute("/endpoint/-alice"), /unsupported/u);
});

test("parseStatusRoute accepts a user status route", () => {
    assert.deepEqual(parseStatusRoute("/status/Alice.Smith-01"), { id: "Alice.Smith-01" });
});

test("normalizeUserConfig reads JSON startup settings", () => {
    assert.deepEqual(normalizeUserConfig("alice", "config/alice.json", {
        hermesApiKey: "secret",
        image: "custom-hermes",
        containerPort: 23003,
        env: { OPENAI_MODEL_ID: "gpt-test" },
        volumes: ["alice-cache:/cache"],
        args: ["--verbose"],
    }), {
        id: "alice",
        configPath: "config/alice.json",
        apiKey: "secret",
        image: "custom-hermes",
        containerPort: 23003,
        env: { OPENAI_MODEL_ID: "gpt-test", HERMES_API_KEY: "secret" },
        volumes: ["alice-cache:/cache"],
        args: ["--verbose"],
    });
});

test("normalizeUserConfig requires hermesApiKey", () => {
    assert.throws(
        () => normalizeUserConfig("alice", "config/alice.json", { env: {} }),
        /missing hermesApiKey/u,
    );
});

test("authorize requires the configured bearer token", () => {
    const user = { apiKey: "secret" };
    assert.doesNotThrow(() => authorize({ headers: { authorization: "Bearer secret" } }, user));
    assert.throws(
        () => authorize({ headers: { authorization: "Bearer wrong" } }, user),
        (error) => error instanceof SwitchError && error.status === 401,
    );
});

test("forwardedHeaders removes hop headers and adds proxy metadata", () => {
    const headers = forwardedHeaders({
        headers: {
            connection: "upgrade, x-drop",
            host: "switch.local",
            "x-drop": "remove-me",
            authorization: "Bearer secret",
            "x-forwarded-for": "1.1.1.1",
        },
        socket: { remoteAddress: "2.2.2.2" },
    }, { host: "127.0.0.1", port: 23002, prefix: "/endpoint/alice" });

    assert.equal(headers.host, "127.0.0.1:23002");
    assert.equal(headers.authorization, "Bearer secret");
    assert.equal(headers["x-forwarded-for"], "1.1.1.1, 2.2.2.2");
    assert.equal(headers["x-forwarded-prefix"], "/endpoint/alice");
    assert.equal(headers["x-drop"], undefined);
    assert.equal(headers.connection, undefined);
});


test("parseForm reads admin form data", () => {
    assert.deepEqual(parseForm("userId=alice&password=Abcd1234"), {
        userId: "alice",
        password: "Abcd1234",
    });
});

test("adminCookieValue is stable", () => {
    assert.equal(adminCookieValue(), adminCookieValue());
    assert.ok(adminCookieValue().length > 20);
});


test("idle cleanup keeps Hermes containers with active tasks running", () => {
    const now = Date.UTC(2026, 0, 2, 2);
    const lastActiveAt = Date.UTC(2026, 0, 1);
    assert.equal(shouldStopIdleHermes({ State: { Running: true } }, true, lastActiveAt, now), false);
});

test("idle cleanup stops running Hermes containers only after tasks are idle", () => {
    const now = Date.UTC(2026, 0, 2, 2);
    assert.equal(shouldStopIdleHermes({ State: { Running: true } }, false, Date.UTC(2026, 0, 1), now), true);
    assert.equal(shouldStopIdleHermes({ State: { Running: true } }, false, Date.UTC(2026, 0, 2, 1, 30), now), false);
});

test("idle cleanup recycles containers whose Hermes stopped long ago", () => {
    const now = Date.UTC(2026, 0, 2, 2);
    assert.equal(shouldRecycleContainer({
        State: { Running: false, FinishedAt: new Date(Date.UTC(2026, 0, 1)).toISOString() },
    }, now), true);
    assert.equal(shouldRecycleContainer({
        State: { Running: false, FinishedAt: new Date(Date.UTC(2026, 0, 2, 1, 30)).toISOString() },
    }, now), false);
});

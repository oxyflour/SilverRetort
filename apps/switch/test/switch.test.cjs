const assert = require("node:assert/strict");
const test = require("node:test");

const {
    SwitchError,
    authorize,
    forwardedHeaders,
    parseEnv,
    parseRoute,
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

test("parseEnv reads quoted values from user config", () => {
    assert.deepEqual(parseEnv("# user\nHERMES_API_KEY='secret key'\nEMPTY=\n"), {
        HERMES_API_KEY: "secret key",
        EMPTY: "",
    });
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

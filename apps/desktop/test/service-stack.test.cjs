const assert = require("node:assert/strict");
const test = require("node:test");
const { buildUvicornEnv } = require("../src/service-stack.cjs");

test("remote switch URL is passed to uvicorn and its bridge", () => {
    const config = {
        dataDir: "C:/data",
        buildChildEnv: (overrides) => ({ BASE: "yes", ...overrides }),
    };
    const env = buildUvicornEnv(config, {
        mode: "remote",
        url: "https://switch.example/endpoint/alice",
        apiKey: "secret",
    }, 23001);
    assert.equal(env.HERMES_URL, "https://switch.example/endpoint/alice");
    assert.equal(env.HERMES_BRIDGE_URL, "wss://switch.example/endpoint/alice/bridge");
    assert.equal(env.HERMES_API_KEY, "secret");
    assert.equal(env.DATA_DIR, "C:/data");
});

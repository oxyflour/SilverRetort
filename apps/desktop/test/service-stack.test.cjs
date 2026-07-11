const assert = require("node:assert/strict");
const test = require("node:test");
const { buildUvicornEnv } = require("../src/service-stack.cjs");

test("dynamic Docker URL is passed to uvicorn and its bridge", () => {
    const config = {
        dataDir: "C:/data",
        buildChildEnv: (overrides) => ({ BASE: "yes", ...overrides }),
    };
    const env = buildUvicornEnv(config, {
        mode: "docker",
        url: "http://docker.example.test:49160",
        apiKey: "secret",
    }, 23001);
    assert.equal(env.HERMES_URL, "http://docker.example.test:49160");
    assert.equal(env.HERMES_BRIDGE_URL, "ws://docker.example.test:49160/bridge");
    assert.equal(env.HERMES_API_KEY, "secret");
    assert.equal(env.DATA_DIR, "C:/data");
});

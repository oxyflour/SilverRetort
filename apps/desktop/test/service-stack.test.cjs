const assert = require("node:assert/strict");
const test = require("node:test");
const { buildUvicornEnv, waitForHttpResponse } = require("../src/service-stack.cjs");

test("remote switch URL is passed to uvicorn and its bridge", () => {
    const config = {
        dataDir: "C:/data",
        templateRoot: "C:/templates",
        isPackaged: false,
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
    assert.equal(env.SILVERRETORT_TEMPLATE_ROOT, "C:/templates");
    assert.equal(env.SILVERRETORT_DESKTOP_MODE, "development");
    assert.equal(env.SILVERRETORT_HERMES_MODE, "remote");
});


test("local Hermes health accepts non-200 responses so first-run setup can open", async (t) => {
    const previousFetch = global.fetch;
    global.fetch = async () => new Response("missing model config", { status: 504 });
    t.after(() => { global.fetch = previousFetch; });

    const summary = await waitForHttpResponse("http://127.0.0.1:23002/health", {}, 1, 0);
    assert.equal(summary, "504: missing model config");
});

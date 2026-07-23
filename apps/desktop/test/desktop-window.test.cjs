const assert = require("node:assert/strict");
const test = require("node:test");
const { classifyWindowOpen, configureWindowOpenHandler } = require("../src/desktop-window.cjs");

test("classifyWindowOpen separates artifact routes from browser links", () => {
    const baseUrl = "http://127.0.0.1:23000";
    assert.equal(classifyWindowOpen(`${baseUrl}/artifacts/123`, baseUrl).kind, "artifact");
    assert.equal(classifyWindowOpen(`${baseUrl}/chat`, baseUrl).kind, "external");
    assert.equal(classifyWindowOpen("not a url", baseUrl).kind, "deny");
});

test("configureWindowOpenHandler opens external HTTP links in the system browser", () => {
    let handler;
    const opened = [];
    const window = {
        webContents: {
            setWindowOpenHandler(value) { handler = value; },
        },
    };
    configureWindowOpenHandler(window, "http://127.0.0.1:23000", {
        openExternal(url) { opened.push(url); },
    }, "missing-icon.png");

    assert.deepEqual(handler({ url: "https://example.test/docs" }), { action: "deny" });
    assert.deepEqual(opened, ["https://example.test/docs"]);
    const artifact = handler({ url: "http://127.0.0.1:23000/artifacts/123" });
    assert.equal(artifact.action, "allow");
    assert.equal(artifact.overrideBrowserWindowOptions.title, "Artifact");
});

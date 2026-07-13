// @ts-check
const { mkdirSync, rmSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 25 || (major === 25 && minor < 5)) {
    throw new Error("building a SEA requires Node.js 25.5 or newer");
}

const appDir = path.resolve(__dirname, "..");
const distDir = path.join(appDir, "dist");
const output = path.join(distDir, process.platform === "win32"
    ? "silverretort-switch.exe"
    : "silverretort-switch");
const configPath = path.join(distDir, "sea-config.json");

mkdirSync(distDir, { recursive: true });
writeFileSync(configPath, JSON.stringify({
    main: path.join(appDir, "switch.cjs"),
    mainFormat: "commonjs",
    output,
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
    execArgvExtension: "none",
}, null, 2));

try {
    const result = spawnSync(process.execPath, ["--build-sea", configPath], {
        cwd: appDir,
        stdio: "inherit",
    });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        process.exitCode = result.status ?? 1;
    }
} finally {
    rmSync(configPath, { force: true });
}

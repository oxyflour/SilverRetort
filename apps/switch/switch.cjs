#!/usr/bin/env node
// @ts-check
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { execFile } = require("node:child_process");

const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
const ROUTE_PATTERN = /^\/endpoint\/([^/]+)(\/.*)?$/u;
const STATUS_PATTERN = /^\/status\/([^/?#]+)\/?$/u;
const HOP_HEADERS = new Set([
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
]);
const recoveries = new Map();
const lastTraffic = new Map();

class SwitchError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function numberEnv(name, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
    const value = Number(process.env[name] || fallback);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${name} must be between ${minimum} and ${maximum}`);
    }
    return value;
}

function dockerHost() {
    const configured = `${process.env.HERMES_DOCKER_HOST || ""}`.trim();
    if (configured) return configured.replace(/^\[|\]$/gu, "");
    const endpoint = `${process.env.DOCKER_HOST || ""}`.trim();
    if (!endpoint || endpoint.startsWith("npipe:") || endpoint.startsWith("unix:")) {
        return "127.0.0.1";
    }
    try {
        return new URL(endpoint).hostname.replace(/^\[|\]$/gu, "");
    } catch {
        throw new Error(`cannot derive a host from DOCKER_HOST=${endpoint}`);
    }
}

const settings = Object.freeze({
    listenHost: process.env.SWITCH_HOST || "0.0.0.0",
    listenPort: numberEnv("SWITCH_PORT", 23004, 1, 65535),
    configDir: path.resolve(process.env.SWITCH_CONFIG_DIR || "config"),
    dockerCommand: process.env.DOCKER_COMMAND || "docker",
    dockerHost: dockerHost(),
    dockerImage: process.env.HERMES_DOCKER_IMAGE || "silverretort-hermes",
    containerPort: numberEnv("HERMES_CONTAINER_PORT", 23002, 1, 65535),
    dockerTimeout: numberEnv("SWITCH_DOCKER_TIMEOUT_MS", 30_000),
    healthTimeout: numberEnv("SWITCH_HEALTH_TIMEOUT_MS", 2_000),
    recoveryTimeout: numberEnv("SWITCH_RECOVERY_TIMEOUT_MS", 60_000),
    healthInterval: numberEnv("SWITCH_HEALTH_INTERVAL_MS", 500),
    idleStopMs: numberEnv("SWITCH_IDLE_STOP_MS", 60 * 60 * 1000),
    idleSweepMs: numberEnv("SWITCH_IDLE_SWEEP_MS", 60 * 1000),
});
if (!settings.dockerImage.trim()) throw new Error("HERMES_DOCKER_IMAGE must not be empty");

function runDocker(args, allowFailure = false) {
    return new Promise((resolve, reject) => {
        execFile(settings.dockerCommand, args, {
            encoding: "utf8",
            timeout: settings.dockerTimeout,
            maxBuffer: 4 * 1024 * 1024,
        }, (error, stdout, stderr) => {
            const result = { error, stdout: stdout.trim(), stderr: stderr.trim() };
            if (!error || allowFailure) return resolve(result);
            const message = result.stderr || result.stdout || error.message;
            reject(new SwitchError(502, `Docker command failed: ${message}`));
        });
    });
}

async function inspectContainer(name) {
    const result = await runDocker(["container", "inspect", name], true);
    if (result.error) {
        const message = result.stderr || result.stdout || result.error.message;
        if (/no such (object|container)/iu.test(message)) return null;
        throw new SwitchError(502, `Unable to inspect ${name}: ${message}`);
    }
    try {
        const containers = JSON.parse(result.stdout);
        if (containers.length !== 1) throw new Error("unexpected container count");
        return containers[0];
    } catch (error) {
        throw new SwitchError(502, `Invalid Docker inspect data for ${name}: ${error.message}`);
    }
}

function publishedPort(container, name, containerPort = settings.containerPort) {
    const key = `${containerPort}/tcp`;
    const bindings = container?.NetworkSettings?.Ports?.[key];
    if (!Array.isArray(bindings) || bindings.length === 0) {
        throw new SwitchError(502, `${name} does not publish ${key}`);
    }
    const ports = new Set(bindings.map((binding) => Number(binding.HostPort)));
    if (ports.size !== 1 || ![...ports].every((port) => Number.isInteger(port) && port > 0)) {
        throw new SwitchError(502, `${name} has ambiguous published ports for ${key}`);
    }
    return [...ports][0];
}

function checkHealth(port) {
    return new Promise((resolve) => {
        const request = http.get({
            host: settings.dockerHost,
            port,
            path: "/health",
            headers: { connection: "close" },
            timeout: settings.healthTimeout,
        }, (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode >= 200 && response.statusCode < 300));
        });
        request.once("timeout", () => request.destroy());
        request.once("error", () => resolve(false));
    });
}


function envArgs(env) {
    return Object.entries(env || {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
}

function volumeSpec(volume) {
    if (typeof volume === "string") return volume;
    if (volume && typeof volume === "object" && volume.source && volume.target) {
        return `${volume.source}:${volume.target}${volume.readOnly ? ":ro" : ""}`;
    }
    throw new SwitchError(500, "Invalid volume configuration");
}

function normalizeUserConfig(id, configPath, payload) {
    if (!payload || Array.isArray(payload) || typeof payload !== "object") {
        throw new SwitchError(500, "User configuration must be a JSON object");
    }
    const apiKey = `${payload.hermesApiKey || payload.HERMES_API_KEY || ""}`.trim();
    if (!apiKey) throw new SwitchError(500, "User configuration is missing hermesApiKey");
    const rawEnv = payload.env || {};
    if (!rawEnv || Array.isArray(rawEnv) || typeof rawEnv !== "object") {
        throw new SwitchError(500, "User configuration env must be an object");
    }
    const containerPort = Number(payload.containerPort || settings.containerPort);
    if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
        throw new SwitchError(500, "User configuration containerPort is invalid");
    }
    const env = Object.fromEntries(Object.entries(rawEnv).map(([key, value]) => [key, `${value}`]));
    env.HERMES_API_KEY = apiKey;
    return {
        id,
        configPath,
        apiKey,
        image: `${payload.image || settings.dockerImage}`.trim() || settings.dockerImage,
        containerPort,
        env,
        args: Array.isArray(payload.args) ? payload.args.map(String) : [],
        volumes: Array.isArray(payload.volumes) ? payload.volumes : [],
    };
}

function parseStatusRoute(rawTarget) {
    const pathname = rawTarget.split("?")[0];
    const match = STATUS_PATTERN.exec(pathname);
    if (!match) throw new SwitchError(404, "Expected /status/{userId}");
    let id;
    try {
        id = decodeURIComponent(match[1]);
    } catch {
        throw new SwitchError(400, "userId is not valid URL encoding");
    }
    if (!USER_ID_PATTERN.test(id)) throw new SwitchError(400, "userId contains unsupported characters");
    return { id };
}

function touchUser(userId, now = Date.now()) {
    lastTraffic.set(userId, now);
}

async function createContainer(user) {
    const name = `hermes-${user.id}`;
    console.log(`[switch] creating ${name}`);
    await runDocker([
        "run", "-d", "--name", name,
        "--label", "com.silverretort.switch=true",
        "--label", `com.silverretort.user=${user.id}`,
        "-p", `${user.containerPort || settings.containerPort}`,
        ...envArgs({
            WATCH_STDIN: "0",
            LISTEN_HOST: "0.0.0.0",
            LISTEN_PORT: `${user.containerPort || settings.containerPort}`,
            HERMES_RELAY_ENABLED: "1",
            HERMES_WORKSPACES_DIR: "/var/lib/silverretort/workspaces",
            HERMES_HOME: "/var/lib/silverretort/home",
            ...user.env,
        }),
        "-v", `${name}-workspaces:/var/lib/silverretort/workspaces`,
        "-v", `${name}-home:/var/lib/silverretort/home`,
        ...user.volumes.flatMap((volume) => ["-v", volumeSpec(volume)]),
        user.image,
        ...user.args,
    ]);
}

async function recoverContainer(name, running) {
    const action = running ? "restart" : "start";
    console.log(`[switch] ${action}ing ${name}`);
    await runDocker([action, name]);
}

async function ensureHealthyNow(user) {
    const name = `hermes-${user.id}`;
    let container = await inspectContainer(name);
    const created = container === null;
    if (created) {
        await createContainer(user);
        container = await inspectContainer(name);
        if (!container) throw new SwitchError(502, `${name} was not created`);
    }

    const running = Boolean(container.State?.Running);
    if (running) {
        try {
            const port = publishedPort(container, name, user.containerPort);
            if (await checkHealth(port)) return { host: settings.dockerHost, port };
        } catch (error) {
            if (!(error instanceof SwitchError)) throw error;
        }
    }
    if (!created) await recoverContainer(name, running);

    const deadline = Date.now() + settings.recoveryTimeout;
    let lastError = `${name} did not become healthy`;
    while (Date.now() < deadline) {
        container = await inspectContainer(name);
        if (!container) throw new SwitchError(502, `${name} disappeared during recovery`);
        if (container.State?.Running) {
            try {
                const port = publishedPort(container, name, user.containerPort);
                if (await checkHealth(port)) return { host: settings.dockerHost, port };
            } catch (error) {
                lastError = error.message;
            }
        } else {
            lastError = `${name} stopped during recovery (${container.State?.Status || "unknown"})`;
        }
        await new Promise((resolve) => setTimeout(resolve, settings.healthInterval));
    }
    throw new SwitchError(503, lastError);
}

function ensureHealthy(user) {
    const name = `hermes-${user.id}`;
    if (recoveries.has(name)) return recoveries.get(name);
    const recovery = ensureHealthyNow(user).finally(() => {
        if (recoveries.get(name) === recovery) recoveries.delete(name);
    });
    recoveries.set(name, recovery);
    return recovery;
}

function parseRoute(rawTarget) {
    const queryAt = rawTarget.indexOf("?");
    const pathname = queryAt === -1 ? rawTarget : rawTarget.slice(0, queryAt);
    const search = queryAt === -1 ? "" : rawTarget.slice(queryAt);
    const match = ROUTE_PATTERN.exec(pathname);
    if (!match) throw new SwitchError(404, "Expected /endpoint/{userId}[/path]");
    let id;
    try {
        id = decodeURIComponent(match[1]);
    } catch {
        throw new SwitchError(400, "userId is not valid URL encoding");
    }
    if (!USER_ID_PATTERN.test(id)) {
        throw new SwitchError(400, "userId contains unsupported characters");
    }
    return {
        id,
        prefix: `/endpoint/${match[1]}`,
        target: `${match[2] || "/"}${search}`,
    };
}

function parseEnv(text) {
    const values = {};
    for (const rawLine of text.split(/\r?\n/u)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const separator = line.indexOf("=");
        if (separator <= 0) continue;
        const key = line.slice(0, separator).trim();
        let value = line.slice(separator + 1).trim();
        if (value.length >= 2 && value[0] === value.at(-1) && [`"`, `'`].includes(value[0])) {
            value = value.slice(1, -1);
        }
        values[key] = value;
    }
    return values;
}

async function resolveUser(route) {
    const configPath = path.join(settings.configDir, `${route.id}.json`);
    let text;
    try {
        text = await fs.readFile(configPath, "utf8");
    } catch (error) {
        if (error.code === "ENOENT") throw new SwitchError(404, "No configuration for user");
        throw new SwitchError(500, "Unable to read user configuration");
    }
    let payload;
    try {
        payload = JSON.parse(text);
    } catch {
        throw new SwitchError(500, "User configuration is invalid JSON");
    }
    return { ...route, ...normalizeUserConfig(route.id, configPath, payload) };
}

function authorize(request, user) {
    const match = /^Bearer\s+(.+)$/iu.exec(`${request.headers.authorization || ""}`);
    const actual = Buffer.from(match?.[1] || "");
    const expected = Buffer.from(user.apiKey);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
        throw new SwitchError(401, "Unauthorized");
    }
}

function connectionTokens(headers) {
    return new Set(`${headers.connection || ""}`.split(",").map((part) => part.trim().toLowerCase()));
}

function forwardedHeaders(request, target, upgrade = false) {
    const headers = {};
    const tokens = connectionTokens(request.headers);
    for (const [key, value] of Object.entries(request.headers)) {
        if (value === undefined || key === "host" || key === "expect") continue;
        if (!upgrade && (HOP_HEADERS.has(key) || tokens.has(key))) continue;
        if (["x-forwarded-for", "x-forwarded-prefix", "x-forwarded-proto"].includes(key)) continue;
        headers[key] = value;
    }
    const remote = request.socket.remoteAddress || "unknown";
    const prior = `${request.headers["x-forwarded-for"] || ""}`.trim();
    headers.host = target.host.includes(":") ? `[${target.host}]:${target.port}` : `${target.host}:${target.port}`;
    headers["x-forwarded-for"] = prior ? `${prior}, ${remote}` : remote;
    headers["x-forwarded-prefix"] = target.prefix;
    headers["x-forwarded-proto"] = request.socket.encrypted ? "https" : "http";
    return headers;
}

function responseHeaders(headers) {
    const filtered = {};
    const tokens = connectionTokens(headers);
    for (const [key, value] of Object.entries(headers)) {
        if (value !== undefined && !HOP_HEADERS.has(key) && !tokens.has(key)) filtered[key] = value;
    }
    return filtered;
}

function sendJson(response, status, payload) {
    if (response.headersSent) return response.destroy();
    const body = Buffer.from(JSON.stringify(payload));
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": body.length,
        connection: "close",
    });
    response.end(response.req?.method === "HEAD" ? undefined : body);
}

function proxyHttp(request, response, user, target) {
    const upstream = http.request({
        host: target.host,
        port: target.port,
        method: request.method,
        path: user.target,
        headers: forwardedHeaders(request, { ...target, prefix: user.prefix }),
        agent: false,
    }, (upstreamResponse) => {
        response.writeHead(
            upstreamResponse.statusCode || 502,
            upstreamResponse.statusMessage,
            responseHeaders(upstreamResponse.headers),
        );
        upstreamResponse.pipe(response);
    });
    upstream.once("error", (error) => sendJson(response, 502, { error: `Upstream request failed: ${error.message}` }));
    request.once("aborted", () => upstream.destroy());
    request.pipe(upstream);
}

function socketResponse(socket, status, message, headers = [], body = Buffer.alloc(0)) {
    const reason = http.STATUS_CODES[status] || "Error";
    let head = `HTTP/1.1 ${status} ${reason}\r\n`;
    for (let index = 0; index < headers.length; index += 2) {
        head += `${headers[index]}: ${headers[index + 1]}\r\n`;
    }
    if (
        status !== 101
        && !headers.some((value, index) => index % 2 === 0 && value.toLowerCase() === "content-length")
    ) {
        head += `Content-Length: ${body.length}\r\n`;
    }
    if (message === "close") head += "Connection: close\r\n";
    socket.write(`${head}\r\n`);
    if (body.length) socket.write(body);
    if (message === "close") socket.end();
}

function safeRawHeaders(rawHeaders) {
    const headers = [];
    for (let index = 0; index < rawHeaders.length; index += 2) {
        const key = rawHeaders[index].toLowerCase();
        if (!HOP_HEADERS.has(key) && key !== "content-length") {
            headers.push(rawHeaders[index], rawHeaders[index + 1]);
        }
    }
    return headers;
}

async function handleUpgrade(request, socket, head) {
    socket.pause();
    try {
        const user = await resolveUser(parseRoute(request.url || "/"));
        authorize(request, user);
        touchUser(user.id);
        const target = await ensureHealthy(user);
        const upstream = http.request({
            host: target.host,
            port: target.port,
            method: request.method,
            path: user.target,
            headers: forwardedHeaders(request, { ...target, prefix: user.prefix }, true),
            agent: false,
        });
        let upgraded = false;
        upstream.once("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
            upgraded = true;
            socketResponse(socket, upstreamResponse.statusCode || 101, "keep", upstreamResponse.rawHeaders);
            if (upstreamHead.length) socket.write(upstreamHead);
            if (head.length) upstreamSocket.write(head);
            socket.pipe(upstreamSocket).pipe(socket);
            socket.resume();
            upstreamSocket.once("error", () => socket.destroy());
            socket.once("error", () => upstreamSocket.destroy());
            socket.once("close", () => upstreamSocket.destroy());
        });
        upstream.once("response", (upstreamResponse) => {
            const chunks = [];
            upstreamResponse.on("data", (chunk) => chunks.push(chunk));
            upstreamResponse.once("end", () => socketResponse(
                socket,
                upstreamResponse.statusCode || 502,
                "close",
                safeRawHeaders(upstreamResponse.rawHeaders),
                Buffer.concat(chunks),
            ));
        });
        upstream.once("error", (error) => {
            if (upgraded) return socket.destroy();
            socketResponse(socket, 502, "close", ["Content-Type", "text/plain"], Buffer.from(error.message));
        });
        socket.once("close", () => upstream.destroy());
        upstream.end();
    } catch (error) {
        const status = error instanceof SwitchError ? error.status : 500;
        socketResponse(socket, status, "close", ["Content-Type", "text/plain"], Buffer.from(error.message));
    }
}


function escapeHtml(value) {
    return `${value}`.replace(/[&<>"']/gu, (char) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[char]));
}

async function renderStatusPage(route) {
    const user = await resolveUser({ ...route, prefix: `/status/${encodeURIComponent(route.id)}`, target: "/" });
    const name = `hermes-${user.id}`;
    const container = await inspectContainer(name);
    const last = lastTraffic.get(user.id);
    const state = container?.State?.Status || "not created";
    const rows = [
        ["User", user.id],
        ["Container", name],
        ["State", state],
        ["Image", user.image],
        ["Config", user.configPath],
        ["Last traffic", last ? new Date(last).toISOString() : "never"],
    ];
    return `<!doctype html><html><head><meta charset="utf-8"><title>Hermes ${escapeHtml(user.id)}</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem;line-height:1.5}td{padding:.35rem .75rem;border-bottom:1px solid #ddd}td:first-child{font-weight:600}</style>
</head><body><h1>Hermes user status</h1><table>${rows.map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`).join("")}</table></body></html>`;
}

function sendHtml(response, status, html) {
    const body = Buffer.from(html);
    response.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "content-length": body.length,
        connection: "close",
    });
    response.end(response.req?.method === "HEAD" ? undefined : body);
}

async function stopIdleContainers(now = Date.now()) {
    for (const [userId, last] of lastTraffic) {
        if (now - last <= settings.idleStopMs) continue;
        const name = `hermes-${userId}`;
        const container = await inspectContainer(name);
        if (container?.State?.Running) {
            console.log(`[switch] stopping idle ${name}`);
            await runDocker(["stop", name], true);
        }
        lastTraffic.delete(userId);
    }
}

async function handleRequest(request, response) {
    if (["GET", "HEAD"].includes(request.method) && request.url === "/health") {
        return sendJson(response, 200, { status: "ok" });
    }
    if (["GET", "HEAD"].includes(request.method) && (request.url || "").startsWith("/status/")) {
        try {
            return sendHtml(response, 200, await renderStatusPage(parseStatusRoute(request.url || "/")));
        } catch (error) {
            const status = error instanceof SwitchError ? error.status : 500;
            return sendHtml(response, status, `<p>${escapeHtml(error.message)}</p>`);
        }
    }
    try {
        const user = await resolveUser(parseRoute(request.url || "/"));
        authorize(request, user);
        touchUser(user.id);
        const target = await ensureHealthy(user);
        proxyHttp(request, response, user, target);
    } catch (error) {
        request.resume();
        const status = error instanceof SwitchError ? error.status : 500;
        sendJson(response, status, { error: error.message });
    }
}

function createServer() {
    const server = http.createServer(handleRequest);
    server.requestTimeout = 0;
    server.on("upgrade", handleUpgrade);
    server.on("clientError", (_error, socket) => socketResponse(socket, 400, "close"));
    return server;
}

function startServer() {
    const server = createServer();
    server.listen(settings.listenPort, settings.listenHost, () => {
        console.log(
            `[switch] listening on http://${settings.listenHost}:${settings.listenPort}; `
            + `configs=${settings.configDir}; docker=${settings.dockerHost}`,
        );
    });
    const idleTimer = setInterval(() => {
        void stopIdleContainers().catch((error) => console.warn(`[switch] idle cleanup failed: ${error.message}`));
    }, settings.idleSweepMs);
    idleTimer.unref?.();
    for (const signal of ["SIGINT", "SIGTERM"]) {
        process.once(signal, () => {
            clearInterval(idleTimer);
            server.close(() => process.exit(0));
        });
    }
    return server;
}

if (require.main === module) {
    startServer();
}

module.exports = {
    SwitchError,
    authorize,
    connectionTokens,
    createServer,
    forwardedHeaders,
    normalizeUserConfig,
    parseEnv,
    parseRoute,
    parseStatusRoute,
    responseHeaders,
    stopIdleContainers,
    touchUser,
    startServer,
};

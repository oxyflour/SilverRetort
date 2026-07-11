// @ts-check
const net = require("node:net");
const os = require("node:os");

const MANAGED_LABEL = "com.silverretort.managed";
const OWNER_LABEL = "com.silverretort.owner";

function canonicalizeDockerUser(value) {
    const canonical = `${value || ""}`.normalize("NFKC").trim().toLowerCase();
    if (!canonical) {
        throw new Error("hermesDockerUser must not be empty");
    }
    return canonical;
}

function toDockerNamePart(value, fallback) {
    const part = `${value || ""}`
        .normalize("NFKC")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-+|-+$/gu, "")
        .slice(0, 32);
    return part || fallback;
}

function resolveDockerIdentity(settings, hashSuffix, getUsername = () => os.userInfo().username) {
    if (Object.prototype.hasOwnProperty.call(settings, "hermesDockerContainerName")) {
        throw new Error(
            "hermesDockerContainerName is no longer supported; use hermesDockerContainerPrefix instead",
        );
    }
    const configuredUser = Object.prototype.hasOwnProperty.call(settings, "hermesDockerUser")
        ? settings.hermesDockerUser
        : getUsername();
    const canonicalUser = canonicalizeDockerUser(configuredUser);
    const userSlug = toDockerNamePart(canonicalUser, "user");
    const ownerHash = hashSuffix(canonicalUser);
    const configuredPrefix = Object.prototype.hasOwnProperty.call(settings, "hermesDockerContainerPrefix")
        ? settings.hermesDockerContainerPrefix
        : "silverretort-hermes";
    const prefix = toDockerNamePart(configuredPrefix, "");
    if (!prefix) {
        throw new Error("hermesDockerContainerPrefix must contain Docker-safe characters");
    }
    return {
        canonicalUser,
        userSlug,
        ownerHash,
        containerName: `${prefix}-${userSlug}-${ownerHash}`,
    };
}

function normalizeDockerHost(value) {
    const raw = `${value || ""}`.trim();
    if (!raw) {
        throw new Error("hermesDockerHost must not be empty");
    }
    if (/\s/u.test(raw) || raw.includes("://") || raw.includes("/") || raw.includes("@")) {
        throw new Error(`invalid hermesDockerHost: ${raw}`);
    }
    if (raw.startsWith("[") && raw.endsWith("]")) {
        const address = raw.slice(1, -1);
        if (net.isIP(address) !== 6) {
            throw new Error(`invalid hermesDockerHost: ${raw}`);
        }
        return address;
    }
    if (net.isIP(raw)) {
        return raw;
    }
    if (raw.includes(":")) {
        throw new Error(`hermesDockerHost must not include a port: ${raw}`);
    }
    const parsed = new URL(`http://${raw}`);
    if (parsed.hostname !== raw.toLowerCase() || parsed.port || parsed.pathname !== "/") {
        throw new Error(`invalid hermesDockerHost: ${raw}`);
    }
    return parsed.hostname;
}

function hostFromDockerEndpoint(endpoint) {
    const raw = `${endpoint || ""}`.trim();
    if (!raw) {
        throw new Error("Docker endpoint is empty; set hermesDockerHost explicitly");
    }
    if (raw.startsWith("npipe:") || raw.startsWith("unix:")) {
        return "127.0.0.1";
    }
    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error(`cannot derive public host from Docker endpoint ${raw}; set hermesDockerHost explicitly`);
    }
    if (!["ssh:", "tcp:", "http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
        throw new Error(`cannot derive public host from Docker endpoint ${raw}; set hermesDockerHost explicitly`);
    }
    return parsed.hostname.replace(/^\[|\]$/gu, "");
}

function parsePublishedPort(output) {
    const ports = new Set();
    for (const rawLine of `${output || ""}`.split(/\r?\n/u)) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }
        const match = line.match(/:(\d+)$/u);
        if (!match) {
            throw new Error(`unexpected docker port output: ${line}`);
        }
        const port = Number(match[1]);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
            throw new Error(`invalid Docker published port: ${match[1]}`);
        }
        ports.add(port);
    }
    if (ports.size !== 1) {
        throw new Error(ports.size === 0
            ? "Docker did not publish a Hermes port"
            : `Docker returned conflicting Hermes ports: ${[...ports].join(", ")}`);
    }
    return [...ports][0];
}

function buildDockerUrl(host, port) {
    const formattedHost = net.isIP(host) === 6 ? `[${host}]` : host;
    return `http://${formattedHost}:${port}`;
}

function waitForExit(proc) {
    return new Promise((resolve, reject) => {
        proc.once("error", reject);
        proc.once("exit", (code, signal) => resolve({ code, signal }));
    });
}

async function runDockerCommand(docker, config, supervisor, spawn, args, label, options = {}) {
    const proc = spawn(docker.command, args, {
        cwd: config.serviceRoot,
        env: config.buildChildEnv(),
        stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (data) => { stdout += `${data}`; });
    proc.stderr?.on("data", (data) => { stderr += `${data}`; });
    supervisor.monitor(label, proc, {
        critical: false,
        cleanup: options.cleanup !== false,
    });
    const { code } = await waitForExit(proc);
    if (code !== 0 && !options.allowFailure) {
        throw new Error(`${label} failed (${code}): ${(stderr || stdout).trim() || "unknown error"}`);
    }
    return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function resolveDockerPublicHost(docker, config, supervisor, spawn) {
    if (docker.configuredHost) {
        return docker.configuredHost;
    }
    const configuredEndpoint = `${config.processEnv.DOCKER_HOST || ""}`.trim();
    if (configuredEndpoint) {
        return hostFromDockerEndpoint(configuredEndpoint);
    }
    const shown = await runDockerCommand(
        docker, config, supervisor, spawn,
        ["context", "show"], "docker-context-show",
    );
    if (!shown.stdout) {
        throw new Error("docker context show returned an empty context name");
    }
    const inspected = await runDockerCommand(
        docker, config, supervisor, spawn,
        ["context", "inspect", shown.stdout, "--format", "{{.Endpoints.docker.Host}}"],
        "docker-context-inspect",
    );
    return hostFromDockerEndpoint(inspected.stdout);
}

async function removeOwnedStaleContainer(docker, config, supervisor, spawn) {
    const listed = await runDockerCommand(
        docker, config, supervisor, spawn,
        ["container", "ls", "-a", "--filter", `name=^/${docker.containerName}$`, "--format", "{{.ID}}"],
        "hermes-docker-find",
    );
    const ids = listed.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
    if (ids.length === 0) {
        return;
    }
    if (ids.length !== 1) {
        throw new Error(`multiple Docker containers matched ${docker.containerName}`);
    }
    const containerId = ids[0];
    const inspected = await runDockerCommand(
        docker, config, supervisor, spawn,
        [
            "inspect",
            "--format",
            `{{index .Config.Labels "${MANAGED_LABEL}"}}|{{index .Config.Labels "${OWNER_LABEL}"}}`,
            containerId,
        ],
        "hermes-docker-inspect-owner",
    );
    if (inspected.stdout !== `true|${docker.ownerHash}`) {
        throw new Error(
            `refusing to remove container ${docker.containerName}: managed/owner labels do not match current user`,
        );
    }
    await runDockerCommand(
        docker, config, supervisor, spawn,
        ["rm", "-f", containerId], "hermes-docker-remove-stale",
    );
}

async function startManagedDocker(docker, config, supervisor, spawn) {
    const publicHost = await resolveDockerPublicHost(docker, config, supervisor, spawn);
    await removeOwnedStaleContainer(docker, config, supervisor, spawn);
    const started = await runDockerCommand(
        docker, config, supervisor, spawn,
        docker.runArgs, "hermes-docker",
    );
    const containerId = started.stdout;
    if (!/^[a-f0-9]{12,64}$/u.test(containerId)) {
        throw new Error(`docker run returned an invalid container ID: ${containerId || "empty"}`);
    }

    supervisor.addCleanup(async () => {
        await runDockerCommand(
            docker, config, supervisor, spawn,
            ["rm", "-f", containerId], "hermes-docker-stop",
            { allowFailure: true, cleanup: false },
        );
    });

    const published = await runDockerCommand(
        docker, config, supervisor, spawn,
        ["port", containerId, `${docker.containerPort}/tcp`], "hermes-docker-port",
    );
    const publicPort = parsePublishedPort(published.stdout);
    const url = buildDockerUrl(publicHost, publicPort);

    const logsProc = spawn(docker.command, ["logs", "-f", containerId], {
        cwd: config.serviceRoot,
        env: config.buildChildEnv(),
        stdio: "pipe",
    });
    supervisor.monitor("hermes-docker-logs", logsProc, { critical: false });
    const waitProc = spawn(docker.command, ["wait", containerId], {
        cwd: config.serviceRoot,
        env: config.buildChildEnv(),
        stdio: "pipe",
    });
    supervisor.monitor(`hermes docker container ${docker.containerName}`, waitProc);
    return { containerId, logsProc, publicHost, publicPort, url, waitProc };
}

module.exports = {
    MANAGED_LABEL,
    OWNER_LABEL,
    buildDockerUrl,
    canonicalizeDockerUser,
    hostFromDockerEndpoint,
    normalizeDockerHost,
    parsePublishedPort,
    removeOwnedStaleContainer,
    resolveDockerIdentity,
    resolveDockerPublicHost,
    runDockerCommand,
    startManagedDocker,
    toDockerNamePart,
};

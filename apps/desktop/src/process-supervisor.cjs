// @ts-check

/**
 * @param {string} label
 * @param {unknown} data
 * @param {Pick<Console, "log">} logger
 */
function logWithLabel(label, data, logger = console) {
    for (const line of `${data}`.split("\n")) {
        if (line) {
            logger.log(`[${label}] ${line}`);
        }
    }
}

function defaultStop(proc) {
    if (!proc.killed && typeof proc.kill === "function") {
        proc.kill();
    }
}

/**
 * @param {{
 *   onUnexpectedExit: (details: {label: string, code: number | null, signal: string | null}) => void,
 *   logger?: Pick<Console, "log" | "error">,
 * }} options
 */
function createProcessSupervisor({ onUnexpectedExit, logger = console }) {
    /** @type {Array<() => void | Promise<void>>} */
    let cleanupHooks = [];
    let shuttingDown = false;
    /** @type {Promise<void> | null} */
    let shutdownPromise = null;

    function addCleanup(fn) {
        cleanupHooks.push(fn);
    }

    /**
     * @param {string} label
     * @param {NodeJS.EventEmitter & {stdout?: NodeJS.ReadableStream | null, stderr?: NodeJS.ReadableStream | null, killed?: boolean, kill?: () => unknown}} proc
     * @param {{critical?: boolean, stop?: (proc: any) => void | Promise<void>}=} options
     */
    function monitor(label, proc, { critical = true, stop = defaultStop } = {}) {
        let exited = false;
        proc.stdout?.on("data", (data) => logWithLabel(label, data, logger));
        proc.stderr?.on("data", (data) => logWithLabel(label, data, logger));
        proc.addListener("error", (error) => {
            logger.error(`[main] ERR: ${label} failed`, error);
        });
        proc.addListener("exit", (code, signal) => {
            exited = true;
            logger.log(`[main] BYE: ${label} quit (code=${code}, signal=${signal})`);
            if (critical && !shuttingDown) {
                onUnexpectedExit({ label, code, signal });
            }
        });
        addCleanup(async () => {
            if (!exited) {
                await stop(proc);
            }
        });
        return proc;
    }

    function shutdown() {
        if (shutdownPromise) {
            return shutdownPromise;
        }
        shuttingDown = true;
        const hooks = cleanupHooks.reverse();
        cleanupHooks = [];
        shutdownPromise = (async () => {
            for (const hook of hooks) {
                try {
                    await hook();
                } catch (error) {
                    logger.error("[main] shutdown hook failed", error);
                }
            }
        })();
        return shutdownPromise;
    }

    return {
        addCleanup,
        monitor,
        shutdown,
        get isShuttingDown() {
            return shuttingDown;
        },
    };
}

module.exports = {
    createProcessSupervisor,
    logWithLabel,
};

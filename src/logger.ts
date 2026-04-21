import type { DataAdapter } from "obsidian";

const LOG_PATH = ".obsidian/plugins/github-stars/debug.log";
const PREFIX = "[github-stars]";

let adapter: DataAdapter | undefined;
let writeQueue = Promise.resolve();

function serializeContext(context?: unknown): string {
    if (typeof context === "undefined") {
        return "";
    }

    try {
        return ` ${JSON.stringify(context)}`;
    } catch {
        return ` ${String(context)}`;
    }
}

function enqueue(line: string) {
    console.error(line);

    if (!adapter) {
        return;
    }

    const currentAdapter = adapter;

    writeQueue = writeQueue
        .catch(() => undefined)
        .then(async () => {
            try {
                let content = "";
                try {
                    content = await currentAdapter.read(LOG_PATH);
                } catch {
                    content = "";
                }

                await currentAdapter.write(LOG_PATH, `${content}${line}\n`);
            } catch (error) {
                console.error(
                    `${PREFIX} failed to write debug log`,
                    String(error),
                );
            }
        });
}

function log(
    level: "INFO" | "WARN" | "ERROR",
    message: string,
    context?: unknown,
) {
    const timestamp = new Date().toISOString();
    enqueue(
        `${PREFIX} ${timestamp} ${level} ${message}${serializeContext(context)}`,
    );
}

export function configureLogger(nextAdapter: DataAdapter) {
    adapter = nextAdapter;
}

export async function resetDebugLog(header?: string) {
    if (!adapter) {
        return;
    }

    const currentAdapter = adapter;

    const firstLine = header
        ? `${PREFIX} ${new Date().toISOString()} INFO ${header}\n`
        : "";
    await currentAdapter.write(LOG_PATH, firstLine);
}

export function logInfo(message: string, context?: unknown) {
    log("INFO", message, context);
}

export function logWarn(message: string, context?: unknown) {
    log("WARN", message, context);
}

export function logError(message: string, context?: unknown) {
    log("ERROR", message, context);
}

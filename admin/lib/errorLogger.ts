/**
 * Global Error Logger
 * Captures all errors (console, unhandled rejections, network) and persists them to sessionStorage
 * Visible in browser console and can be retrieved even if logs are cleared
 */

interface LogEntry {
  timestamp: string;
  level: "error" | "warn" | "info";
  source: "console" | "promise" | "network" | "custom";
  message: string;
  details?: Record<string, unknown>;
  stack?: string;
}

const MAX_LOGS = 50;
const STORAGE_KEY = "error_logs";

function getLogs(): LogEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function saveLogs(logs: LogEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    // Keep only last MAX_LOGS entries
    const trimmed = logs.slice(-MAX_LOGS);
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch (e) {
    console.warn("Failed to save logs to sessionStorage", e);
  }
}

export function addLog(entry: Omit<LogEntry, "timestamp">): void {
  const log: LogEntry = {
    ...entry,
    timestamp: new Date().toISOString(),
  };

  const logs = getLogs();
  logs.push(log);
  saveLogs(logs);

  // Also log to console with color coding
  const color =
    entry.level === "error"
      ? "color: red; font-weight: bold;"
      : entry.level === "warn"
        ? "color: orange; font-weight: bold;"
        : "color: blue;";
  console.log(
    `%c[${entry.source.toUpperCase()}] ${entry.message}`,
    color,
    entry.details || ""
  );
}

export function getLiveErrors(): LogEntry[] {
  return getLogs();
}

export function clearLogs(): void {
  if (typeof window !== "undefined") {
    sessionStorage.removeItem(STORAGE_KEY);
  }
}

/**
 * Initialize global error listeners
 * Call this once at app startup (in layout.tsx or root client component)
 */
function isResizeObserverNoise(message: string): boolean {
  return (
    message.includes("ResizeObserver loop completed") ||
    message.includes("ResizeObserver loop limit exceeded")
  );
}

function isCanceledPromiseNoise(error: unknown): boolean {
  const asRecord = typeof error === "object" && error !== null
    ? (error as Record<string, unknown>)
    : null;

  const message =
    typeof error === "string"
      ? error
      : typeof asRecord?.message === "string"
        ? asRecord.message
        : "";

  const code = typeof asRecord?.code === "string" ? asRecord.code : "";
  const name = typeof asRecord?.name === "string" ? asRecord.name : "";

  return (
    code === "ERR_CANCELED" ||
    name === "CanceledError" ||
    name === "AbortError" ||
    message.toLowerCase() === "canceled"
  );
}

export function initGlobalErrorLogger(): void {
    if ((window as Window & { __errorLoggerInit?: boolean }).__errorLoggerInit) return;
    (window as Window & { __errorLoggerInit?: boolean }).__errorLoggerInit = true;
  if (typeof window === "undefined") return;

  // Suppress ResizeObserver noise at the console.error level (Chrome emits it
  // both as a window error event AND as an internal console.error call).
  const _origConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    const msg = args[0];
    if (typeof msg === "string" && isResizeObserverNoise(msg)) return;
    _origConsoleError(...args);
  };

  // Capture unhandled promise rejections
  window.addEventListener("unhandledrejection", (event) => {
    const error = event.reason;
    if (isCanceledPromiseNoise(error)) {
      event.preventDefault();
      return;
    }

    addLog({
      level: "error",
      source: "promise",
      message: "Unhandled Promise Rejection",
      details: {
        reason:
          error instanceof Error
            ? error.message
            : String(error),
        type: error?.constructor?.name,
      },
      stack:
        error instanceof Error ? error.stack : undefined,
    });
  });

  // Capture uncaught errors
  window.addEventListener("error", (event) => {
    // ResizeObserver loop notifications are benign browser-level warnings
    // emitted by ReactFlow's internal node-size observers; suppress them.
    if (event.message && isResizeObserverNoise(event.message)) {
      event.stopImmediatePropagation();
      return;
    }

    addLog({
      level: "error",
      source: "console",
      message: event.message,
      details: {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      },
      stack: event.error?.stack,
    });
  });

  console.log(
    "%c✓ Global Error Logger initialized",
    "color: green; font-weight: bold;"
  );
}

/**
 * Hook to display error logs in dev console
 */
export function logErrorsToConsole(): void {
  const logs = getLiveErrors();
  if (logs.length === 0) {
    console.log("No errors logged yet");
    return;
  }

  console.table(
    logs.map((log) => ({
      Time: log.timestamp.split("T")[1].slice(0, 8),
      Level: log.level.toUpperCase(),
      Source: log.source.toUpperCase(),
      Message: log.message,
      Details: log.details ? JSON.stringify(log.details) : "-",
    }))
  );
}

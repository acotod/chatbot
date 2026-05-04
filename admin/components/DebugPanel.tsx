"use client";

import { useEffect, useState } from "react";
import { getLiveErrors, clearLogs } from "@/lib/errorLogger";

interface LogEntry {
  timestamp: string;
  level: "error" | "warn" | "info";
  source: string;
  message: string;
  details?: Record<string, unknown>;
}

export function DebugPanel() {
  const [isOpen, setIsOpen] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  useEffect(() => {
    // Refresh logs every 500ms
    const interval = setInterval(() => {
      setLogs(getLiveErrors());
    }, 500);

    return () => clearInterval(interval);
  }, []);

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-4 right-4 z-50 bg-red-500 hover:bg-red-600 text-white px-3 py-2 rounded-lg text-xs font-semibold transition-all shadow-lg"
        title="Click to open error debug panel"
      >
        🐛 Debug ({logs.length})
      </button>
    );
  }

  const errorCount = logs.filter((l) => l.level === "error").length;
  const warnCount = logs.filter((l) => l.level === "warn").length;

  return (
    <div className="fixed bottom-4 right-4 z-50 w-96 max-h-96 bg-white border-2 border-red-500 rounded-lg shadow-2xl overflow-hidden flex flex-col">
      {/* Header */}
      <div className="bg-red-500 text-white px-4 py-3 flex justify-between items-center">
        <div className="font-semibold text-sm">Error Debug Panel</div>
        <div className="flex gap-2 items-center text-xs">
          <span className="bg-red-600 px-2 py-1 rounded">E: {errorCount}</span>
          <span className="bg-yellow-600 px-2 py-1 rounded">W: {warnCount}</span>
          <button
            onClick={() => clearLogs()}
            className="bg-gray-700 hover:bg-gray-800 px-2 py-1 rounded transition-all"
            title="Clear logs"
          >
            Clear
          </button>
          <button
            onClick={() => setIsOpen(false)}
            className="text-lg leading-none hover:opacity-70"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Logs */}
      <div className="overflow-y-auto flex-1 bg-gray-50 text-xs font-mono">
        {logs.length === 0 ? (
          <div className="p-3 text-gray-500">No errors logged yet</div>
        ) : (
          logs.map((log, idx) => (
            <div
              key={idx}
              className={`border-b px-3 py-2 ${
                log.level === "error"
                  ? "bg-red-50 border-red-200"
                  : log.level === "warn"
                    ? "bg-yellow-50 border-yellow-200"
                    : "bg-blue-50 border-blue-200"
              }`}
            >
              <div className="flex gap-2 items-start">
                <span
                  className={`font-bold whitespace-nowrap ${
                    log.level === "error"
                      ? "text-red-600"
                      : log.level === "warn"
                        ? "text-yellow-600"
                        : "text-blue-600"
                  }`}
                >
                  [{log.level.toUpperCase()}]
                </span>
                <div className="flex-1">
                  <div className="text-gray-600 break-words">{log.message}</div>
                  <div className="text-gray-500 text-xs mt-1">
                    {log.source} • {log.timestamp.split("T")[1].slice(0, 8)}
                  </div>
                  {log.details && (
                    <details className="mt-2 cursor-pointer">
                      <summary className="text-gray-600 hover:text-gray-800">
                        Details
                      </summary>
                      <pre className="text-xs bg-white p-2 mt-1 border border-gray-200 rounded max-h-24 overflow-auto">
                        {JSON.stringify(log.details, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

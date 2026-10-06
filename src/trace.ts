import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface TraceLogger {
  path: string;
  runId: string;
  log(event: string, data?: Record<string, unknown>): Promise<void>;
}

export function createTraceLogger(
  path: string,
  options: { onLine?: (line: string) => void | Promise<void> } = {},
): TraceLogger {
  const runId = randomUUID();
  let pendingWrite = Promise.resolve();

  return {
    path,
    runId,
    log(event, data = {}) {
      const line = `${JSON.stringify({
        timestamp: new Date().toISOString(),
        runId,
        event,
        ...data,
      })}\n`;
      pendingWrite = pendingWrite.then(async () => {
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, line, "utf8");
        await options.onLine?.(line);
      });
      return pendingWrite;
    },
  };
}

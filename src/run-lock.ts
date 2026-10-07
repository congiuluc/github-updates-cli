import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { isRecord } from "./storage.js";

interface LockOwner {
  pid: number;
  hostname: string;
  token: string;
}

interface LockSnapshot {
  state: "active" | "stale" | "unknown";
  reason: string;
  content?: string;
  owner?: LockOwner;
  device?: number;
  inode?: number;
}

const hasCode = (error: unknown, code: string) =>
  error instanceof Error && "code" in error && error.code === code;

function newOwner(): string {
  return JSON.stringify({ pid: process.pid, hostname: hostname(), token: randomUUID() } satisfies LockOwner);
}

/** Treat permission-denied PID probes as active; a foreign host cannot be probed locally. */
async function inspectLock(path: string): Promise<LockSnapshot | undefined> {
  let metadata;
  try { metadata = await lstat(path); }
  catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 4096) {
    return { state: "unknown", reason: "Not a regular single-link run-lock file (directories and symbolic links are not recoverable)" };
  }
  const content = await readFile(path, "utf8");
  let value: unknown;
  try { value = JSON.parse(content); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { state: "unknown", reason: "The lock contains incomplete or malformed ownership data" };
  }
  if (!isRecord(value) || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) ||
    value.pid < 1 || value.pid > 2_147_483_647 || typeof value.hostname !== "string" ||
    typeof value.token !== "string" || !value.token.trim()) {
    return { state: "unknown", reason: "The lock has no verifiable owner" };
  }
  const owner: LockOwner = { pid: value.pid, hostname: value.hostname, token: value.token };
  const snapshot = { content, owner, device: metadata.dev, inode: metadata.ino };
  if (owner.hostname !== hostname()) {
    return { ...snapshot, state: "unknown", reason: `The lock belongs to another host (${owner.hostname})` };
  }
  try {
    process.kill(owner.pid, 0);
    return { ...snapshot, state: "active", reason: `A run is already running (PID ${owner.pid})` };
  } catch (error) {
    if (hasCode(error, "ESRCH")) return { ...snapshot, state: "stale", reason: `A stale run lock from PID ${owner.pid} was found` };
    if (hasCode(error, "EPERM")) return { ...snapshot, state: "active", reason: `A run is already running or protected (PID ${owner.pid})` };
    throw error;
  }
}

async function assertNoRecovery(path: string): Promise<void> {
  const recovery = `${path}.recovery`;
  try { await lstat(recovery); }
  catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  throw new Error(`Lock recovery is in progress: ${recovery}. Retry shortly. If its owner has exited, recover that exact file with copilot-changelog unlock "${recovery}".`);
}

async function removeOwnedLock(path: string, owner: string): Promise<void> {
  if (await readFile(path, "utf8") !== owner) throw new Error(`Run lock ownership changed; preserving ${path}.`);
  await rm(path);
}

/**
 * Hold an exclusive lock until all work and cleanup finish.
 * The recovery fence is checked again after acquisition to prevent a concurrent unlock race.
 */
export async function withRunLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  await assertNoRecovery(path);
  const owner = newOwner();
  const handle = await open(path, "wx", 0o600).catch(async (error: unknown) => {
    if (!hasCode(error, "EEXIST")) throw error;
    const lock = await inspectLock(path);
    throw new Error(
      `${lock?.reason ?? "An existing or incomplete run lock was found"}: ${path}. Remove this lock only after confirming no run is active, then retry with --resume. Use copilot-changelog unlock "${resolve(path)}" for a verifiably stale local run lock. --restart does not override a run lock.`,
    );
  });
  let failure: { error: unknown } | undefined;
  let ownerWritten = false;
  try {
    try {
      await handle.writeFile(owner, "utf8");
      ownerWritten = true;
    } finally {
      await handle.close();
    }
    await assertNoRecovery(path);
    return await operation();
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    try {
      if (ownerWritten) await removeOwnedLock(path, owner);
      else await rm(path);
    } catch (error) {
      if (!failure) throw error;
      throw new AggregateError([failure.error, error],
        `${String(failure.error)}\nRun lock cleanup also failed: ${String(error)}`, { cause: failure.error });
    }
  }
}

/** Remove only an explicit stale local run lock; never recurse, follow links, or force an unknown owner. */
export async function removeStaleRunLock(input: string): Promise<string> {
  const path = resolve(input);
  if (!/\.lock(?:\.recovery)*$/i.test(path)) {
    throw new Error("unlock requires the exact .lock file path reported by the CLI, not an output folder or checkpoint.");
  }
  const previous = await inspectLock(path);
  if (!previous) return `No lock exists at ${path}. No files were changed.`;
  if (previous.state !== "stale") throw new Error(`Refusing to remove ${path}: ${previous.reason}. No files were changed.`);
  const recoveryPath = `${path}.recovery`;
  const owner = newOwner();
  const handle = await open(recoveryPath, "wx", 0o600).catch((error: unknown) => {
    if (!hasCode(error, "EEXIST")) throw error;
    throw new Error(`Recovery is already in progress at ${recoveryPath}. If its owner has exited, run copilot-changelog unlock "${recoveryPath}" first.`);
  });
  let failure: { error: unknown } | undefined;
  let ownerWritten = false;
  try {
    try {
      await handle.writeFile(owner, "utf8");
      ownerWritten = true;
    } finally {
      await handle.close();
    }
    const current = await inspectLock(path);
    if (!current || current.state !== "stale" || current.content !== previous.content ||
      current.device !== previous.device || current.inode !== previous.inode) {
      throw new Error(`Lock ownership changed during recovery; preserving ${path}. Retry only after inspecting the new owner.`);
    }
    await rm(path);
    return `Removed stale run lock: ${path}\nCheckpoint and cached content were preserved. Retry the original command with --resume.`;
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    try {
      if (ownerWritten) await removeOwnedLock(recoveryPath, owner);
      else await rm(recoveryPath);
    } catch (error) {
      if (!failure) throw error;
      throw new AggregateError([failure.error, error],
        `${String(failure.error)}\nRecovery-lock cleanup also failed: ${String(error)}`, { cause: failure.error });
    }
  }
}

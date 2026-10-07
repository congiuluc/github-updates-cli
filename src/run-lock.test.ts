import { access, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { removeStaleRunLock, withRunLock } from "./run-lock.js";

let directory: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (directory) await rm(directory, { recursive: true, force: true });
});
const staleOwner = () => JSON.stringify({ pid: 2147483647, hostname: hostname(), token: "saved-owner" });
const missingProcess = () => Object.assign(new Error("No such process"), { code: "ESRCH" });

async function fixture(content = staleOwner()) {
  directory = await mkdtemp(join(tmpdir(), "copilot-unlock-"));
  const path = join(directory, "briefing.lock");
  await writeFile(path, content);
  return path;
}

test("removes only a stale local lock and preserves checkpoint and cache data", async () => {
  const path = await fixture();
  const checkpoint = join(directory!, "briefing.checkpoint.json");
  await writeFile(checkpoint, "accepted content");
  expect(await removeStaleRunLock(path)).toContain("Removed stale run lock");
  await expect(access(path)).rejects.toThrow();
  await expect(access(`${path}.recovery`)).rejects.toThrow();
  expect(await readFile(checkpoint, "utf8")).toBe("accepted content");
  expect(await withRunLock(path, async () => "resumed")).toBe("resumed");
});

test("an absent lock is a no-op and does not create its parent directory", async () => {
  directory = await mkdtemp(join(tmpdir(), "copilot-unlock-absent-"));
  const path = join(directory, "missing", "briefing.lock");
  expect(await removeStaleRunLock(path)).toContain("No files were changed");
  await expect(access(join(directory, "missing"))).rejects.toThrow();
});

test.each([
  ["active", () => JSON.stringify({ pid: process.pid, hostname: hostname(), token: "running" })],
  ["foreign host", () => JSON.stringify({ pid: 2147483647, hostname: "another-host", token: "foreign" })],
  ["malformed", () => "{broken"],
  ["missing token", () => JSON.stringify({ pid: 2147483647, hostname: hostname() })],
  ["invalid PID", () => JSON.stringify({ pid: -1, hostname: hostname(), token: "invalid" })],
])("refuses an %s lock without touching it", async (_name, contents) => {
  const content = contents();
  const path = await fixture(content);
  await expect(removeStaleRunLock(path)).rejects.toThrow("Refusing to remove");
  expect(await readFile(path, "utf8")).toBe(content);
  await expect(access(`${path}.recovery`)).rejects.toThrow();
});

test("refuses protected processes and reports unexpected probe errors", async () => {
  const path = await fixture();
  const probe = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("Protected"), { code: "EPERM" }); });
  await expect(removeStaleRunLock(path)).rejects.toThrow("running or protected");
  probe.mockImplementation(() => { throw Object.assign(new Error("Unexpected probe failure"), { code: "EIO" }); });
  await expect(removeStaleRunLock(path)).rejects.toThrow("Unexpected probe failure");
  expect(await readFile(path, "utf8")).toBe(staleOwner());
});

test("never removes directories, hard links or non-lock files", async () => {
  const path = await fixture();
  const hardlink = join(directory!, "hardlink.lock");
  await link(path, hardlink);
  await expect(removeStaleRunLock(hardlink)).rejects.toThrow("Refusing");
  const updaterLock = join(directory!, ".copilot-changelog-update.lock");
  await mkdir(updaterLock);
  await expect(removeStaleRunLock(updaterLock)).rejects.toThrow("Refusing");
  const checkpoint = join(directory!, "checkpoint.json");
  await writeFile(checkpoint, staleOwner());
  await expect(removeStaleRunLock(checkpoint)).rejects.toThrow("exact .lock file path");
  expect(await readFile(checkpoint, "utf8")).toBe(staleOwner());
});

test.skipIf(process.platform === "win32")("does not follow symbolic links", async () => {
  const path = await fixture();
  const alias = join(directory!, "alias.lock");
  await symlink(path, alias);
  await expect(removeStaleRunLock(alias)).rejects.toThrow("Refusing");
  expect(await readFile(path, "utf8")).toBe(staleOwner());
});

test("a changed owner is preserved and the recovery fence is cleaned up", async () => {
  const path = await fixture();
  const replacement = JSON.stringify({ pid: 2147483647, hostname: hostname(), token: "replacement" });
  vi.spyOn(process, "kill").mockImplementationOnce(() => {
    writeFileSync(path, replacement);
    throw missingProcess();
  }).mockImplementation(() => { throw missingProcess(); });
  await expect(removeStaleRunLock(path)).rejects.toThrow("ownership changed");
  expect(await readFile(path, "utf8")).toBe(replacement);
  await expect(access(`${path}.recovery`)).rejects.toThrow();
});

test("recovery fences block concurrent acquisition until the stale lock is removed", async () => {
  const path = await fixture();
  let competing: Promise<unknown> | undefined;
  let probes = 0;
  const work = vi.fn();
  vi.spyOn(process, "kill").mockImplementation(() => {
    if (++probes === 2) competing = withRunLock(path, work).catch((error: unknown) => error);
    throw missingProcess();
  });
  await removeStaleRunLock(path);
  expect(String(await competing)).toContain("Lock recovery is in progress");
  expect(work).not.toHaveBeenCalled();
});

test("an abandoned recovery fence can itself be recovered without removing the original lock", async () => {
  const path = await fixture();
  await writeFile(`${path}.recovery`, staleOwner());
  await expect(removeStaleRunLock(path)).rejects.toThrow("Recovery is already in progress");
  await expect(withRunLock(path, async () => {})).rejects.toThrow("Lock recovery is in progress");
  await removeStaleRunLock(`${path}.recovery`);
  expect(await readFile(path, "utf8")).toBe(staleOwner());
  await removeStaleRunLock(path);
});

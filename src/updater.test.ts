import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import {
  checksumForAsset,
  compareVersions,
  detectInstallation,
  selectAssetName,
  updateCli,
} from "./updater.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: vi.fn() }));
vi.mock("node:fs/promises", () => ({
  chmod: vi.fn(),
  mkdtemp: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const newerRelease = () => new Response(JSON.stringify({
  tag_name: "v1.1.0",
  html_url: "https://github.com/congiuluc/GitHub-Updates-CLI/releases/tag/v1.1.0",
  assets: [],
}));

function processResult(status: number | null, error?: Error): ReturnType<typeof spawnSync> {
  return { pid: 1, output: [], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), status, signal: null, error };
}

test("updates Windows npm installs through the npm JavaScript entrypoint without a shell", async () => {
  const execPath = "C:\\Program Files\\nodejs\\node.exe";
  const npmPath = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
  vi.mocked(existsSync).mockImplementation((path) => path === npmPath);
  vi.mocked(spawnSync).mockReturnValue(processResult(0));

  await expect(updateCli("1.0.0", {
    fetchImpl: vi.fn().mockImplementation(newerRelease),
    environment: { platform: "win32", arch: "x64", execPath },
  })).resolves.toBe("Updated to 1.1.0.");
  expect(spawnSync).toHaveBeenCalledWith(execPath, [
    npmPath, "install", "--global", "copilot-changelog-cli@1.1.0",
  ], { stdio: "inherit" });
});

test("does not run a command when the Windows npm entrypoint cannot be found", async () => {
  vi.mocked(existsSync).mockReturnValue(false);
  await expect(updateCli("1.0.0", {
    fetchImpl: vi.fn().mockImplementation(newerRelease),
    environment: { platform: "win32", arch: "x64", execPath: "C:\\node\\node.exe" },
  })).rejects.toThrow("npm JavaScript entrypoint");
  expect(spawnSync).not.toHaveBeenCalled();
});

test("finds Windows npm on PATH and propagates process errors without invoking a shell", async () => {
  const npmPath = "C:\\custom npm\\node_modules\\npm\\bin\\npm-cli.js";
  vi.stubEnv("PATH", "C:\\custom npm;C:\\Windows");
  vi.mocked(existsSync).mockImplementation((path) => path === npmPath);
  vi.mocked(spawnSync).mockReturnValue(processResult(null, new Error("spawn failed")));
  await expect(updateCli("1.0.0", {
    fetchImpl: vi.fn().mockImplementation(newerRelease),
    environment: { platform: "win32", arch: "x64", execPath: "C:\\node\\node.exe" },
  })).rejects.toThrow("spawn failed");
  expect(spawnSync).toHaveBeenCalledWith("C:\\node\\node.exe", [
    npmPath, "install", "--global", "copilot-changelog-cli@1.1.0",
  ], { stdio: "inherit" });
});

test("preserves Unix npm invocation and reports command failure", async () => {
  vi.mocked(spawnSync).mockReturnValue(processResult(7));
  await expect(updateCli("1.0.0", {
    fetchImpl: vi.fn().mockImplementation(newerRelease),
    environment: { platform: "linux", arch: "x64", execPath: "/usr/bin/node" },
  })).rejects.toThrow("npm exited with code 7");
  expect(spawnSync).toHaveBeenCalledWith("npm", [
    "install", "--global", "copilot-changelog-cli@1.1.0",
  ], { stdio: "inherit" });
});

test.each(["spawn", "error"])("waits for the update helper's %s event before reporting a result", async (event) => {
  const { ChildProcess } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const child = new ChildProcess();
  const unref = vi.spyOn(child, "unref").mockImplementation(() => {});
  vi.mocked(spawn).mockReturnValue(child);
  vi.mocked(mkdtemp).mockResolvedValue(`${process.cwd()}\\.updater-test`);
  const content = Buffer.from("fixture archive");
  const name = "copilot-changelog-1.1.0-win-x64.zip";
  const checksums = `${createHash("sha256").update(content).digest("hex")}  ${name}\n`;
  vi.mocked(readFile).mockResolvedValue(checksums);
  let settled = false;
  const update = updateCli("1.0.0", {
    environment: { platform: "win32", arch: "x64", execPath: "C:\\portable\\runtime\\node.exe" },
    fetchImpl: async (url) => String(url).includes("api.github.com")
      ? new Response(JSON.stringify({ tag_name: "v1.1.0", assets: [
        { name, browser_download_url: "https://example.com/app.zip" },
        { name: "SHA256SUMS", browser_download_url: "https://example.com/SHA256SUMS" },
      ] }))
      : new Response(content),
  }).finally(() => { settled = true; });
  const assertion = event === "error" ? expect(update).rejects.toThrow("Helper failed to launch")
    : expect(update).resolves.toContain("will be applied");
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
  expect(settled).toBe(false);
  if (event === "error") child.emit("error", new Error("Helper failed to launch"));
  else child.emit("spawn");
  await assertion;
  expect(unref).toHaveBeenCalledTimes(event === "spawn" ? 1 : 0);
  if (event === "error") expect(rm).toHaveBeenCalledWith(`${process.cwd()}\\.updater-test`, { recursive: true, force: true });
});

test.each([200, 404])("times out while consuming a release response body (%s)", async (status) => {
  vi.useFakeTimers();
  let signal: AbortSignal | null | undefined;
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    signal = init?.signal;
    return new Response(new ReadableStream<Uint8Array>(), { status });
  });
  const result = updateCli("1.0.0", { checkOnly: true, fetchImpl, requestTimeoutMs: 3000 });
  const assertion = expect(result).rejects.toThrow(/timed out/i);
  await vi.advanceTimersByTimeAsync(3000);
  await assertion;
  expect(signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  expect(spawnSync).not.toHaveBeenCalled();
});

test("times out before response headers even if fetch ignores abort", async () => {
  vi.useFakeTimers();
  const result = updateCli("1.0.0", {
    checkOnly: true,
    fetchImpl: vi.fn().mockImplementation(() => new Promise(() => {})),
    requestTimeoutMs: 3000,
  });
  const assertion = expect(result).rejects.toThrow(/timed out/i);
  await vi.advanceTimersByTimeAsync(3000);
  await assertion;
  expect(vi.getTimerCount()).toBe(0);
});

test("clears the request timeout after successful body consumption", async () => {
  vi.useFakeTimers();
  await updateCli("1.0.0", {
    checkOnly: true,
    fetchImpl: vi.fn().mockImplementation(newerRelease),
    requestTimeoutMs: 3000,
  });
  expect(vi.getTimerCount()).toBe(0);
});

test.each([3000, undefined])("times out stalled asset bodies and cleans staging without installing (%s)", async (requestTimeoutMs) => {
  vi.useFakeTimers();
  vi.mocked(mkdtemp).mockResolvedValue(`${process.cwd()}\\.updater-test`);
  const signals: AbortSignal[] = [];
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (String(url).includes("api.github.com")) {
      return new Response(JSON.stringify({
        tag_name: "v1.1.0",
        assets: [
          { name: "copilot-changelog_1.1.0_amd64.deb", browser_download_url: "https://example.com/app.deb" },
          { name: "SHA256SUMS", browser_download_url: "https://example.com/SHA256SUMS" },
        ],
      }));
    }
    if (!init?.signal) throw new Error("Missing asset request signal");
    signals.push(init.signal);
    return new Response(new ReadableStream<Uint8Array>());
  });
  const result = updateCli("1.0.0", {
    fetchImpl,
    requestTimeoutMs,
    environment: { platform: "linux", arch: "x64", execPath: "/opt/copilot-changelog/runtime/node" },
  });
  const assertion = expect(result).rejects.toThrow(/timed out/i);
  if (requestTimeoutMs === undefined) {
    await vi.advanceTimersByTimeAsync(31_000);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(269_000);
  } else {
    await vi.advanceTimersByTimeAsync(requestTimeoutMs);
  }
  await assertion;
  expect(signals).toHaveLength(2);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(rm).toHaveBeenCalledWith(`${process.cwd()}\\.updater-test`, { recursive: true, force: true });
  expect(spawnSync).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test.each([0, -1, NaN, Infinity, 2_147_483_648])("rejects invalid timeout %s before fetching", async (requestTimeoutMs) => {
  const fetchImpl = vi.fn();
  await expect(updateCli("1.0.0", { requestTimeoutMs, fetchImpl })).rejects.toThrow("requestTimeoutMs");
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("compares stable and prerelease semantic versions", () => {
  expect(compareVersions("1.1.0", "1.0.9")).toBe(1);
  expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
  expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1);
  expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
});

test("detects packaged and portable installations", () => {
  expect(
    detectInstallation({
      platform: "win32",
      arch: "x64",
      execPath: "C:\\Users\\me\\AppData\\Local\\Programs\\Copilot Changelog CLI\\runtime\\node.exe",
    }),
  ).toMatchObject({ type: "windows-installer" });
  expect(
    detectInstallation({
      platform: "linux",
      arch: "arm64",
      execPath: "/home/me/copilot-changelog/runtime/node",
    }),
  ).toMatchObject({ type: "portable", root: "/home/me/copilot-changelog" });
  expect(
    detectInstallation({ platform: "linux", arch: "x64", execPath: "/usr/bin/node" }),
  ).toEqual({ type: "npm" });
});

test("selects release assets using release workflow names", () => {
  expect(selectAssetName("1.2.0", "windows-installer", "win32", "x64")).toBe(
    "copilot-changelog-1.2.0-setup.exe",
  );
  expect(selectAssetName("1.2.0", "linux-package", "linux", "x64")).toBe(
    "copilot-changelog_1.2.0_amd64.deb",
  );
  expect(selectAssetName("1.2.0", "portable", "darwin", "arm64")).toBe(
    "copilot-changelog-1.2.0-darwin-arm64.tar.gz",
  );
});

test("reads GNU sha256sum output", () => {
  const checksum = "a".repeat(64);
  expect(checksumForAsset(`${checksum}  update.zip\n`, "update.zip")).toBe(checksum);
  expect(() => checksumForAsset(`${checksum}  other.zip\n`, "update.zip")).toThrow(
    "does not contain update.zip",
  );
});

test("checks for a newer release without installing it", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        tag_name: "v1.1.0",
        html_url: "https://github.com/congiuluc/GitHub-Updates-CLI/releases/tag/v1.1.0",
        assets: [],
      }),
      { status: 200 },
    );

  await expect(
    updateCli("1.0.0", {
      checkOnly: true,
      fetchImpl: fetchImpl as typeof fetch,
      environment: { platform: "linux", arch: "x64", execPath: "/usr/bin/node" },
    }),
  ).resolves.toContain("Update available: 1.0.0 -> 1.1.0");
});

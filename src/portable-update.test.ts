import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import { afterEach, expect, test } from "vitest";
import { portableUpdateScript, windowsInstallerUpdateScript } from "./updater.js";

const exec = promisify(execFile);
let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

test.skipIf(process.platform !== "win32").each(["1.1.0", "1.0.0"])(
  "installer completion checks the installed version even after exit code zero (%s)", async (installedVersion) => {
    directory = await mkdtemp(join(tmpdir(), "copilot-installer-result-"));
    const root = join(directory, "person's installed app");
    const temporary = join(directory, "download");
    const manifest = join(root, "app", "node_modules", "copilot-changelog-cli", "package.json");
    await mkdir(dirname(manifest), { recursive: true });
    await mkdir(temporary);
    await writeFile(manifest, JSON.stringify({ version: installedVersion }));
    const scriptPath = join(directory, "verify-installer.ps1");
    const script = [
      "function Wait-Process {}",
      "function Start-Sleep {}",
      "function Start-Process { return [PSCustomObject]@{ ExitCode = 0 } }",
      windowsInstallerUpdateScript(root, join(temporary, "unused.exe"), temporary, "1.1.0", 2147483647),
    ].join("\r\n");
    await writeFile(scriptPath, script);
    const execution = exec("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], { timeout: 20_000 });
    if (installedVersion === "1.1.0") await execution;
    else await expect(execution).rejects.toMatchObject({ code: 1 });
    const result = await readFile(join(root, ".copilot-changelog-update.log"), "utf8");
    expect(result).toContain(installedVersion === "1.1.0" ? "Verified installed version: 1.1.0" : "reports 1.0.0 instead of 1.1.0");
    expect(result.includes("completed successfully")).toBe(installedVersion === "1.1.0");
  },
  25_000,
);

async function fixture(expectedVersion?: string) {
  directory = await mkdtemp(join(tmpdir(), "copilot-portable-update-"));
  const root = join(directory, "user's portable app");
  const temporary = join(directory, "download");
  const stage = join(directory, "archive-content");
  const windows = process.platform === "win32";
  const launcher = windows ? "copilot-changelog.exe" : "copilot-changelog";
  const node = windows ? "node.exe" : "node";
  const application = "app/node_modules/copilot-changelog-cli";
  const oldFiles: Record<string, string> = {
    [`${application}/package.json`]: '{"version":"1.0.0"}',
    [`${application}/dist/cli.js`]: "old application",
    [`${application}/node_modules/example-dependency/package.json`]: '{"version":"1.0.0"}',
    [`runtime/${node}`]: "old runtime",
    [launcher]: "old launcher",
    "README.md": "old readme",
    "output/my-deck.pptx": "user output",
    "custom-settings.json": "user settings",
  };
  const newFiles: Record<string, string> = {
    [`${application}/package.json`]: '{"version":"1.1.0"}',
    [`${application}/dist/cli.js`]: "new application",
    "app/node_modules/example-dependency/package.json": '{"version":"2.0.0"}',
    [`runtime/${node}`]: expectedVersion && !windows ? `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n` : "new runtime",
    [launcher]: "new launcher",
    "README.md": "new readme",
  };
  for (const [name, value] of Object.entries(oldFiles)) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value);
    if (name === "runtime/node" && expectedVersion) await chmod(path, 0o755);
  }
  await mkdir(temporary);
  const archive = join(temporary, windows ? "update.zip" : "update.tar.gz");
  if (windows) {
    const zip = new JSZip();
    for (const [name, value] of Object.entries(newFiles)) zip.file(name, value);
    await writeFile(archive, await zip.generateAsync({ type: "nodebuffer" }));
  } else {
    for (const [name, value] of Object.entries(newFiles)) {
      const path = join(stage, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, value);
    }
    await exec("tar", ["-czf", archive, "-C", stage, "."]);
  }
  const environment = { platform: process.platform, arch: process.arch, execPath: join(root, "runtime", node) };
  const scriptPath = join(temporary, windows ? "apply.ps1" : "apply.sh");
  const script = portableUpdateScript(environment, root, archive, temporary, 2147483647, expectedVersion);
  const run = async (content = script) => {
    await writeFile(scriptPath, content);
    return exec(windows ? "powershell.exe" : "sh", windows
      ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath] : [scriptPath],
    { timeout: 30_000 });
  };
  return { root, temporary, application, oldFiles, windows, script, run };
}

test.each(["1.1.0", "1.2.0"])("verifies the installed version before committing a portable update (%s)", async (expected) => {
  const data = await fixture(expected);
  if (expected === "1.1.0") {
    await data.run();
    expect(await readFile(join(data.root, ".copilot-changelog-update.log"), "utf8")).toContain("successfully");
  } else {
    await expect(data.run()).rejects.toThrow();
    expect(JSON.parse(await readFile(join(data.root, data.application, "package.json"), "utf8")).version).toBe("1.0.0");
    expect(await readFile(join(data.root, ".copilot-changelog-update.log"), "utf8")).toContain("rolled back");
  }
}, 40_000);

test("replaces managed files without stale dependencies and preserves user files", async () => {
  const data = await fixture();
  await data.run();
  const require = createRequire(join(data.root, data.application, "dist", "cli.js"));
  expect(require("example-dependency/package.json").version).toBe("2.0.0");
  expect(JSON.parse(await readFile(join(data.root, data.application, "package.json"), "utf8")).version).toBe("1.1.0");
  expect(await readFile(join(data.root, "output", "my-deck.pptx"), "utf8")).toBe("user output");
  expect(await readFile(join(data.root, "custom-settings.json"), "utf8")).toBe("user settings");
  expect(await readFile(join(data.root, ".copilot-changelog-update.log"), "utf8")).toContain("successfully");
  expect((await readdir(data.root)).some((name) => name.endsWith(".stage") || name.endsWith(".backup"))).toBe(false);
  await expect(access(join(data.root, ".copilot-changelog-update.lock"))).rejects.toThrow();
  await expect(access(data.temporary)).rejects.toThrow();
}, 40_000);

test("rolls back every managed file after a partial replacement fails", async () => {
  const data = await fixture();
  const marker = data.windows ? "$installed.Add($entry)" : 'installed="$entry $installed"';
  expect(data.script).toContain(marker);
  const script = data.script.replace(marker, `${marker}\n${data.windows ? "throw 'Injected install failure'" : "false"}`);
  await expect(data.run(script)).rejects.toThrow();
  for (const [name, value] of Object.entries(data.oldFiles)) {
    expect(await readFile(join(data.root, name), "utf8")).toBe(value);
  }
  expect(await readFile(join(data.root, ".copilot-changelog-update.log"), "utf8")).toContain("rolled back");
}, 40_000);

test("does not touch the existing installation when extraction fails", async () => {
  const data = await fixture();
  await writeFile(join(data.temporary, data.windows ? "update.zip" : "update.tar.gz"), "not an archive");
  await expect(data.run()).rejects.toThrow();
  for (const [name, value] of Object.entries(data.oldFiles)) {
    expect(await readFile(join(data.root, name), "utf8")).toBe(value);
  }
}, 40_000);

test("retains the backup and reports its location if rollback cannot complete", async () => {
  const data = await fixture();
  const installMarker = data.windows ? "$installed.Add($entry)" : 'installed="$entry $installed"';
  const rollbackMarker = data.windows
    ? "Move-Item -LiteralPath (Join-Path $backup $entry) -Destination (Join-Path $target $entry)"
    : 'if [ -e "$target/$entry" ] || ! mv -- "$backup/$entry" "$target/$entry"; then';
  expect(data.script).toContain(rollbackMarker);
  const script = data.script
    .replace(installMarker, `${installMarker}\n${data.windows ? "throw 'Injected install failure'" : "false"}`)
    .replace(rollbackMarker, data.windows ? "throw 'Injected rollback failure'" : "if true; then");
  await expect(data.run(script)).rejects.toThrow();
  const backup = (await readdir(data.root)).find((name) => name.endsWith(".backup"));
  expect(backup).toBeDefined();
  expect(await readFile(join(data.root, backup!, data.application, "package.json"), "utf8")).toBe('{"version":"1.0.0"}');
  expect(await readFile(join(data.root, ".copilot-changelog-update.log"), "utf8")).toContain("backup preserved");
  expect(await readFile(join(data.root, "output", "my-deck.pptx"), "utf8")).toBe("user output");
}, 40_000);

test("does not remove another updater's lock or modify its installation", async () => {
  const data = await fixture();
  const lock = join(data.root, ".copilot-changelog-update.lock");
  await mkdir(lock);
  await expect(data.run()).rejects.toThrow();
  await access(lock);
  for (const [name, value] of Object.entries(data.oldFiles)) {
    expect(await readFile(join(data.root, name), "utf8")).toBe(value);
  }
}, 40_000);

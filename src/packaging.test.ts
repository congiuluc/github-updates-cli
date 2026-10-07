import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFile(join(root, path), "utf8");

test("Node LTS pin, runtime requirements, lockfile and documentation stay aligned", async () => {
  const [pin, manifest, lockfile, readme, docs] = await Promise.all([
    read(".node-version"), read("package.json"), read("package-lock.json"),
    read("README.md"), read("docs/index.html"),
  ]);
  const version = pin.trim();
  expect(version).toBe("24.21.0");
  const pkg = JSON.parse(manifest);
  const lock = JSON.parse(lockfile);
  expect(pkg.engines.node).toBe(`^${version}`);
  expect(lock.packages[""].engines.node).toBe(pkg.engines.node);
  expect(pkg.devDependencies["@types/node"]).toMatch(/^\^24\./);
  for (const document of [readme, docs]) {
    expect(document.replace(/\*\*/g, "")).toContain(`Node.js 24 LTS, version ${version} or newer within 24.x`);
    expect(document).toContain(".node-version");
    expect(document).not.toContain("22.12+");
  }
});

test("portable packaging defaults to the shared Node LTS pin instead of the host runtime", async () => {
  const [unix, windows] = await Promise.all([
    read("packaging/build-unix.sh"), read("packaging/build-portable.ps1"),
  ]);
  expect(unix).toContain('NODE_VERSION="${NODE_VERSION:-$(cat "$ROOT/.node-version")}"');
  expect(unix).not.toContain("$(node --version)");
  expect(windows).toContain('(Get-Content -LiteralPath (Join-Path $root ".node-version") -Raw).Trim()');
  expect(windows).not.toContain("(& node --version)");
});

test("release package and lockfile declare the same version", async () => {
  const [manifest, lockfile] = await Promise.all([
    read("package.json"), read("package-lock.json"),
  ]);
  const { version } = JSON.parse(manifest);
  const lock = JSON.parse(lockfile);
  expect(lock.version).toBe(version);
  expect(lock.packages[""].version).toBe(version);
});

test("Copilot icon includes transparent 32-bit PNG frames for standard Windows icon sizes", async () => {
  const icon = await readFile(join(root, "assets", "copilot.ico"));
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  expect(icon.readUInt16LE(0)).toBe(0);
  expect(icon.readUInt16LE(2)).toBe(1);
  expect(icon.readUInt16LE(4)).toBe(sizes.length);
  let expectedOffset = 6 + 16 * sizes.length;
  for (const [index, size] of sizes.entries()) {
    const entry = 6 + index * 16;
    expect(icon[entry] || 256).toBe(size);
    expect(icon[entry + 1] || 256).toBe(size);
    expect(icon.readUInt16LE(entry + 6)).toBe(32);
    const length = icon.readUInt32LE(entry + 8);
    const offset = icon.readUInt32LE(entry + 12);
    expect(offset).toBe(expectedOffset);
    expect(length).toBeGreaterThan(24);
    expect(offset + length).toBeLessThanOrEqual(icon.length);
    const frame = icon.subarray(offset, offset + length);
    expect(frame.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(frame.readUInt32BE(16)).toBe(size);
    expect(frame.readUInt32BE(20)).toBe(size);
    expect(frame[25]).toBe(6);
    expectedOffset += length;
  }
  expect(expectedOffset).toBe(icon.length);
});

test("Windows launcher, setup, shortcut, and uninstall entry use the Copilot icon", async () => {
  const [portable, installer] = await Promise.all([
    read("packaging/build-portable.ps1"), read("packaging/copilot-changelog.iss"),
  ]);
  expect(portable).toContain('"assets\\copilot.ico"');
  expect(portable).toContain('/win32icon:"$icon"');
  expect(installer).toContain("SetupIconFile=..\\assets\\copilot.ico");
  expect(installer).toContain('IconFilename: "{app}\\copilot-changelog.exe"; IconIndex: 0');
  expect(installer).toContain("UninstallDisplayIcon={app}\\copilot-changelog.exe");
});

test.skipIf(process.platform !== "win32")("compiled Windows launcher embeds every Copilot icon frame", async () => {
  const windows = process.env.SystemRoot ?? "C:\\Windows";
  const compiler = ["Framework64", "Framework"]
    .map((framework) => join(windows, "Microsoft.NET", framework, "v4.0.30319", "csc.exe"))
    .find(existsSync);
  if (!compiler) throw new Error("The Windows C# compiler is required to verify the launcher icon.");
  const fixture = await mkdtemp(join(tmpdir(), "copilot-launcher-icon-"));
  try {
    const executable = join(fixture, "copilot-changelog.exe");
    const iconPath = join(root, "assets", "copilot.ico");
    const result = spawnSync(compiler, [
      "/nologo", "/target:exe", `/win32icon:${iconPath}`, `/out:${executable}`,
      join(root, "packaging", "launcher", "Program.cs"),
    ], { encoding: "utf8", timeout: 20_000 });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const [binary, icon] = await Promise.all([readFile(executable), readFile(iconPath)]);
    for (let index = 0; index < icon.readUInt16LE(4); index++) {
      const entry = 6 + index * 16;
      const length = icon.readUInt32LE(entry + 8);
      const offset = icon.readUInt32LE(entry + 12);
      expect(binary.includes(icon.subarray(offset, offset + length))).toBe(true);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}, 30_000);

test("npm packaging declares the tested parser version in its bundle and restores the source manifest", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "copilot-npm-manifest-"));
  try {
    const directory = join(fixture, "node_modules", "pptxgenjs");
    await mkdir(directory, { recursive: true });
    await mkdir(join(fixture, "node_modules", "image-size"));
    await writeFile(join(fixture, "node_modules", "image-size", "package.json"), '{"version":"2.0.4"}');
    await writeFile(join(fixture, "package.json"), '{"overrides":{"image-size":"2.0.4"}}');
    const original = '{"name":"pptxgenjs","version":"4.0.0","dependencies":{"image-size":"^1.1.1"}}';
    await writeFile(join(directory, "package.json"), original);
    const script = join(root, "packaging", "prepare-npm-package.mjs");
    const prepared = spawnSync(process.execPath, [script], { cwd: fixture, encoding: "utf8" });
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(JSON.parse(await readFile(join(directory, "package.json"), "utf8")).dependencies["image-size"]).toBe("2.0.4");
    const restored = spawnSync(process.execPath, [script, "--restore"], { cwd: fixture, encoding: "utf8" });
    expect(restored.status, restored.stderr).toBe(0);
    expect(await readFile(join(directory, "package.json"), "utf8")).toBe(original);
    await expect(access(join(fixture, "node_modules", ".copilot-pptxgenjs-manifest.json"))).rejects.toThrow();
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("portable launcher resolves symlinks before finding its bundled runtime", async () => {
  const launcher = await read("packaging/launcher/copilot-changelog");
  expect(launcher).toContain("readlink");
  expect(launcher.indexOf("readlink")).toBeLessThan(launcher.indexOf('exec "$SCRIPT_DIR/runtime/node"'));
});

test.skipIf(process.platform === "win32")("launcher handles portable paths and chained Debian-style symlinks", async () => {
  const fixture = await mkdtemp(join(root, ".packaging-test-"));
  try {
    const portable = join(fixture, "portable application");
    await mkdir(join(portable, "runtime"), { recursive: true });
    await mkdir(join(fixture, "bin"));
    await copyFile(join(root, "packaging/launcher/copilot-changelog"), join(portable, "copilot-changelog"));
    await writeFile(join(portable, "runtime/node"), '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    await chmod(join(portable, "runtime/node"), 0o755);
    await chmod(join(portable, "copilot-changelog"), 0o755);
    await symlink(join(portable, "copilot-changelog"), join(fixture, "bin", "absolute-link"));
    await symlink("absolute-link", join(fixture, "bin", "copilot-changelog"));
    for (const launcher of [join(portable, "copilot-changelog"), join(fixture, "bin", "copilot-changelog")]) {
      const result = spawnSync(launcher, ["argument with spaces", "--help"], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual([
        "--no-warnings=ExperimentalWarning",
        join(portable, "app/node_modules/copilot-changelog-cli/dist/cli.js"),
        "argument with spaces", "--help",
      ]);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("Unix packaging rejects host mismatches before installing native dependencies", async () => {
  const script = await read("packaging/build-unix.sh");
  expect(script).toContain("process.platform");
  expect(script).toContain("process.arch");
  expect(script).toMatch(/"\$PLATFORM" != "\$HOST_PLATFORM"/);
  expect(script).toMatch(/"\$ARCH" != "\$HOST_ARCH"/);
  expect(script.indexOf("HOST_PLATFORM")).toBeLessThan(script.indexOf("npm ci"));
  expect(script).toContain("Native packaging requires");
});

test.skipIf(process.platform === "win32")("host guards stop cross-platform and cross-architecture packaging", async () => {
  const fixture = await mkdtemp(join(root, ".packaging-test-"));
  try {
    await mkdir(join(fixture, "bin"));
    await mkdir(join(fixture, "packaging"));
    await copyFile(join(root, "packaging/build-unix.sh"), join(fixture, "packaging/build-unix.sh"));
    await copyFile(join(root, ".node-version"), join(fixture, ".node-version"));
    const nodeVersion = (await read(".node-version")).trim();
    const node = join(fixture, "bin/node");
    const npm = join(fixture, "bin/npm");
    await writeFile(node, `#!/bin/sh
case "$*" in
  "--version") echo v${nodeVersion} ;;
  "-p process.platform") echo linux ;;
  "-p process.arch") echo x64 ;;
  *) echo 1.0.0 ;;
esac
`);
    await writeFile(npm, '#!/bin/sh\necho "Unexpected npm invocation" >&2\nexit 99\n');
    await chmod(node, 0o755);
    await chmod(npm, 0o755);
    for (const [platform, arch, override] of [
      ["darwin", "x64", nodeVersion], ["linux", "arm64", nodeVersion],
      ["darwin", "x64", ""], ["linux", "arm64", ""],
    ]) {
      const result = spawnSync("bash", [join(fixture, "packaging/build-unix.sh"), platform, arch], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${join(fixture, "bin")}:${process.env.PATH}`, NODE_VERSION: override },
      });
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain("Native packaging requires");
      expect(result.stderr).not.toContain("Unexpected npm invocation");
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("Unix packaging smoke-imports the installed SDK with its bundled runtime before archiving", async () => {
  const script = await read("packaging/build-unix.sh");
  expect(script).toContain('cd "$STAGING/app/node_modules/copilot-changelog-cli"');
  expect(script).toMatch(/"\$STAGING\/runtime\/node".*import\('@github\/copilot-sdk'\)/);
  expect(script).toContain("import('@github/copilot-$PLATFORM-$ARCH/sdk')");
  expect(script.indexOf("import('@github/copilot-sdk')")).toBeLessThan(script.indexOf("tar -czf"));
});

test.each(["packaging/build-unix.sh", "packaging/build-portable.ps1"])(
  "%s installs the validated dependency lockfile into the packaged application", async (path) => {
    const script = await read(path);
    expect(script).toContain("package-lock.json");
    expect(script).toContain("npm ci --omit=dev");
    expect(script).not.toContain("npm install");
    expect(script).not.toContain("npm pack");
  },
);

test("packaged CLI version is checked against the manifest used for release artifacts", async () => {
  const [unix, windows, release] = await Promise.all([
    read("packaging/build-unix.sh"),
    read("packaging/build-portable.ps1"),
    read(".github/workflows/release.yml"),
  ]);
  expect(unix).toContain('ACTUAL_VERSION="$(COPILOT_CHANGELOG_SKIP_UPDATE_CHECK=1 "$STAGING/copilot-changelog" --version)"');
  expect(unix).toContain('if [[ "$ACTUAL_VERSION" != "$VERSION" ]]');
  expect(windows).toContain("$actualVersion = (& (Join-Path $staging \"copilot-changelog.exe\") --version).Trim()");
  expect(windows).toContain("if ($actualVersion -ne $package.version)");

  const verification = release.split("\n  verify-version:")[1]?.split("\n  validate:")[0] ?? "";
  expect(verification).toContain("require('./package.json').version");
  expect(verification).toContain('"$GITHUB_REF_NAME" != "v$VERSION"');
  for (const jobName of ["windows", "linux", "macos"]) {
    const job = release.split(`\n  ${jobName}:`)[1]?.split(/\n  [a-z-]+:/)[0] ?? "";
    expect(job).toContain("needs: verify-version");
  }
});

test.each([".github/workflows/ci.yml", ".github/workflows/release.yml"])(
  "%s validates the lowest supported Node release", async (path) => {
    const workflow = await read(path);
    const setups = workflow.match(/uses: actions\/setup-node@v4/g) ?? [];
    expect(setups.length).toBeGreaterThan(0);
    expect(workflow.match(/node-version-file: \.node-version/g)).toHaveLength(setups.length);
    expect(workflow).not.toContain("node-version:");
    expect(workflow).not.toContain("node: 22.12.0");
  },
);
test("release packaging uses four native Unix runners", async () => {
  const release = await read(".github/workflows/release.yml");
  const linux = release.split("\n  linux:")[1].split("\n  macos:")[0];
  const macos = release.split("\n  macos:")[1].split("\n  publish:")[0];
  for (const job of [linux, macos]) expect(job).toContain("runs-on: ${{ matrix.os }}");
  expect(linux).toMatch(/arch: x64\s+os: ubuntu-24\.04\s+deb_arch: amd64/);
  expect(linux).toMatch(/arch: arm64\s+os: ubuntu-24\.04-arm\s+deb_arch: arm64/);
  expect(macos).toMatch(/arch: x64\s+os: macos-15-intel/);
  expect(macos).toMatch(/arch: arm64\s+os: macos-15/);
});

test("release publication requires successful typechecking and tests", async () => {
  const release = await read(".github/workflows/release.yml");
  expect(release).toContain("\n  validate:");
  const validation = release.split("\n  validate:")[1]?.split("\n  windows:")[0] ?? "";
  expect(validation).toContain("npm ci");
  expect(validation).toContain("npm run typecheck");
  expect(validation).toContain("npm test");
  const publish = release.split("\n  publish:")[1];
  expect(publish).toMatch(/needs: \[[^\]]*\bvalidate\b[^\]]*\]/);
  expect(publish).not.toContain("always()");
});

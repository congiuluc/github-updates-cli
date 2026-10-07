import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";

const repository = "congiuluc/github-updates-cli";
const packageName = "copilot-changelog-cli";

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  html_url: string;
  assets: ReleaseAsset[];
}

export type InstallationType = "npm" | "windows-installer" | "linux-package" | "macos-package" | "portable";

export interface UpdateEnvironment {
  platform: NodeJS.Platform;
  arch: string;
  execPath: string;
}

export interface UpdateOptions {
  checkOnly?: boolean;
  fetchImpl?: typeof fetch;
  environment?: UpdateEnvironment;
  /** Override HTTP deadlines, including bodies (defaults: lookup 30s, assets 5min). */
  requestTimeoutMs?: number;
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
    if (!match) throw new Error(`Invalid semantic version: ${value}`);
    return {
      numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: match[4]?.split("."),
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1;
  }
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : undefined;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber > rightNumber ? 1 : -1;
    if (leftNumber !== undefined) return -1;
    if (rightNumber !== undefined) return 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

export function detectInstallation(environment: UpdateEnvironment): {
  type: InstallationType;
  root?: string;
} {
  const platformPath = environment.platform === "win32" ? win32 : posix;
  if (platformPath.basename(platformPath.dirname(environment.execPath)).toLowerCase() !== "runtime") {
    return { type: "npm" };
  }

  const root = platformPath.resolve(platformPath.dirname(environment.execPath), "..");
  const normalized = root.replaceAll("\\", "/").toLowerCase();
  if (environment.platform === "win32" && normalized.endsWith("/programs/copilot changelog cli")) {
    return { type: "windows-installer", root };
  }
  if (environment.platform === "linux" && normalized === "/opt/copilot-changelog") {
    return { type: "linux-package", root };
  }
  if (environment.platform === "darwin" && normalized === "/usr/local/lib/copilot-changelog") {
    return { type: "macos-package", root };
  }
  return { type: "portable", root };
}

export function selectAssetName(
  version: string,
  installation: InstallationType,
  platform: NodeJS.Platform,
  arch: string,
): string | undefined {
  if (installation === "npm") return undefined;
  if (platform === "win32") {
    return installation === "windows-installer"
      ? `copilot-changelog-${version}-setup.exe`
      : `copilot-changelog-${version}-win-${arch}.zip`;
  }
  if (platform === "linux") {
    const packageArch = arch === "x64" ? "amd64" : arch;
    return installation === "linux-package"
      ? `copilot-changelog_${version}_${packageArch}.deb`
      : `copilot-changelog-${version}-linux-${arch}.tar.gz`;
  }
  if (platform === "darwin") {
    return installation === "macos-package"
      ? `copilot-changelog-${version}-macos-${arch}.pkg`
      : `copilot-changelog-${version}-darwin-${arch}.tar.gz`;
  }
  throw new Error(`Self-update is not supported on platform ${platform}.`);
}

export function checksumForAsset(checksums: string, assetName: string): string {
  for (const line of checksums.split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match?.[2] === assetName) return match[1].toLowerCase();
  }
  throw new Error(`SHA256SUMS does not contain ${assetName}.`);
}

async function request<T>(
  fetchImpl: typeof fetch,
  url: string,
  accept: string,
  timeoutMs: number,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Update request timed out after ${timeoutMs} ms.`));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      deadline,
      (async () => consume(await fetchImpl(url, {
        headers: { Accept: accept, "User-Agent": packageName },
        signal: controller.signal,
      })))(),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRelease(fetchImpl: typeof fetch, timeoutMs: number): Promise<GitHubRelease> {
  return request(fetchImpl, `https://api.github.com/repos/${repository}/releases/latest`,
    "application/vnd.github+json", timeoutMs, async (response) => {
      if (response.status === 404) {
        await response.arrayBuffer();
        throw new Error("No published GitHub release is available for updates.");
      }
      if (!response.ok) {
        await response.arrayBuffer();
        throw new Error(`GitHub release lookup failed (${response.status}).`);
      }
      return (await response.json()) as GitHubRelease;
    });
}

async function download(
  fetchImpl: typeof fetch,
  asset: ReleaseAsset,
  destination: string,
  timeoutMs: number,
): Promise<Buffer> {
  const content = await request(fetchImpl, asset.browser_download_url,
    "application/octet-stream", timeoutMs, async (response) => {
      if (!response.ok) {
        await response.arrayBuffer();
        throw new Error(`Download failed for ${asset.name} (${response.status}).`);
      }
      return Buffer.from(await response.arrayBuffer());
    });
  await writeFile(destination, content);
  return content;
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status ?? "unknown"}.`);
}

function windowsNpmEntrypoint(execPath: string): string {
  const directories = [
    win32.dirname(execPath),
    ...(process.env.PATH ?? "").split(";").filter(Boolean),
  ];
  const candidates = [
    ...directories.map((directory) => win32.join(directory, "node_modules", "npm", "bin", "npm-cli.js")),
    process.env.npm_execpath,
  ];
  const entrypoint = candidates.find((candidate) =>
    candidate && win32.basename(candidate).toLowerCase() === "npm-cli.js" && existsSync(candidate));
  if (!entrypoint) {
    throw new Error("Cannot locate the npm JavaScript entrypoint. Ensure npm is installed alongside Node.js or on PATH.");
  }
  return entrypoint;
}

export function portableUpdateScript(
  environment: UpdateEnvironment,
  root: string,
  archivePath: string,
  temporaryDirectory: string,
  processId = process.pid,
): string {
  const transaction = randomUUID();
  const stage = join(root, `.copilot-update-${transaction}.stage`);
  const backup = join(root, `.copilot-update-${transaction}.backup`);
  const lock = join(root, ".copilot-changelog-update.lock");
  const log = join(root, ".copilot-changelog-update.log");
  if (environment.platform === "win32") {
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    return `$ErrorActionPreference = 'Stop'
$target = ${quote(root)}
$stage = ${quote(stage)}
$backup = ${quote(backup)}
$lock = ${quote(lock)}
$log = ${quote(log)}
$temporary = ${quote(temporaryDirectory)}
$entries = @('app', 'runtime', 'copilot-changelog.exe', 'README.md')
$backedUp = New-Object 'System.Collections.Generic.List[string]'
$installed = New-Object 'System.Collections.Generic.List[string]'
$ownsLock = $false
$committed = $false
$rollbackComplete = $true
$exitCode = 0
try {
  Wait-Process -Id ${processId} -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  New-Item -ItemType Directory -Path $lock -ErrorAction Stop | Out-Null
  $ownsLock = $true
  Expand-Archive -LiteralPath ${quote(archivePath)} -DestinationPath $stage
  foreach ($entry in $entries) {
    if (-not (Test-Path -LiteralPath (Join-Path $stage $entry))) { throw "Missing update entry: $entry" }
  }
  foreach ($required in @('runtime\\node.exe', 'app\\node_modules\\copilot-changelog-cli\\dist\\cli.js')) {
    if (-not (Test-Path -LiteralPath (Join-Path $stage $required) -PathType Leaf)) { throw "Incomplete update: $required" }
  }
  New-Item -ItemType Directory -Path $backup | Out-Null
  Set-Content -LiteralPath $log -Value ('Update in progress; recovery backup: ' + $backup)
  foreach ($entry in $entries) {
    if (Test-Path -LiteralPath (Join-Path $target $entry)) {
      Move-Item -LiteralPath (Join-Path $target $entry) -Destination (Join-Path $backup $entry)
      $backedUp.Add($entry)
    }
  }
  foreach ($entry in $entries) {
    if (Test-Path -LiteralPath (Join-Path $target $entry)) { throw "Update target unexpectedly exists: $entry" }
    Move-Item -LiteralPath (Join-Path $stage $entry) -Destination (Join-Path $target $entry)
    $installed.Add($entry)
  }
  $committed = $true
  Set-Content -LiteralPath $log -Value 'Update completed successfully.'
} catch {
  $failure = $_.Exception.Message
  $exitCode = 1
  if (-not $committed) {
    foreach ($entry in $installed) {
      try { Remove-Item -LiteralPath (Join-Path $target $entry) -Recurse -Force }
      catch { $rollbackComplete = $false; $failure += "; rollback removal failed: " + $_.Exception.Message }
    }
    foreach ($entry in $backedUp) {
      try {
        if (Test-Path -LiteralPath (Join-Path $target $entry)) { throw "Rollback target still exists: $entry" }
        Move-Item -LiteralPath (Join-Path $backup $entry) -Destination (Join-Path $target $entry)
      }
      catch { $rollbackComplete = $false; $failure += "; rollback restore failed: " + $_.Exception.Message }
    }
  }
  if (-not $rollbackComplete) { $failure += "; backup preserved at " + $backup }
  elseif (-not $committed) { $failure += "; changes rolled back" }
  Set-Content -LiteralPath $log -Value ('Update failed: ' + $failure)
} finally {
  $cleanup = @($stage, $temporary)
  if ($committed -or $rollbackComplete) { $cleanup += $backup }
  foreach ($path in $cleanup) {
    try {
      if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
    } catch {
      $exitCode = 1
      Add-Content -LiteralPath $log -Value ('Update cleanup failed: ' + $_.Exception.Message)
    }
  }
  if ($ownsLock) {
    try { Remove-Item -LiteralPath $lock -Force }
    catch { $exitCode = 1; Add-Content -LiteralPath $log -Value ('Lock cleanup failed: ' + $_.Exception.Message) }
  }
}
exit $exitCode
`;
  }

  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return `#!/bin/sh
set -eu
target=${quote(root)}
stage=${quote(stage)}
backup=${quote(backup)}
lock=${quote(lock)}
log=${quote(log)}
temporary=${quote(temporaryDirectory)}
entries='app runtime copilot-changelog README.md'
backed_up=''
installed=''
committed=0
owns_lock=0
phase='waiting for the running CLI'
finish() {
  result=$?
  trap - EXIT HUP INT TERM
  rollback_complete=1
  if [ "$result" -ne 0 ] && [ "$committed" -eq 0 ]; then
    for entry in $installed; do
      if ! rm -rf -- "$target/$entry"; then rollback_complete=0; fi
    done
    for entry in $backed_up; do
      if [ -e "$target/$entry" ] || ! mv -- "$backup/$entry" "$target/$entry"; then rollback_complete=0; fi
    done
  fi
  if [ "$result" -eq 0 ]; then
    printf '%s\\n' 'Update completed successfully.' > "$log"
  elif [ "$rollback_complete" -eq 1 ]; then
    printf 'Update failed during %s; changes rolled back.\\n' "$phase" > "$log"
  else
    printf 'Update failed during %s; rollback incomplete; backup preserved at %s.\\n' "$phase" "$backup" > "$log"
  fi
  if ! rm -rf -- "$stage" "$temporary"; then
    printf '%s\\n' 'Update staging cleanup failed.' >> "$log"
    result=1
  fi
  if [ "$committed" -eq 1 ] || [ "$rollback_complete" -eq 1 ]; then
    if ! rm -rf -- "$backup"; then printf '%s\\n' 'Backup cleanup failed.' >> "$log"; result=1; fi
  fi
  if [ "$owns_lock" -eq 1 ]; then
    if ! rmdir -- "$lock"; then printf '%s\\n' 'Lock cleanup failed.' >> "$log"; result=1; fi
  fi
  exit "$result"
}
trap finish EXIT
trap 'exit 1' HUP INT TERM
while kill -0 ${processId} 2>/dev/null; do sleep 1; done
phase='acquiring update lock'
mkdir -- "$lock"
owns_lock=1
phase='extracting archive'
mkdir -- "$stage"
tar -xzf ${quote(archivePath)} -C "$stage"
phase='validating update'
for entry in $entries; do test -e "$stage/$entry"; done
test -f "$stage/runtime/node"
test -f "$stage/app/node_modules/copilot-changelog-cli/dist/cli.js"
mkdir -- "$backup"
printf 'Update in progress; recovery backup: %s\\n' "$backup" > "$log"
phase='backing up installation'
for entry in $entries; do
  if [ -e "$target/$entry" ]; then
    mv -- "$target/$entry" "$backup/$entry"
    backed_up="$entry $backed_up"
  fi
done
phase='installing managed files'
for entry in $entries; do
  test ! -e "$target/$entry"
  mv -- "$stage/$entry" "$target/$entry"
  installed="$entry $installed"
done
committed=1
`;
}

async function launchUpdateHelper(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function launchPortableUpdate(
  environment: UpdateEnvironment,
  root: string,
  archivePath: string,
  temporaryDirectory: string,
): Promise<void> {
  const windows = environment.platform === "win32";
  const scriptPath = join(temporaryDirectory, windows ? "apply-update.ps1" : "apply-update.sh");
  await writeFile(scriptPath, portableUpdateScript(environment, root, archivePath, temporaryDirectory));
  if (!windows) await chmod(scriptPath, 0o700);
  await launchUpdateHelper(windows ? "powershell.exe" : "sh",
    windows ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath] : [scriptPath]);
}

async function installUpdate(
  installation: InstallationType,
  environment: UpdateEnvironment,
  assetPath: string | undefined,
  root: string | undefined,
  version: string,
  temporaryDirectory: string,
): Promise<string> {
  if (installation === "npm") {
    const args = [
      "install",
      "--global",
      `${packageName}@${version}`,
    ];
    if (environment.platform === "win32") {
      run(environment.execPath, [windowsNpmEntrypoint(environment.execPath), ...args]);
    } else {
      run("npm", args);
    }
    return `Updated to ${version}.`;
  }
  if (!assetPath) throw new Error("The selected update has no downloadable asset.");
  if (installation === "windows-installer") {
    const scriptPath = join(temporaryDirectory, "install-update.ps1");
    const logPath = join(root ?? dirname(assetPath), ".copilot-changelog-update.log");
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `Wait-Process -Id ${process.pid} -ErrorAction SilentlyContinue`,
      "Start-Sleep -Seconds 2",
      `try {`,
      `  $process = Start-Process -FilePath '${assetPath.replaceAll("'", "''")}' -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/CLOSEAPPLICATIONS' -Wait -PassThru`,
      `  if ($process.ExitCode -ne 0) { throw "Installer exited with code $($process.ExitCode)." }`,
      `  Set-Content -LiteralPath '${logPath.replaceAll("'", "''")}' -Value 'Update completed successfully.'`,
      `} catch {`,
      `  Set-Content -LiteralPath '${logPath.replaceAll("'", "''")}' -Value ('Update failed: ' + $_.Exception.Message)`,
      `} finally {`,
      `  Remove-Item -LiteralPath '${temporaryDirectory.replaceAll("'", "''")}' -Recurse -Force -ErrorAction SilentlyContinue`,
      `  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue`,
      `}`,
    ].join("\r\n");
    await writeFile(scriptPath, script);
    await launchUpdateHelper("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath]);
    return `Update ${version} will be installed after this process exits.`;
  }
  if (installation === "linux-package") {
    run("sudo", ["dpkg", "-i", assetPath]);
    return `Updated to ${version}.`;
  }
  if (installation === "macos-package") {
    run("sudo", ["installer", "-pkg", assetPath, "-target", "/"]);
    return `Updated to ${version}.`;
  }
  if (!root) throw new Error("Portable installation root could not be detected.");
  await launchPortableUpdate(environment, root, assetPath, temporaryDirectory);
  return `Update ${version} will be applied after this process exits.`;
}

export async function updateCli(currentVersion: string, options: UpdateOptions = {}): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.requestTimeoutMs ?? 30_000;
  const downloadTimeoutMs = options.requestTimeoutMs ?? 300_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error("Update requestTimeoutMs must be a positive number no greater than 2147483647.");
  }
  const environment = options.environment ?? {
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
  };
  if (!["x64", "arm64"].includes(environment.arch)) {
    throw new Error(`Self-update is not supported on architecture ${environment.arch}.`);
  }

  const release = await fetchRelease(fetchImpl, timeoutMs);
  const latestVersion = release.tag_name.replace(/^v/, "");
  if (compareVersions(latestVersion, currentVersion) <= 0) {
    return `Already up to date (${currentVersion}).`;
  }
  if (options.checkOnly) {
    return `Update available: ${currentVersion} -> ${latestVersion}\n${release.html_url}`;
  }

  const installation = detectInstallation(environment);
  const assetName = selectAssetName(latestVersion, installation.type, environment.platform, environment.arch);
  if (!assetName) {
    return installUpdate(installation.type, environment, undefined, undefined, latestVersion, "");
  }

  const asset = release.assets.find((candidate) => candidate.name === assetName);
  const checksumAsset = release.assets.find((candidate) => candidate.name === "SHA256SUMS");
  if (!asset) throw new Error(`Release ${release.tag_name} does not contain ${assetName}.`);
  if (!checksumAsset) throw new Error(`Release ${release.tag_name} does not contain SHA256SUMS.`);

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "copilot-changelog-update-"));
  try {
    const assetPath = join(temporaryDirectory, asset.name);
    const checksumPath = join(temporaryDirectory, checksumAsset.name);
    const [content] = await Promise.all([
      download(fetchImpl, asset, assetPath, downloadTimeoutMs),
      download(fetchImpl, checksumAsset, checksumPath, downloadTimeoutMs),
    ]);
    const expected = checksumForAsset(await readFile(checksumPath, "utf8"), asset.name);
    const actual = createHash("sha256").update(content).digest("hex");
    if (actual !== expected) throw new Error(`Checksum verification failed for ${asset.name}.`);

    const result = await installUpdate(
      installation.type,
      environment,
      assetPath,
      installation.root,
      latestVersion,
      temporaryDirectory,
    );
    if (installation.type === "linux-package" || installation.type === "macos-package") {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
    return result;
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

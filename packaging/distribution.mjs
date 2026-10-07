import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const packageName = "copilot-changelog-cli";
const commandName = "copilot-changelog";
const installerAppId = "{AD667075-8C1E-4CDB-91CC-E7DB68A5C6AE}_is1";

export function stableVersion(tag) {
  if (typeof tag !== "string" || !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag) || tag.trim() !== tag) {
    throw new Error("Distribution requires a stable vX.Y.Z tag; prereleases are not published to package managers.");
  }
  return tag.slice(1);
}

export function validateRepository(repository) {
  if (typeof repository !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository) ||
    repository.trim() !== repository) {
    throw new Error(`Invalid GitHub repository: ${repository}`);
  }
  return repository;
}

export function validatePackageId(packageId) {
  if (typeof packageId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/.test(packageId) ||
    packageId.trim() !== packageId) {
    throw new Error("WINGET_PACKAGE_ID must use a Publisher.Package identifier.");
  }
  return packageId;
}

export function assetNames(version) {
  return {
    installer: `${commandName}-${version}-setup.exe`,
    windows: `${commandName}-${version}-win-x64.zip`,
    linuxX64: `${commandName}-${version}-linux-x64.tar.gz`,
    linuxArm64: `${commandName}-${version}-linux-arm64.tar.gz`,
    macosX64: `${commandName}-${version}-darwin-x64.tar.gz`,
    macosArm64: `${commandName}-${version}-darwin-arm64.tar.gz`,
  };
}

export function parseChecksums(text) {
  const checksums = new Map();
  for (const line of text.split(/\r?\n/).filter((entry) => entry.trim())) {
    const match = /^([a-fA-F0-9]{64}) [ *]([^/\\]+)$/.exec(line);
    if (!match || checksums.has(match[2])) throw new Error(`Invalid or duplicate release checksum line: ${line}`);
    checksums.set(match[2], match[1].toLowerCase());
  }
  return checksums;
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function manifestHeader(type) {
  return `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.1.12.0.schema.json\n`;
}

/** Generate definitions only after every referenced binary matches the published checksum. */
export async function prepareDistribution({ tag, repository, commit, assets, output, packageId }) {
  const version = stableVersion(tag);
  validateRepository(repository);
  validatePackageId(packageId);
  if (typeof commit !== "string" || commit.length !== 40 || !/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error("An immutable source commit is required.");
  }
  const names = assetNames(version);
  const checksums = parseChecksums(await readFile(join(assets, "SHA256SUMS"), "utf8"));
  for (const name of Object.values(names)) {
    const expected = checksums.get(name);
    if (!expected) throw new Error(`SHA256SUMS does not contain ${name}.`);
    if (await sha256(join(assets, name)) !== expected) throw new Error(`Checksum verification failed for ${name}.`);
  }
  const homepage = `https://github.com/${repository}`;
  const url = (name) => `${homepage}/releases/download/${tag}/${name}`;
  const quote = JSON.stringify;
  const common = `PackageIdentifier: ${quote(packageId)}\nPackageVersion: ${quote(version)}\n`;
  const manifestPath = join("winget", "manifests", packageId[0].toLowerCase(), ...packageId.split("."), version);
  const files = new Map([
    [join(manifestPath, `${packageId}.yaml`),
      manifestHeader("version") + common + "DefaultLocale: en-US\nManifestType: version\nManifestVersion: 1.12.0\n"],
    [join(manifestPath, `${packageId}.locale.en-US.yaml`),
      manifestHeader("defaultLocale") + common +
      `PackageLocale: en-US\nPublisher: "Copilot Changelog CLI"\nPublisherUrl: ${quote(`https://github.com/${repository.split("/")[0]}`)}\n` +
      `PublisherSupportUrl: ${quote(`${homepage}/issues`)}\nPackageName: "Copilot Changelog CLI"\n` +
      `PackageUrl: ${quote(homepage)}\nLicense: MIT\nLicenseUrl: ${quote(`${homepage}/blob/${tag}/LICENSE`)}\n` +
      'ShortDescription: "Generate AI-assisted briefings from changelog and RSS/Atom articles."\n' +
      `ReleaseNotesUrl: ${quote(`${homepage}/releases/tag/${tag}`)}\nManifestType: defaultLocale\nManifestVersion: 1.12.0\n`],
    [join(manifestPath, `${packageId}.installer.yaml`),
      manifestHeader("installer") + common +
      'InstallerType: inno\nScope: user\nUpgradeBehavior: install\nCommands:\n  - copilot-changelog\n' +
      'InstallerSwitches:\n  Silent: "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART"\n  SilentWithProgress: "/SILENT /SUPPRESSMSGBOXES /NORESTART"\n' +
      `AppsAndFeaturesEntries:\n  - DisplayName: "Copilot Changelog CLI"\n    Publisher: "Copilot Changelog CLI"\n    DisplayVersion: ${quote(version)}\n    ProductCode: ${quote(installerAppId)}\n` +
      `Installers:\n  - Architecture: x64\n    InstallerUrl: ${quote(url(names.installer))}\n    InstallerSha256: ${checksums.get(names.installer).toUpperCase()}\n` +
      'ManifestType: installer\nManifestVersion: 1.12.0\n'],
  ]);
  files.set(join("scoop", "bucket", `${commandName}.json`), JSON.stringify({
    version,
    description: "Generate AI-assisted briefings from changelog and RSS/Atom articles.",
    homepage, license: "MIT",
    architecture: { "64bit": { url: url(names.windows), hash: checksums.get(names.windows) } },
    bin: `${commandName}.exe`,
    notes: [
      "Open a new terminal after installation. AI enrichment requires separate Copilot authentication.",
      "Update this installation with: scoop update copilot-changelog",
    ],
  }, null, 2) + "\n");
  const brewPlatform = (platform, arm, intel) => `  on_${platform} do
    on_arm do
      url ${quote(url(names[arm]))}
      sha256 ${quote(checksums.get(names[arm]))}
    end
    on_intel do
      url ${quote(url(names[intel]))}
      sha256 ${quote(checksums.get(names[intel]))}
    end
  end`;
  files.set(join("homebrew", "Formula", `${commandName}.rb`), `class CopilotChangelog < Formula
  desc "Generate AI-assisted briefings from changelog and RSS/Atom articles"
  homepage ${quote(homepage)}
  version ${quote(version)}
  license "MIT"

${brewPlatform("macos", "macosArm64", "macosX64")}
${brewPlatform("linux", "linuxArm64", "linuxX64")}

  def install
    libexec.install "app", "runtime", "copilot-changelog", "README.md"
    bin.install_symlink libexec/"copilot-changelog"
  end

  test do
    assert_equal version.to_s, shell_output("COPILOT_CHANGELOG_SKIP_UPDATE_CHECK=1 #{bin}/copilot-changelog --version").strip
  end
end
`);
  files.set("distribution.json", JSON.stringify({
    version, tag, repository, commit, packageId, npmPackage: packageName,
    assets: Object.fromEntries(Object.values(names).map((name) => [name, { url: url(name), sha256: checksums.get(name) }])),
    manifests: [...files.keys()].map((path) => path.replaceAll("\\", "/")),
  }, null, 2) + "\n");
  for (const [name, content] of files) {
    const path = join(output, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
  return { version, packageId, files: [...files.keys()] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: Object.fromEntries(["tag", "repository", "commit", "assets", "output", "package-id"]
      .map((key) => [key, { type: "string" }])),
  });
  for (const key of ["tag", "repository", "commit", "assets", "output", "package-id"]) {
    if (!values[key]) throw new Error(`--${key} is required.`);
  }
  const result = await prepareDistribution({
    tag: values.tag, repository: values.repository, commit: values.commit,
    assets: resolve(values.assets), output: resolve(values.output), packageId: values["package-id"],
  });
  console.log(`Prepared ${result.files.length} distribution files for ${result.version}.`);
}

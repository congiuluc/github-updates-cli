import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { stableVersion } from "./distribution.mjs";

export function assertNpmProvenanceSource(commit, workflowCommit) {
  if (!/^[a-f0-9]{40}$/.test(commit) || commit.length !== 40 || commit !== workflowCommit) {
    throw new Error("npm provenance requires the workflow to run at the released source commit. Dispatch distribute.yml with --ref <release-tag>, or create a new tag containing this workflow.");
  }
}

export async function inspectNpmPublication({ directory, registry = "https://registry.npmjs.org", fetchImpl = fetch }) {
  const metadata = JSON.parse(await readFile(resolve(directory, "distribution.json"), "utf8"));
  const version = stableVersion(metadata.tag);
  if (version !== metadata.version || metadata.npmPackage !== "copilot-changelog-cli") {
    throw new Error("Unexpected npm package name or version in distribution metadata.");
  }
  const filename = `copilot-changelog-cli-${version}.tgz`;
  const tarball = resolve(directory, filename);
  const integrity = `sha512-${createHash("sha512").update(await readFile(tarball)).digest("base64")}`;
  if (metadata.npmIntegrity !== integrity) throw new Error("Prepared npm tarball does not match its recorded integrity.");
  const response = await fetchImpl(`${registry}/${metadata.npmPackage}/${version}`, { signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) return { exists: false, tarball, version, commit: metadata.commit };
  if (!response.ok) throw new Error(`npm registry lookup failed with HTTP ${response.status}; publication was not attempted.`);
  const published = await response.json();
  if (published.dist?.integrity !== integrity) {
    throw new Error(`npm ${metadata.npmPackage}@${version} already exists with different content. Published versions are immutable.`);
  }
  return { exists: true, tarball, version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { directory: { type: "string" } } });
  if (!values.directory) throw new Error("--directory is required.");
  const result = await inspectNpmPublication({ directory: values.directory });
  if (result.exists) {
    console.log(`npm ${result.version} is already published with the same integrity.`);
  } else {
    assertNpmProvenanceSource(result.commit, process.env.GITHUB_SHA);
    const npmVersion = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim().split(".").map(Number);
    if (npmVersion[0] < 11 || (npmVersion[0] === 11 && (npmVersion[1] < 5 || (npmVersion[1] === 5 && npmVersion[2] < 1)))) {
      throw new Error("npm trusted publishing requires npm 11.5.1 or newer.");
    }
    execFileSync("npm", ["publish", result.tarball, "--access", "public", "--provenance", "--ignore-scripts",
      "--registry", "https://registry.npmjs.org"], { stdio: "inherit" });
  }
}

import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { assetNames, parseChecksums, prepareDistribution, stableVersion } from "../packaging/distribution.mjs";
import { publicationFiles, submitDistribution } from "../packaging/submit-distribution.mjs";
import { assertNpmProvenanceSource, inspectNpmPublication } from "../packaging/npm-publication.mjs";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function fixture() {
  directory = await mkdtemp(join(tmpdir(), "copilot-distribution-"));
  const names = assetNames("0.0.3");
  const hashes: Record<string, string> = {};
  for (const name of Object.values(names) as string[]) {
    const content = Buffer.from(`binary fixture for ${name}`);
    hashes[name] = createHash("sha256").update(content).digest("hex");
    await writeFile(join(directory, name), content);
  }
  await writeFile(join(directory, "SHA256SUMS"), Object.entries(hashes).map(([name, hash]) => `${hash}  ${name}\n`).join(""));
  return {
    tag: "v0.0.3", repository: "congiuluc/github-updates-cli", commit: "a".repeat(40),
    assets: directory, output: join(directory, "bundle"), packageId: "congiuluc.CopilotChangelog",
    names, hashes,
  };
}

test("generates all package definitions from immutable URLs and verified released binaries", async () => {
  const f = await fixture();
  const result = await prepareDistribution(f);
  expect(result.version).toBe("0.0.3");
  const winget = await publicationFiles(f.output, "winget");
  expect(winget.files).toHaveLength(3);
  const installer = winget.files.find((file: { path: string }) => file.path.endsWith(".installer.yaml"))!.content;
  expect(installer).toContain("InstallerType: inno");
  expect(installer).toContain("Scope: user");
  expect(installer).toContain("Architecture: x64");
  expect(installer).toContain(f.hashes[f.names.installer].toUpperCase());
  expect(installer).toContain(`/releases/download/v0.0.3/${f.names.installer}`);
  const inno = await readFile(resolve("packaging", "copilot-changelog.iss"), "utf8");
  expect(inno).toContain("AppId={{AD667075-8C1E-4CDB-91CC-E7DB68A5C6AE}");
  expect(installer).toContain("{AD667075-8C1E-4CDB-91CC-E7DB68A5C6AE}_is1");
  expect(inno).toContain("AppPublisher=Copilot Changelog CLI");
  const scoop = JSON.parse((await publicationFiles(f.output, "scoop")).files[0].content);
  expect(scoop.version).toBe("0.0.3");
  expect(scoop.bin).toBe("copilot-changelog.exe");
  expect(scoop.architecture["64bit"].hash).toBe(f.hashes[f.names.windows]);
  const brew = (await publicationFiles(f.output, "homebrew")).files[0].content;
  expect(brew).toContain("class CopilotChangelog < Formula");
  expect(brew).toContain('bin.install_symlink libexec/"copilot-changelog"');
  expect(brew).toContain("on_macos do");
  expect(brew).toContain("on_linux do");
  for (const name of [f.names.macosArm64, f.names.macosX64, f.names.linuxArm64, f.names.linuxX64]) {
    expect(brew).toContain(f.hashes[name]);
    expect(brew).toContain(`/releases/download/v0.0.3/${name}`);
  }
  for (const channel of ["scoop", "winget", "homebrew"]) {
    for (const file of (await publicationFiles(f.output, channel)).files) {
      expect(file.content).not.toContain("/releases/latest");
    }
  }
});

test.each(["v1.2.3-rc.1", "v01.2.3", "v1.2.3+build", "1.2.3", "v1.2.3\n", "../v1.2.3"])(
  "refuses non-stable or unsafe tag %j", (tag) => {
    expect(() => stableVersion(tag)).toThrow("stable vX.Y.Z");
  },
);

test.each(["mismatch", "missing", "duplicate", "unsafe-id", "unsafe-repository", "missing-commit"])(
  "does not emit success-shaped manifests after %s validation failure", async (kind) => {
    const f = await fixture();
    if (kind === "mismatch") await writeFile(join(f.assets, f.names.installer), "tampered");
    if (kind === "missing") await writeFile(join(f.assets, "SHA256SUMS"), "");
    if (kind === "duplicate") {
      const sums = await readFile(join(f.assets, "SHA256SUMS"), "utf8");
      await writeFile(join(f.assets, "SHA256SUMS"), sums + sums.split("\n")[0]);
    }
    if (kind === "unsafe-id") f.packageId = "../../evil";
    if (kind === "unsafe-repository") f.repository = 'owner/repo"; injected';
    if (kind === "missing-commit") f.commit = "main";
    await expect(prepareDistribution(f)).rejects.toThrow();
    await expect(readdir(f.output)).rejects.toThrow();
  },
);

test("rejects checksum paths instead of accepting traversal entries", () => {
  expect(() => parseChecksums(`${"a".repeat(64)}  ../installer.exe`)).toThrow("Invalid");
});

test("npm provenance never silently attributes an older tagged package to a newer workflow commit", () => {
  expect(() => assertNpmProvenanceSource("a".repeat(40), "a".repeat(40))).not.toThrow();
  expect(() => assertNpmProvenanceSource("a".repeat(40), "b".repeat(40))).toThrow("--ref <release-tag>");
  expect(() => assertNpmProvenanceSource("main", "main")).toThrow("released source commit");
});

test("opens a reviewed package PR without writing to the default branch", async () => {
  const f = await fixture();
  await prepareDistribution(f);
  const requests: { route: string; method: string; body?: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, options: RequestInit) => {
    const route = String(input).replace("https://api.github.com/", "");
    const method = options.method ?? "GET";
    const body = options.body ? JSON.parse(String(options.body)) : undefined;
    requests.push({ route, method, body });
    if (route === "repos/example/scoop-bucket") return Response.json({ default_branch: "main" });
    if (route.includes("/contents/") || route.includes("/git/ref/heads/copilot-changelog")) return new Response("", { status: 404 });
    if (route.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: "base" } });
    if (route.endsWith("/git/commits/base")) return Response.json({ tree: { sha: "base-tree" } });
    if (route.endsWith("/git/blobs")) return Response.json({ sha: "blob" });
    if (route.endsWith("/git/trees")) return Response.json({ sha: "tree" });
    if (route.endsWith("/git/commits")) return Response.json({ sha: "next" });
    if (route.endsWith("/git/refs")) return Response.json({ ref: "branch" });
    if (route.includes("/pulls?")) return Response.json([]);
    if (route.endsWith("/pulls")) return Response.json({ html_url: "https://github.com/example/scoop-bucket/pull/1" });
    throw new Error(`Unexpected ${method} ${route}`);
  });
  const result = await submitDistribution({
    directory: f.output, channel: "scoop", repository: "example/scoop-bucket", token: "fake-test-token", fetchImpl,
  });
  expect(result.status).toBe("opened-pr");
  expect(requests.find((entry) => entry.route.endsWith("/git/refs"))?.body).toEqual({
    ref: "refs/heads/copilot-changelog/scoop/0.0.3", sha: "next",
  });
  expect(requests.some((entry) => entry.method === "PATCH" || entry.method === "PUT")).toBe(false);
  expect(requests.find((entry) => entry.route.endsWith("/pulls"))?.body).toMatchObject({
    head: "example:copilot-changelog/scoop/0.0.3", base: "main",
  });
});

test("a publication rerun reuses an identical open PR", async () => {
  const f = await fixture();
  await prepareDistribution(f);
  const { files } = await publicationFiles(f.output, "homebrew");
  const fetchImpl = vi.fn(async (input: string | URL | Request, options: RequestInit) => {
    const url = String(input);
    expect(options.method).toBe("GET");
    if (url.endsWith("repos/example/homebrew-tools")) return Response.json({ default_branch: "main" });
    if (url.includes("/contents/") && url.endsWith("ref=main")) return new Response("", { status: 404 });
    if (url.includes("/contents/")) return Response.json({ type: "file", encoding: "base64", content: Buffer.from(files[0].content).toString("base64") });
    if (url.includes("/git/ref/heads/")) return Response.json({ object: { sha: "existing" } });
    if (url.includes("/pulls?")) return Response.json([{ state: "open", html_url: "https://github.com/example/homebrew-tools/pull/2" }]);
    throw new Error(`Unexpected ${url}`);
  });
  await expect(submitDistribution({
    directory: f.output, channel: "homebrew", repository: "example/homebrew-tools", token: "fake-test-token", fetchImpl,
  })).resolves.toMatchObject({ status: "existing-pr" });
});

test.each(["already-published", "conflicting-branch", "closed-pr"] as const)(
  "registry retry handles %s without overwriting files", async (state) => {
    const f = await fixture();
    await prepareDistribution(f);
    const { files } = await publicationFiles(f.output, "scoop");
    const fetchImpl = vi.fn(async (input: string | URL | Request, options: RequestInit) => {
      expect(options.method).toBe("GET");
      const url = String(input);
      if (url.endsWith("repos/example/bucket")) return Response.json({ default_branch: "main", html_url: "https://github.com/example/bucket" });
      if (url.includes("/contents/")) {
        if (url.endsWith("ref=main") && state !== "already-published") return new Response("", { status: 404 });
        return Response.json({ type: "file", encoding: "base64",
          content: Buffer.from(state === "conflicting-branch" ? "{}" : files[0].content).toString("base64") });
      }
      if (url.includes("/git/ref/heads/")) return Response.json({ object: { sha: "existing" } });
      if (url.includes("/pulls?")) return Response.json([{ state: "closed", merged_at: null }]);
      throw new Error(`Unexpected request ${url}`);
    });
    const result = submitDistribution({
      directory: f.output, channel: "scoop", repository: "example/bucket", token: "fake", fetchImpl,
    });
    if (state === "already-published") await expect(result).resolves.toMatchObject({ status: "already-published" });
    else await expect(result).rejects.toThrow(state === "closed-pr" ? "was closed" : "different contents");
  },
);

test("WinGet submission requires a real fork and explicit credentials", async () => {
  const f = await fixture();
  await prepareDistribution(f);
  const fetchImpl = vi.fn(async () => Response.json({ default_branch: "master", fork: false }));
  await expect(submitDistribution({
    directory: f.output, channel: "winget", repository: "example/winget-pkgs", token: "", fetchImpl,
  })).rejects.toThrow("token is required");
  expect(fetchImpl).not.toHaveBeenCalled();
  await expect(submitDistribution({
    directory: f.output, channel: "winget", repository: "example/winget-pkgs", token: "fake", fetchImpl,
  })).rejects.toThrow("must be a fork");
});

test("API authentication failures never become an empty successful publication", async () => {
  const f = await fixture();
  await prepareDistribution(f);
  await expect(submitDistribution({
    directory: f.output, channel: "scoop", repository: "example/bucket", token: "fake",
    fetchImpl: async () => new Response("Forbidden", { status: 403 }),
  })).rejects.toThrow("HTTP 403");
});

test.each(["new", "identical", "different", "unavailable"] as const)(
  "npm publication preflight handles %s registry state safely", async (state) => {
    const f = await fixture();
    await prepareDistribution(f);
    const tarball = Buffer.from("prepared npm tarball fixture");
    const npmIntegrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
    await writeFile(join(f.output, "copilot-changelog-cli-0.0.3.tgz"), tarball);
    const metadataPath = join(f.output, "distribution.json");
    await writeFile(metadataPath, JSON.stringify({ ...JSON.parse(await readFile(metadataPath, "utf8")), npmIntegrity }));
    const check = inspectNpmPublication({ directory: f.output, fetchImpl: async () => {
      if (state === "new") return new Response("", { status: 404 });
      if (state === "unavailable") return new Response("", { status: 503 });
      return Response.json({ dist: { integrity: state === "identical" ? npmIntegrity : "other" } });
    } });
    if (state === "different") await expect(check).rejects.toThrow("immutable");
    else if (state === "unavailable") await expect(check).rejects.toThrow("HTTP 503");
    else await expect(check).resolves.toMatchObject({ exists: state === "identical", version: "0.0.3" });
  },
);

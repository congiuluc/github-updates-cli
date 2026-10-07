import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, test, vi } from "vitest";

const root = resolve(import.meta.dirname, "..");
const readRelease = async () => (await readFile(join(root, ".github", "workflows", "release.yml"), "utf8")).replace(/\r\n/g, "\n");
const job = (workflow: string, name: string) => workflow.split(`\n  ${name}:`)[1]?.split(/\n  [a-z-]+:/)[0] ?? "";

async function resolveSource(env: Record<string, string>, missingTag = false) {
  const workflow = await readRelease();
  const verification = job(workflow, "verify-version");
  const script = verification.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n          NODE/)?.[1];
  expect(script, "release source resolution must be inline so old tags need no new helpers").toBeDefined();
  const taggedCommit = "5".repeat(40);
  const workflowCommit = "a".repeat(40);
  const git = vi.fn((command: string, args: string[]) => {
    expect(command).toBe("git");
    if (args[0] === "rev-parse") {
      expect(args[1]).toBe("--verify");
      if (args[2] === "HEAD") return `${workflowCommit}\n`;
      expect(args[2]).toBe(`refs/tags/${env.REQUESTED_TAG || env.GITHUB_REF_NAME}^{commit}`);
      if (missingTag) throw new Error("Tag does not exist");
      return `${taggedCommit}\n`;
    }
    expect(args).toEqual(["show", `${workflowCommit}:package.json`]);
    return '{"version":"0.0.1"}';
  });
  let output = "";
  let error: unknown;
  try {
    runInNewContext(script!.replace(/^\s*import .*;\n/gm, ""), {
      process: { env: { GITHUB_OUTPUT: "outputs", ...env } },
      execFileSync: git,
      appendFileSync: (path: string, value: string) => {
        expect(path).toBe("outputs");
        output += value;
      },
    });
  } catch (cause) {
    error = cause;
  }
  return { git, output, error, taggedCommit, workflowCommit };
}

test("manual tag recovery resolves the existing tag rather than the workflow branch", async () => {
  const workflow = await readRelease();
  expect(workflow).toMatch(/workflow_dispatch:\s+inputs:\s+tag:\s+description:[^\n]+\s+required: false\s+type: string/);
  const verification = job(workflow, "verify-version");
  expect(verification).toContain("fetch-depth: 0");
  expect(verification).toContain("REQUESTED_TAG: ${{ inputs.tag }}");
  for (const output of ["version", "commit", "tag"]) {
    expect(verification).toContain(`${output}: \${{ steps.source.outputs.${output} }}`);
  }
  const result = await resolveSource({
    GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "main", REQUESTED_TAG: "v0.0.2",
  });
  expect(result.error).toBeUndefined();
  expect(result.output).toContain(`commit=${result.taggedCommit}\n`);
  expect(result.output).toContain("version=0.0.2\n");
  expect(result.output).toContain("tag=v0.0.2\n");
  expect(result.output).not.toContain(result.workflowCommit);
});

test.each(["v0.0.2", "v1.2.3-rc.1", "v1.2.3-0", "v1.2.3-01alpha.2"])(
  "tag push %s supplies its own validated package version", async (tag) => {
    const result = await resolveSource({
      GITHUB_EVENT_NAME: "push", GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: tag,
    });
    expect(result.error).toBeUndefined();
    expect(result.output).toContain(`commit=${result.taggedCommit}\n`);
    expect(result.output).toContain(`version=${tag.slice(1)}\n`);
    expect(result.output).toContain(`tag=${tag}\n`);
    expect(result.git).toHaveBeenCalledTimes(1);
  },
);

test.each([
  "0.0.2", "v1.2", "v01.2.3", "v1.2.3-01", "v1.2.3-rc..1", "v1.2.3-",
  "v1.2.3;echo injected", "v1.2.3$(echo injected)", "v1.2.3\ncommit=injected", "--help", " v1.2.3",
])("invalid or unsafe tag %j is rejected before invoking git", async (tag) => {
  const result = await resolveSource({ GITHUB_EVENT_NAME: "workflow_dispatch", REQUESTED_TAG: tag });
  expect(String(result.error)).toContain("Expected a release tag");
  expect(result.git).not.toHaveBeenCalled();
  expect(result.output).toBe("");
});

test("a missing release tag fails without falling back to main", async () => {
  const result = await resolveSource({ GITHUB_EVENT_NAME: "workflow_dispatch", REQUESTED_TAG: "v9.9.9" }, true);
  expect(String(result.error)).toContain("Tag does not exist");
  expect(result.git).toHaveBeenCalledTimes(1);
  expect(result.output).toBe("");
});

test.each(["branch", "tag"])("manual builds without a tag input never publish, even from a %s ref", async (refType) => {
  const result = await resolveSource({
    GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF_TYPE: refType, GITHUB_REF_NAME: "v0.0.2", REQUESTED_TAG: "",
  });
  expect(result.error).toBeUndefined();
  expect(result.output).toContain(`commit=${result.workflowCommit}\n`);
  expect(result.output).toContain("version=0.0.1\n");
  expect(result.output).toContain("tag=\n");
});

test("every validation and packaging job checks out the resolved commit and stamps before installing", async () => {
  const workflow = await readRelease();
  for (const name of ["validate", "windows", "linux", "macos"]) {
    const source = job(workflow, name);
    expect(source).toContain("needs: verify-version");
    expect(source).toMatch(/uses: actions\/checkout@v7\s+with:\s+ref: \$\{\{ needs.verify-version.outputs.commit \}\}/);
    expect(source).toContain("if: needs.verify-version.outputs.tag != ''");
    expect(source).toContain("RELEASE_VERSION: ${{ needs.verify-version.outputs.version }}");
    expect(source).toMatch(/shell: bash\s+env:\s+RELEASE_VERSION:/);
    const command = 'npm version "$RELEASE_VERSION" --no-git-tag-version --ignore-scripts --allow-same-version';
    expect(source).toContain(command);
    expect(source.indexOf(command)).toBeLessThan(source.indexOf("npm ci"));
  }
});

test("publishing uses the resolved tag, marks prereleases, and verifies an existing tag", async () => {
  const workflow = await readRelease();
  const publication = job(workflow, "publish");
  expect(publication).toContain("if: needs.verify-version.outputs.tag != ''");
  expect(publication).toContain("RELEASE_TAG: ${{ needs.verify-version.outputs.tag }}");
  expect(publication).toContain('gh release create "$RELEASE_TAG"');
  expect(publication).toContain('--title "Copilot Changelog CLI ${RELEASE_TAG}"');
  expect(publication).toContain("--verify-tag");
  expect(publication).toContain('if [[ "$RELEASE_TAG" == *-* ]]');
  expect(publication).toContain("--prerelease");
  expect(publication).not.toContain("GITHUB_REF_NAME");
  expect(workflow).not.toContain('does not match package version');
});

test.each(["0.0.2", "1.2.3-rc.1", "0.0.1"])(
  "version stamping to %s changes only package and lockfile root versions without lifecycle scripts", async (version) => {
    const fixture = await mkdtemp(join(root, ".packaging-release-version-"));
    try {
      const [manifest, lockfile] = await Promise.all([
        readFile(join(root, "package.json"), "utf8"), readFile(join(root, "package-lock.json"), "utf8"),
      ]);
      const originalPackage = JSON.parse(manifest);
      for (const script of ["preversion", "version", "postversion"]) {
        originalPackage.scripts[script] = 'node -e "process.exit(99)"';
      }
      const originalLock = JSON.parse(lockfile);
      await writeFile(join(fixture, "package.json"), JSON.stringify(originalPackage, null, 2));
      await writeFile(join(fixture, "package-lock.json"), lockfile);
      const args = ["version", version, "--no-git-tag-version", "--ignore-scripts", "--allow-same-version"];
      const npmCli = process.env.npm_execpath;
      const result = npmCli
        ? spawnSync(process.execPath, [npmCli, ...args], { cwd: fixture, encoding: "utf8", timeout: 20_000 })
        : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
          cwd: fixture, encoding: "utf8", timeout: 20_000, shell: process.platform === "win32",
        });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const stampedPackage = JSON.parse(await readFile(join(fixture, "package.json"), "utf8"));
      const stampedLock = JSON.parse(await readFile(join(fixture, "package-lock.json"), "utf8"));
      expect(stampedPackage).toEqual({ ...originalPackage, version });
      expect(stampedLock).toEqual({
        ...originalLock, version,
        packages: { ...originalLock.packages, "": { ...originalLock.packages[""], version } },
      });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  }, 30_000,
);

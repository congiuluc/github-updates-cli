import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, test, vi } from "vitest";
import { assetNames, stableVersion } from "../packaging/distribution.mjs";

const release = (await readFile(resolve(".github", "workflows", "release.yml"), "utf8")).replace(/\r\n/g, "\n");
const workflow = (await readFile(resolve(".github", "workflows", "distribute.yml"), "utf8")).replace(/\r\n/g, "\n");
const job = (name: string) => workflow.split(`\n  ${name}:`)[1]?.split(/\n  [a-z-]+:/)[0] ?? "";
const scripts = [...workflow.matchAll(/node --input-type=module <<'NODE'\n([\s\S]*?)\n          NODE/g)]
  .map((match) => match[1].replace(/^\s*import .*;\n/gm, ""));

test("distribution runs explicitly after successful stable release creation, not a release event", () => {
  const call = release.split("\n  distribute:")[1];
  expect(call).toContain("needs: [verify-version, publish]");
  expect(call).toContain("!contains(needs.verify-version.outputs.version, '-')");
  expect(call).toContain("uses: ./.github/workflows/distribute.yml");
  expect(call).toContain("source-commit: ${{ needs.verify-version.outputs.commit }}");
  expect(call).toContain("secrets: inherit");
  expect(workflow).toContain("workflow_call:");
  expect(workflow).toContain("workflow_dispatch:");
  expect(workflow).not.toMatch(/\n  release:/);
  expect(workflow).toContain("cancel-in-progress: false");
});

test("preparation separates workflow tooling from the exact released npm source", () => {
  const prepare = job("prepare");
  expect(prepare).toContain("ref: ${{ github.workflow_sha }}");
  expect(prepare).toContain("ref: ${{ steps.release.outputs.commit }}");
  expect(prepare).toContain("npm version \"$RELEASE_VERSION\" --no-git-tag-version --ignore-scripts --allow-same-version");
  expect(prepare).toContain("npm ci");
  expect(prepare).toContain('npm pack --pack-destination "$GITHUB_WORKSPACE/distribution"');
  expect(prepare).toContain("Generate checksum-verified package definitions");
  expect(prepare).toContain("npmIntegrity");
  expect(prepare).toContain("ruby -c distribution/homebrew/Formula/copilot-changelog.rb");
  expect(prepare).toContain("if-no-files-found: error");
  expect(prepare).not.toContain("continue-on-error");
});

test.each([
  ["stable", false, false, "a".repeat(40), true],
  ["draft", true, false, "a".repeat(40), false],
  ["prerelease", false, true, "a".repeat(40), false],
  ["moved tag", false, false, "b".repeat(40), false],
] as const)("release verification handles %s before downloading anything", (_kind, isDraft, isPrerelease, expectedCommit, succeeds) => {
  const git = "a".repeat(40);
  const execFileSync = vi.fn((command: string, args: string[]) => {
    if (command === "git") return git;
    if (args[1] === "view") return JSON.stringify({
      tagName: "v0.0.3", isDraft, isPrerelease,
      assets: ["SHA256SUMS", ...Object.values(assetNames("0.0.3"))].map((name) => ({ name })),
    });
    if (args[1] === "download") return "";
    throw new Error("Unexpected command");
  });
  const appendFileSync = vi.fn();
  const run = () => runInNewContext(scripts[0], {
    stableVersion, assetNames, execFileSync, appendFileSync, mkdirSync: vi.fn(),
    process: { env: { RELEASE_TAG: "v0.0.3", EXPECTED_COMMIT: expectedCommit, GITHUB_REPOSITORY: "owner/repo", GITHUB_OUTPUT: "out" } },
  });
  if (succeeds) {
    run();
    expect(appendFileSync).toHaveBeenCalledWith("out", `commit=${git}\nversion=0.0.3\n`);
    expect(execFileSync.mock.calls.some(([, args]) => args[1] === "download")).toBe(true);
  } else {
    expect(run).toThrow();
    expect(execFileSync.mock.calls.some(([, args]) => args[1] === "download")).toBe(false);
  }
});

test.each(["winget", "scoop", "homebrew"])("%s publication is disabled by default and fails clearly when enabled without setup", (channel) => {
  const preflight = scripts.find((script) => script.includes("const channel = process.env.CHANNEL"));
  expect(preflight).toBeDefined();
  const output = vi.fn();
  const environment: Record<string, string> = { CHANNEL: channel, GITHUB_OUTPUT: "out", GITHUB_STEP_SUMMARY: "summary" };
  const run = () => runInNewContext(preflight!, { process: { env: environment }, appendFileSync: output });
  run();
  expect(output).toHaveBeenCalledWith("out", "enabled=false\nrepository=\n");
  environment[`${channel.toUpperCase()}_ENABLED`] = "true";
  expect(run).toThrow("repository or publication token is missing");
  environment[`${channel.toUpperCase()}_REPOSITORY`] = "owner/packages";
  environment[`${channel.toUpperCase()}_TOKEN`] = "fake-test-token";
  run();
  expect(output).toHaveBeenCalledWith("out", "enabled=true\nrepository=owner/packages\n");
  environment[`${channel.toUpperCase()}_REPOSITORY`] = "owner/packages\ninjected=true";
  expect(run).toThrow("Invalid");
});

test("npm publication is opt-in, uses OIDC and publishes the prepared artifact without lifecycle scripts", async () => {
  const npm = job("npm");
  expect(npm).toContain("if: vars.PUBLISH_NPM == 'true'");
  expect(npm).toContain("id-token: write");
  expect(npm).toContain("working-directory: source");
  expect(npm).toContain("packaging/npm-publication.mjs");
  expect(npm).not.toContain("NPM_TOKEN");
  const helper = await readFile(resolve("packaging", "npm-publication.mjs"), "utf8");
  expect(helper).toContain('"--ignore-scripts"');
  expect(helper).toContain('"--provenance"');
  expect(helper).toContain("Published versions are immutable");
});

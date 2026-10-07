import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { stableVersion, validatePackageId, validateRepository } from "./distribution.mjs";

class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function github(token, route, method = "GET", body, fetchImpl = fetch) {
  const response = await fetchImpl(`https://api.github.com/${route}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "copilot-changelog-distribution",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new GitHubError(response.status, `GitHub ${method} ${route} failed with HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  return response.status === 204 ? undefined : response.json();
}

export async function publicationFiles(directory, channel) {
  const metadata = JSON.parse(await readFile(join(directory, "distribution.json"), "utf8"));
  if (metadata.version !== stableVersion(metadata.tag)) throw new Error("Distribution version and tag do not match.");
  validateRepository(metadata.repository);
  validatePackageId(metadata.packageId);
  if (typeof metadata.commit !== "string" || metadata.commit.length !== 40 || !/^[a-f0-9]{40}$/.test(metadata.commit)) {
    throw new Error("Invalid source commit in distribution metadata.");
  }
  let paths;
  if (channel === "winget") {
    const prefix = `manifests/${metadata.packageId[0].toLowerCase()}/${metadata.packageId.replaceAll(".", "/")}/${metadata.version}`;
    paths = [`${prefix}/${metadata.packageId}.yaml`, `${prefix}/${metadata.packageId}.installer.yaml`,
      `${prefix}/${metadata.packageId}.locale.en-US.yaml`];
  } else if (channel === "scoop") {
    paths = ["bucket/copilot-changelog.json"];
  } else if (channel === "homebrew") {
    paths = ["Formula/copilot-changelog.rb"];
  } else {
    throw new Error(`Unsupported distribution channel: ${channel}`);
  }
  const files = await Promise.all(paths.map(async (path) => ({
    path, content: await readFile(join(directory, channel, ...path.split("/")), "utf8"),
  })));
  return { metadata, files };
}

/** Open reviewable PRs only; never force-push a branch or modify a registry's default branch. */
export async function submitDistribution({
  directory, channel, repository, token, fetchImpl = fetch,
}) {
  if (!token) throw new Error(`A publication token is required for ${channel}.`);
  validateRepository(repository);
  const { metadata, files } = await publicationFiles(directory, channel);
  const target = channel === "winget" ? "microsoft/winget-pkgs" : repository;
  if (channel === "winget" && repository.toLowerCase() === target) {
    throw new Error("WINGET_FORK must name your fork, not microsoft/winget-pkgs.");
  }
  const api = (route, method, body) => github(token, route, method, body, fetchImpl);
  const targetInfo = await api(`repos/${target}`);
  const forkInfo = target === repository ? targetInfo : await api(`repos/${repository}`);
  if (channel === "winget" && (!forkInfo.fork || forkInfo.parent?.full_name?.toLowerCase() !== target)) {
    throw new Error(`${repository} must be a fork of microsoft/winget-pkgs.`);
  }
  const defaultBranch = targetInfo.default_branch;
  if (!defaultBranch) throw new Error(`${target} has no default branch. Initialize the repository first.`);
  const branch = `copilot-changelog/${channel}/${metadata.version}`;
  const readContent = async (repo, ref, path) => {
    try {
      const file = await api(`repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`);
      if (file.type !== "file" || file.encoding !== "base64") throw new Error(`Cannot compare publication file ${path}.`);
      return Buffer.from(file.content, "base64").toString("utf8");
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return undefined;
      throw error;
    }
  };
  const baseContents = await Promise.all(files.map((file) => readContent(target, defaultBranch, file.path)));
  if (files.every((file, index) => file.content === baseContents[index])) {
    return { status: "already-published", url: targetInfo.html_url };
  }
  if (channel === "winget" && baseContents.some((content) => content !== undefined)) {
    throw new Error("This WinGet version already exists with different manifests. Do not replace published versions.");
  }
  let existingBranch;
  try {
    existingBranch = await api(`repos/${repository}/git/ref/heads/${branch}`);
  } catch (error) {
    if (!(error instanceof GitHubError && error.status === 404)) throw error;
  }
  if (existingBranch) {
    const contents = await Promise.all(files.map((file) => readContent(repository, branch, file.path)));
    if (!files.every((file, index) => file.content === contents[index])) {
      throw new Error(`Publication branch ${branch} already exists with different contents. Review it manually; it will not be overwritten.`);
    }
  } else {
    const base = await api(`repos/${target}/git/ref/heads/${defaultBranch}`);
    const commit = await api(`repos/${target}/git/commits/${base.object.sha}`);
    const blobs = await Promise.all(files.map(async (file) => ({
      path: file.path, mode: "100644", type: "blob",
      sha: (await api(`repos/${repository}/git/blobs`, "POST", { content: file.content, encoding: "utf-8" })).sha,
    })));
    const tree = await api(`repos/${repository}/git/trees`, "POST", { base_tree: commit.tree.sha, tree: blobs });
    const next = await api(`repos/${repository}/git/commits`, "POST", {
      message: `Update Copilot Changelog CLI to ${metadata.version}\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`,
      tree: tree.sha, parents: [base.object.sha],
    });
    await api(`repos/${repository}/git/refs`, "POST", { ref: `refs/heads/${branch}`, sha: next.sha });
  }
  const owner = repository.split("/")[0];
  const head = `${owner}:${branch}`;
  const prs = await api(`repos/${target}/pulls?state=all&head=${encodeURIComponent(head)}&base=${encodeURIComponent(defaultBranch)}&per_page=10`);
  if (prs.length) {
    const open = prs.find((pr) => pr.state === "open");
    if (!open) throw new Error("A previous distribution PR was closed. Review it manually before retrying publication.");
    return { status: "existing-pr", url: open.html_url };
  }
  const pr = await api(`repos/${target}/pulls`, "POST", {
    title: `Update Copilot Changelog CLI to ${metadata.version}`,
    head, base: defaultBranch,
    body: [
      `Release: https://github.com/${metadata.repository}/releases/tag/${metadata.tag}`,
      `Source commit: ${metadata.commit}`,
      "Generated from versioned release assets verified against SHA256SUMS.",
      "Please review the package metadata and installation behavior before merging.",
    ].join("\n\n"),
  });
  return { status: "opened-pr", url: pr.html_url };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    directory: { type: "string" }, channel: { type: "string" }, repository: { type: "string" },
  } });
  for (const key of ["directory", "channel", "repository"]) if (!values[key]) throw new Error(`--${key} is required.`);
  const result = await submitDistribution({
    directory: resolve(values.directory), channel: values.channel, repository: values.repository,
    token: process.env.GH_TOKEN,
  });
  console.log(`${result.status}: ${result.url}`);
}

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const lockPath = join(repositoryRoot, "t3-upstream.lock.json");

function githubHeaders() {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "omarchy-t3code-nightly-check",
    "x-github-api-version": "2022-11-28",
    ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  };
}

async function github(path) {
  const response = await fetch(`https://api.github.com/repos/pingdotgg/t3code${path}`, {
    headers: githubHeaders(),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`GitHub API request failed (${response.status}) for ${path}.`);
  return response.json();
}

export async function readPin() {
  return JSON.parse(await readFile(lockPath, "utf8"));
}

export async function latestNightly() {
  const releases = await github("/releases?per_page=100");
  const nightlies = releases
    .filter((release) => !release.draft && release.prerelease && /-nightly\./u.test(release.tag_name) && release.published_at)
    .sort((left, right) => Date.parse(right.published_at) - Date.parse(left.published_at));
  const release = nightlies[0];
  if (!release) throw new Error("No published T3 Code Nightly release was found.");
  const commit = await github(`/commits/${encodeURIComponent(release.tag_name)}`);
  if (typeof commit.sha !== "string" || !/^[0-9a-f]{40}$/u.test(commit.sha)) {
    throw new Error(`Could not resolve ${release.tag_name} to an exact commit.`);
  }
  return {
    channel: "nightly",
    tag: release.tag_name,
    commit: commit.sha,
    publishedAt: release.published_at,
    repository: "https://github.com/pingdotgg/t3code.git",
  };
}

export async function changedCompatibilityFiles(fromCommit, toCommit) {
  if (fromCommit === toCommit) return [];
  const comparison = await github(`/compare/${fromCommit}...${toCommit}`);
  const relevant = [
    "packages/contracts/",
    "packages/client-runtime/",
    "packages/shared/",
    "apps/web/",
    "apps/mobile/",
    "apps/desktop/",
    "apps/server/",
    "infra/relay/",
    "docs/internals/",
  ];
  return (comparison.files || [])
    .map((file) => file.filename)
    .filter((filename) => relevant.some((prefix) => filename.startsWith(prefix)));
}

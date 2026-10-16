#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflows = ["native-beta.yml", "native-production.yml"];

export async function verifyReleaseActionPins(readCommit = async (repository, sha) => {
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error("GH_TOKEN is required to verify release Action commit objects");
  const response = await fetch(`https://api.github.com/repos/${repository}/git/commits/${sha}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`${repository}@${sha} is not a verified commit object (HTTP ${response.status})`);
  const commit = await response.json();
  return commit.sha;
}) {
  const pins = new Map();
  for (const workflow of workflows) {
    const source = readFileSync(path.join(root, ".github", "workflows", workflow), "utf8");
    const actions = [...source.matchAll(/^\s*(?:-\s+)?uses:\s+([\w.-]+\/[\w.-]+)@([^\s#]+)/gmu)];
    if (actions.length === 0) throw new Error(`${workflow} has no Action pins to verify`);
    for (const [, repository, sha] of actions) {
      if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error(`${workflow} has a non-SHA Action pin: ${repository}@${sha}`);
      pins.set(`${repository}@${sha}`, { repository, sha });
    }
  }
  for (const { repository, sha } of pins.values()) {
    if (await readCommit(repository, sha) !== sha) {
      throw new Error(`${repository}@${sha} did not resolve to the exact commit object`);
    }
  }
  return pins.size;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const count = await verifyReleaseActionPins();
  process.stdout.write(`Verified ${count} release Action commit objects\n`);
}

#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

function betaSeries() {
  const productVersion = JSON.parse(
    readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
  ).version;
  const match = /^(\d+\.\d+\.\d+)(?:-beta\.(\d+))?$/u.exec(productVersion);
  if (!match) {
    throw new Error(
      `The root package version must be <major>.<minor>.<patch> or end in -beta.<number>; found ${productVersion}.`,
    );
  }
  return {
    base: match[1],
  };
}

function betaNumber(tag, base) {
  const match = new RegExp(`^v${base.replaceAll(".", "\\.")}-beta\\.(\\d+)$`, "u").exec(tag);
  return match ? Number(match[1]) : undefined;
}

export function resolveBetaVersion() {
  const { base } = betaSeries();
  const tagPattern = `v${base}-beta.*`;
  const tags = git(["tag", "--list", tagPattern])
    .split("\n")
    .filter(Boolean);
  const headTags = git(["tag", "--points-at", "HEAD", "--list", tagPattern])
    .split("\n")
    .filter(Boolean);
  const exactVersions = headTags
    .map((tag) => ({ tag, number: betaNumber(tag, base) }))
    .filter((entry) => Number.isSafeInteger(entry.number));
  if (exactVersions.length > 1) {
    throw new Error(
      `The current commit has multiple beta release tags: ${exactVersions.map((entry) => entry.tag).join(", ")}.`,
    );
  }
  if (exactVersions.length === 1) {
    return {
      version: `${base}-beta.${exactVersions[0].number}`,
      tag: exactVersions[0].tag,
      existingTag: true,
    };
  }
  const highestTagged = tags.reduce((highest, tag) => {
    const number = betaNumber(tag, base);
    return Number.isSafeInteger(number) ? Math.max(highest, number) : highest;
  }, 0);
  const number = highestTagged + 1;
  return {
    version: `${base}-beta.${number}`,
    tag: `v${base}-beta.${number}`,
    existingTag: false,
  };
}

function assertCleanSource() {
  if (git(["status", "--porcelain=v1"])) {
    throw new Error("Cutting a beta requires a clean exact-source worktree.");
  }
}

function main() {
  const cut = process.argv.includes("--cut");
  const push = process.argv.includes("--push");
  const requireTag = process.argv.includes("--require-tag");
  if (push && !cut) throw new Error("--push requires --cut.");
  if (cut) {
    assertCleanSource();
    execFileSync("git", ["fetch", "--tags", "origin"], {
      cwd: repositoryRoot,
      stdio: "inherit",
    });
  }
  const resolved = resolveBetaVersion();
  if (requireTag && !resolved.existingTag) {
    throw new Error(
      `The current commit is not tagged for a beta release. Run pnpm beta:cut first.`,
    );
  }
  if (cut) {
    if (!resolved.existingTag) {
      execFileSync(
        "git",
        ["tag", "-a", resolved.tag, "-m", `Ponderosa ${resolved.version}`],
        { cwd: repositoryRoot, stdio: "inherit" },
      );
    }
    if (push) {
      execFileSync("git", ["push", "origin", resolved.tag], {
        cwd: repositoryRoot,
        stdio: "inherit",
      });
    }
  }
  process.stdout.write(`${resolved.version}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

import { accessSync, constants, readdirSync } from "node:fs";
import path from "node:path";

function compareVersionDirectoryNamesDescending(left, right) {
  const leftNumbers = left.match(/\d+/gu)?.map(Number) ?? [];
  const rightNumbers = right.match(/\d+/gu)?.map(Number) ?? [];
  const width = Math.max(leftNumbers.length, rightNumbers.length);
  for (let index = 0; index < width; index += 1) {
    const difference = (rightNumbers[index] ?? -1) - (leftNumbers[index] ?? -1);
    if (difference) return difference;
  }
  if (left === right) return 0;
  return left < right ? 1 : -1;
}

function isExecutable(pathname) {
  try {
    accessSync(pathname, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function newestClaudeDesktopManagedCli(homeDir) {
  const versionsRoot = path.join(
    homeDir,
    "Library",
    "Application Support",
    "Claude",
    "claude-code",
  );
  let versions;
  try {
    versions = readdirSync(versionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareVersionDirectoryNamesDescending);
  } catch {
    return undefined;
  }
  for (const version of versions) {
    const executable = path.join(
      versionsRoot,
      version,
      "claude.app",
      "Contents",
      "MacOS",
      "claude",
    );
    if (isExecutable(executable)) {
      return { executable, version };
    }
  }
  return undefined;
}

export function expectedClaudeGuiExecutable(homeDir, guiPath) {
  const pathCandidates = guiPath
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, "claude"));
  const standardCandidates = [
    ...pathCandidates,
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    path.join(homeDir, ".local", "bin", "claude"),
    path.join(homeDir, ".npm-global", "bin", "claude"),
  ];
  const standard = standardCandidates.find(isExecutable);
  if (standard) return { executable: path.resolve(standard), providerClass: "standard" };
  const managed = newestClaudeDesktopManagedCli(homeDir);
  return managed
    ? { ...managed, providerClass: "claude-desktop" }
    : undefined;
}

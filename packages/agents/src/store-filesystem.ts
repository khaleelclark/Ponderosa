import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "@ponderosa/native-host/fs";
import { dirname, join } from "node:path";

function fsyncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, "r");
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}

function writeJson(file: string, data: unknown, indentation: 0 | 2 = 2): void {
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.${randomUUID()}.json.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(data, null, indentation) + "\n", "utf8");
    const descriptor = openSync(temporary, "r+");
    try { fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
    renameSync(temporary, file);
    fsyncDirectory(directory);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function readJsonLines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

/** Remove rebuildable/stale files while retaining bytes referenced by canonical events. */
function pruneArtifactDirectory(root: string, protectedPaths: ReadonlySet<string>, relative = ""): void {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const childRelative = relative ? join(relative, entry.name) : entry.name;
    const child = join(root, childRelative);
    if (entry.isDirectory()) {
      pruneArtifactDirectory(root, protectedPaths, childRelative);
      if (readdirSync(child).length === 0) rmSync(child, { recursive: false, force: true });
    } else if (!entry.isFile() || !protectedPaths.has(childRelative)) {
      rmSync(child, { force: true });
    }
  }
}

export { fsyncDirectory, writeJson, readJson, readJsonLines, pruneArtifactDirectory };

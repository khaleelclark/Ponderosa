import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "@ponderosa/native-host/fs";
import fs from "@ponderosa/native-host/fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fsyncDirectory } from "./store-filesystem.js";

// Once a write or durability check fails, the last record may be complete,
// partial, or absent. Only a fresh owner may repair and replay that file.
const uncertainAppends = new Set<string>();

/** Called only after a new store has acquired exclusive data-directory ownership. */
export function reconcileUncertainAppends(dataDir: string): void {
  const root = resolve(dataDir);
  for (const file of uncertainAppends) {
    const pathWithinRoot = relative(root, file);
    if (pathWithinRoot === "" || pathWithinRoot === ".." || pathWithinRoot.startsWith(`..${sep}`) || isAbsolute(pathWithinRoot)) continue;
    readRepairableJsonl(file, "uncertain JSONL append", true);
    uncertainAppends.delete(file);
  }
}

function writeAll(fd: number, bytes: Buffer, errorMessage: string): void {
  let written = 0;
  while (written < bytes.length) {
    const count = fs.writeSync(fd, bytes, written, bytes.length - written);
    if (count <= 0) throw new Error(errorMessage);
    written += count;
  }
}

export function readRepairableJsonl<T>(file: string, label: string, repair = false): T[] {
  if (!existsSync(file)) return [];
  const fd = openSync(file, repair ? "r+" : "r");
  try {
    const bytes = readFileSync(fd);
    if (bytes.length === 0) return [];
    const text = bytes.toString("utf8");
    const lines = text.split("\n");
    const count = text.endsWith("\n") ? lines.length - 1 : lines.length;
    const records: T[] = [];
    let validBytes = 0;
    for (let index = 0; index < count; index += 1) {
      const line = lines[index]!;
      if (!line.trim()) { validBytes += Buffer.byteLength(line) + 1; continue; }
      try {
        records.push(JSON.parse(line) as T);
        validBytes += Buffer.byteLength(line) + (index < lines.length - 1 ? 1 : 0);
        if (repair && index === count - 1 && !text.endsWith("\n")) {
          writeSync(fd, "\n");
          fsyncSync(fd);
        }
      } catch (error) {
        const tornTail = index === count - 1 && !text.endsWith("\n");
        if (!tornTail) throw new Error(`${label} contains non-tail corruption`, { cause: error });
        if (repair) {
          ftruncateSync(fd, validBytes);
          fsyncSync(fd);
        }
      }
    }
    return records;
  } finally {
    closeSync(fd);
  }
}

export function appendFsyncedJsonl(file: string, records: unknown[]): void {
  if (records.length === 0) return;
  const identity = resolve(file);
  if (uncertainAppends.has(identity)) {
    throw new Error("JSONL append outcome is uncertain; restart and replay before writing again");
  }
  const bytes = Buffer.from(records.map((record) => JSON.stringify(record) + "\n").join(""));
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true });
  const existed = existsSync(file);
  let fd: number | undefined;
  try {
    fd = openSync(file, "a");
    writeAll(fd, bytes, "append-only log write made no progress");
    fs.fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (!existed) fsyncDirectory(directory);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* retain original failure */ }
    }
    // Even close or directory-fsync errors leave durability uncertain.
    uncertainAppends.add(identity);
    throw error;
  }
}

/** Atomically replace a JSONL snapshot and make both its bytes and directory
 * entry durable before returning. Readers see either the old complete snapshot
 * or the new complete snapshot after a crash. */
export function writeAtomicFsyncedJsonl(file: string, records: unknown[]): void {
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.${randomUUID()}.jsonl.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    const bytes = Buffer.from(records.map((record) => JSON.stringify(record) + "\n").join(""));
    writeAll(fd, bytes, "JSONL snapshot write made no progress");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
    fsyncDirectory(directory);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
}

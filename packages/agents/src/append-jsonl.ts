import { touchSourceMutation } from "./source-capture-boundary.js";
import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
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
    const records: T[] = [];
    let validBytes = 0;
    let position = 0;
    let pieces: Buffer[] = [];
    let pendingBytes = 0;
    const readLine = (bytes: Buffer, end: number, terminated: boolean): void => {
      // Decode outside the parse catch: resource/read failures must never repair history.
      const line = bytes.toString("utf8");
      if (!line.trim()) { validBytes = end; return; }
      let record: T;
      try {
        record = JSON.parse(line) as T;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        if (terminated) throw new Error(`${label} contains non-tail corruption`, { cause: error });
        if (repair) {
          touchSourceMutation();
          ftruncateSync(fd, validBytes);
          fsyncSync(fd);
        }
        return;
      }
      records.push(record);
      validBytes = end;
      if (repair && !terminated) {
        touchSourceMutation();
        if (writeSync(fd, "\n", end, "utf8") !== 1) throw new Error("JSONL tail repair made no progress");
        fsyncSync(fd);
      }
    };
    // Read raw LF-delimited bytes so total log size never becomes one JS string.
    // Cross-chunk records are joined once, preserving UTF-8 and exact repair offsets.
    for (;;) {
      const chunk = Buffer.allocUnsafe(1024 * 1024);
      const size = fs.readSync(fd, chunk, 0, chunk.length, position);
      if (size === 0) break;
      const input = chunk.subarray(0, size);
      let start = 0;
      for (let index = input.indexOf(10, start); index !== -1; index = input.indexOf(10, start)) {
        const fragment = chunk.subarray(start, index);
        const bytes = pieces.length ? Buffer.concat([...pieces, fragment], pendingBytes + fragment.length) : fragment;
        readLine(bytes, position + index + 1, true);
        pieces = [];
        pendingBytes = 0;
        start = index + 1;
      }
      if (start < size) {
        const fragment = chunk.subarray(start, size);
        pieces.push(fragment);
        pendingBytes += fragment.length;
      }
      position += size;
    }
    if (pendingBytes) readLine(Buffer.concat(pieces, pendingBytes), position, false);
    return records;
  } finally {
    closeSync(fd);
  }
}

export function appendFsyncedJsonl(file: string, records: unknown[]): void {
  touchSourceMutation();
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
  touchSourceMutation();
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

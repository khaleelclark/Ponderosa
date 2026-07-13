import { closeSync, existsSync, fsyncSync, ftruncateSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

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
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, "a");
  try {
    const bytes = Buffer.from(records.map((record) => JSON.stringify(record) + "\n").join(""));
    let written = 0;
    while (written < bytes.length) {
      const count = writeSync(fd, bytes, written, bytes.length - written);
      if (count <= 0) throw new Error("append-only log write made no progress");
      written += count;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

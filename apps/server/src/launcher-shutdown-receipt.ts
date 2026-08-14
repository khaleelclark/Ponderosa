import type { LauncherShutdownReceiptDto } from "@ponderosa/core";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export function launcherShutdownReceiptPath(root: string, generation: string): string {
  if (!/^[0-9a-f-]{36}$/iu.test(generation)) throw new Error("invalid launcher generation");
  return path.join(root, "launcher-state", `shutdown-${generation}.json`);
}

export function writeLauncherShutdownReceipt(
  root: string,
  receipt: LauncherShutdownReceiptDto,
): void {
  const pathname = launcherShutdownReceiptPath(root, receipt.generation);
  mkdirSync(path.dirname(pathname), { recursive: true, mode: 0o700 });
  const temporary = `${pathname}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(temporary, 0o600); } catch { /* Windows ignores POSIX modes. */ }
  const file = openSync(temporary, "r+");
  try { fsyncSync(file); } finally { closeSync(file); }
  renameSync(temporary, pathname);
  if (process.platform !== "win32") {
    const directory = openSync(path.dirname(pathname), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}

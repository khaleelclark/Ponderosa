import { randomUUID } from "node:crypto";
import { StateAdmission } from "@ponderosa/agents";
import { DataDirectoryAuthority, physicalDirectoryIdentity } from "@ponderosa/native-host";
import type { LauncherShutdownReceiptDto } from "@ponderosa/core";
import { chmodSync, closeSync, constants, fsyncSync, fstatSync, openSync, readFileSync, renameSync, writeFileSync } from "@ponderosa/native-host/fs";
import path from "node:path";

export function launcherShutdownReceiptPath(root: string, generation: string): string {
  if (!/^[0-9a-f-]{36}$/iu.test(generation)) throw new Error("invalid launcher generation");
  return path.join(root, "launcher-state", `shutdown-${generation}.json`);
}

export function writeLauncherShutdownReceipt(
  admission: StateAdmission,
  parent: DataDirectoryAuthority,
  receipt: LauncherShutdownReceiptDto,
): void {
  StateAdmission.assertValid(admission);
  const root = DataDirectoryAuthority.ownedRoot(parent);
  admission.assertRoot(path.join(root, "data"));
  const fd = openSync(path.join(root, "launcher-state", "instance.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("unbound launcher receipt record");
    const record = JSON.parse(readFileSync(fd, "utf8"));
    if (record.stateEpoch !== 2 || record.stateGenerationId !== admission.generationId ||
        record.physicalDataDirectoryIdentity !== admission.physicalIdentity ||
        record.physicalLauncherDirectoryIdentity !== physicalDirectoryIdentity(root) ||
        record.generation !== receipt.generation || record.pid !== receipt.pid ||
        record.processBirthMarker !== receipt.processBirthMarker || record.shutdownRequestedAt !== receipt.requestedAt) {
      throw new Error("receipt does not match held current control authority");
    }
  } finally { closeSync(fd); }
  const pathname = launcherShutdownReceiptPath(root, receipt.generation);
  const temporary = `${pathname}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try { chmodSync(temporary, 0o600); } catch { /* Windows ignores POSIX modes. */ }
  const file = openSync(temporary, "r+");
  try { fsyncSync(file); } finally { closeSync(file); }
  renameSync(temporary, pathname);
  if (process.platform !== "win32") {
    const directory = openSync(path.dirname(pathname), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}

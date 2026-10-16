import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Installed launcher and server carry separate package trees. Their storage
// authorities must use ONE native image in the launcher process as well as its
// dynamically loaded admission bridge; equal bytes in two copies are not enough.
function nativeImage(): string {
  const marker = `${path.sep}app${path.sep}launcher${path.sep}`;
  const split = packageRoot.lastIndexOf(marker);
  if (split >= 0) {
    const server = path.join(packageRoot.slice(0, split), "app", "server", "package.json");
    const entry = createRequire(server).resolve("@ponderosa/native-host");
    return path.resolve(path.dirname(entry), "../build/Release/ponderosa_native.node");
  }
  return path.join(packageRoot, "build", "Release", "ponderosa_native.node");
}
export const storageNativePath = nativeImage();
interface StorageBinding {
  storagePathRegistered(path: string): boolean;
  openStorageDirectory(path: string): unknown;
  readStorageDirectory(value: unknown, close?: boolean): { name: string; kind: string } | null;
  storageOperation(operation: string, path: string, second?: string, flags?: number, mode?: number): unknown;
  closeStorageFile(fd: number): boolean;
  syncStorageFile(fd: number): boolean;
}
let native: StorageBinding | undefined;
export function storageBinding(): StorageBinding {
  return native ??= createRequire(import.meta.url)(storageNativePath) as StorageBinding;
}

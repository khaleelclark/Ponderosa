import { lstatSync, realpathSync } from "@ponderosa/native-host/fs";
import { join } from "node:path";

/** Resolve durable managed identity against the currently held data root.
 * Descriptor addresses remain internal and are never persisted as folder names. */
export function managedWorkspacePath(dataDir: string, name: string): string {
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,79}$/u.test(name) || name === "." || name === "..") {
    throw new Error("Invalid managed working-folder identity");
  }
  const root = realpathSync(dataDir);
  const workspaces = join(dataDir, "workspaces");
  const metadata = lstatSync(workspaces, { throwIfNoEntry: false });
  if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink() ||
      realpathSync(workspaces) !== join(root, "workspaces"))) {
    throw new Error("Managed working-folder root is not retained storage");
  }
  return join(root, "workspaces", name);
}

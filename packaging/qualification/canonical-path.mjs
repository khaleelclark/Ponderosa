import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * Resolve filesystem aliases in the existing portion of a path while
 * preserving not-yet-created descendants. macOS exposes its temporary
 * directory through both /var and the canonical /private/var.
 */
export function canonicalPath(pathname) {
  const absolute = path.resolve(pathname);
  const descendants = [];
  let existing = absolute;
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) {
      throw new Error(`Cannot resolve an existing ancestor for ${absolute}`);
    }
    descendants.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathSync(existing), ...descendants);
}

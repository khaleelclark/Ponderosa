import {
  cpSync,
  existsSync,
  lstatSync,
  readlinkSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative));
}

function isAbsoluteSymlinkTarget(target) {
  return path.isAbsolute(target) ||
    path.posix.isAbsolute(target) ||
    path.win32.isAbsolute(target);
}

/**
 * Reject any link whose stored target is host-absolute, lexically escapes the
 * tree, is dangling, or ultimately resolves outside the tree through another
 * link. The traversal never follows directory symlinks.
 */
export function auditPortableSymlinkTree(root, { label = "installed tree" } = {}) {
  const resolvedRoot = path.resolve(root);
  if (!existsSync(resolvedRoot)) {
    throw new Error(`Symlink portability audit root is missing: ${resolvedRoot}`);
  }
  const realRoot = realpathSync(resolvedRoot);
  const pending = [resolvedRoot];
  const links = [];

  while (pending.length > 0) {
    const current = pending.pop();
    const stats = lstatSync(current);
    if (stats.isSymbolicLink()) {
      const target = readlinkSync(current);
      const relativePath = path.relative(resolvedRoot, current);
      if (isAbsoluteSymlinkTarget(target)) {
        throw new Error(`${label} contains an absolute symlink: ${relativePath} -> ${target}`);
      }
      const lexicalTarget = path.resolve(path.dirname(current), target);
      if (!isWithin(resolvedRoot, lexicalTarget)) {
        throw new Error(`${label} contains an escaping symlink: ${relativePath} -> ${target}`);
      }
      if (!existsSync(lexicalTarget)) {
        throw new Error(`${label} contains a dangling symlink: ${relativePath} -> ${target}`);
      }
      let realTarget;
      try {
        realTarget = realpathSync(lexicalTarget);
      } catch {
        throw new Error(`${label} contains an unresolvable symlink: ${relativePath} -> ${target}`);
      }
      if (!isWithin(realRoot, realTarget)) {
        throw new Error(`${label} contains a symlink resolving outside its root: ${relativePath} -> ${target}`);
      }
      links.push({ path: relativePath, target });
      continue;
    }
    if (stats.isDirectory()) {
      for (const entry of readdirSync(current).sort().reverse()) {
        pending.push(path.join(current, entry));
      }
    }
  }

  return {
    root: resolvedRoot,
    symlinkCount: links.length,
    links,
  };
}

export function copyPortableTree(source, destination, { label = "copied tree" } = {}) {
  cpSync(source, destination, {
    recursive: true,
    verbatimSymlinks: true,
  });
  return auditPortableSymlinkTree(destination, { label });
}

import { constants, copyFileSync, lstatSync, readdirSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

function* nativeImages(root) {
  const stat = lstatSync(root);
  if (stat.isSymbolicLink()) return; // The separate portability audit validates links.
  if (stat.isDirectory()) {
    for (const name of readdirSync(root)) yield* nativeImages(path.join(root, name));
  } else if (stat.isFile() && /\.(?:node|dll|dylib|so(?:\.\d+)*)$/iu.test(root)) yield root;
}

export function assertIndependentNativeImages(root) {
  let count = 0;
  for (const filename of nativeImages(root)) {
    if (lstatSync(filename).nlink !== 1) throw new Error(`Native image shares a writable inode: ${filename}`);
    count++;
  }
  return count;
}

// pnpm deploy can hard-link addons to its mutable build cache. Copy before
// stripping or loading them so another build cannot truncate a mapped image.
export function isolateNativeImages(root) {
  for (const filename of nativeImages(root)) {
    if (lstatSync(filename).nlink === 1) continue;
    const temporary = `${filename}.independent-${randomUUID()}`;
    try {
      copyFileSync(filename, temporary, constants.COPYFILE_EXCL);
      renameSync(temporary, filename);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  return assertIndependentNativeImages(root);
}

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

export function pathEntryExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** Validate one receipt-bound directory and read its marker without following a
 * marker symlink. The final directory identity check detects replacement while
 * the marker is read; callers revalidate immediately before a destructive
 * path-based mutation. */
export function validateDeletionTombstone<T extends object>(
  tombstone: string,
  markerName: string,
  expected: T,
  label: string,
): void {
  const expectedRoot = resolve(tombstone);
  const canonicalExpectedRoot = join(realpathSync(dirname(expectedRoot)), basename(expectedRoot));
  const before = lstatSync(expectedRoot);
  if (!before.isDirectory() || before.isSymbolicLink() ||
      relative(realpathSync(expectedRoot), canonicalExpectedRoot) !== "") {
    throw new Error(`${label} is not the owned directory`);
  }
  const markerPath = join(expectedRoot, markerName);
  let descriptor: number;
  try {
    descriptor = openSync(
      markerPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    throw new Error(`${label} has no readable ownership marker`, { cause: error });
  }
  let marker: unknown;
  try {
    const markerBefore = fstatSync(descriptor);
    if (!markerBefore.isFile()) throw new Error("ownership marker is not a regular file");
    marker = JSON.parse(readFileSync(descriptor, "utf8")) as unknown;
    const markerAfter = fstatSync(descriptor);
    if (markerAfter.dev !== markerBefore.dev || markerAfter.ino !== markerBefore.ino) {
      throw new Error("ownership marker changed while being read");
    }
  } catch (error) {
    throw new Error(`${label} ownership marker is invalid`, { cause: error });
  } finally {
    closeSync(descriptor);
  }
  if (!marker || typeof marker !== "object") {
    throw new Error(`${label} ownership marker is invalid`);
  }
  for (const [key, value] of Object.entries(expected)) {
    if ((marker as Record<string, unknown>)[key] !== value) {
      throw new Error(`${label} ownership identity does not match its receipt`);
    }
  }
  const current = lstatSync(expectedRoot);
  if (!current.isDirectory() || current.isSymbolicLink() ||
      current.dev !== before.dev || current.ino !== before.ino) {
    throw new Error(`${label} changed during ownership validation`);
  }
}

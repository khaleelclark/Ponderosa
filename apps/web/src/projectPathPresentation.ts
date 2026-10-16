export interface ProjectPathPresentation {
  /** Human-facing path. Project-contained files use stable forward slashes. */
  displayPath: string;
  /** Exact source value retained for explicit diagnostics and filesystem authority. */
  diagnosticPath: string;
  projectRelative: boolean;
}

type PathFlavor = "posix" | "windows";

const UNSAFE_PRESENTATION_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu;
const HAS_UNSAFE_PRESENTATION_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;

interface AbsolutePath {
  flavor: PathFlavor;
  /** Windows drive or UNC share. POSIX has one implicit volume. */
  volume: string;
  segments: string[];
}

function safeBasename(value: string): string {
  const trimmed = value.replace(/[\\/]+$/u, "");
  const basename = trimmed.split(/[\\/]/u).at(-1)?.replace(/^[a-z]:/iu, "");
  const safe = basename?.replace(UNSAFE_PRESENTATION_CHARACTERS, "�");
  return safe || "External file";
}

function canonicalSegments(value: string, separator: RegExp): string[] | undefined {
  const segments = value.split(separator).filter(Boolean);
  if (segments.some(segment =>
    segment === "."
    || segment === ".."
    || HAS_UNSAFE_PRESENTATION_CHARACTER.test(segment))) return;
  return segments;
}

/** Defense-in-depth check for values used in ordinary labels and diff headers. */
export function isSafePresentedPath(value: string): boolean {
  if (!value || HAS_UNSAFE_PRESENTATION_CHARACTER.test(value)) return false;
  if (value.includes("\\")) return false;
  if (/^[\\/]/u.test(value) || /^[a-z]:/iu.test(value)) return false;
  const segments = value.split("/");
  return segments.every(segment => segment && segment !== "." && segment !== "..");
}

/**
 * Parse the absolute forms accepted by path.win32: drive-rooted, UNC, and
 * root-relative. Root-relative paths intentionally return undefined because
 * their volume depends on process state and presentation must fail closed.
 * Drive-relative forms such as D:secret.txt are also intentionally rejected.
 */
function windowsAbsolute(value: string): AbsolutePath | undefined {
  const normalized = value.replaceAll("/", "\\");
  const drive = normalized.match(/^([a-z]:)\\(.*)$/iu);
  if (drive) {
    const segments = canonicalSegments(drive[2]!, /\\/u);
    return segments
      ? { flavor: "windows", volume: drive[1]!.toLocaleLowerCase("en-US"), segments }
      : undefined;
  }

  if (normalized.startsWith("\\\\")) {
    const parts = normalized.slice(2).split("\\");
    const server = parts.shift();
    const share = parts.shift();
    if (!server || !share) return;
    const segments = canonicalSegments(parts.join("\\"), /\\/u);
    return segments
      ? {
          flavor: "windows",
          volume: `\\\\${server}\\${share}`.toLocaleLowerCase("en-US"),
          segments,
        }
      : undefined;
  }

  // path.win32.isAbsolute("\\Windows\\System32") is true, but without a
  // drive that path cannot be proven to share the Project's authority root.
  return;
}

function posixAbsolute(value: string): AbsolutePath | undefined {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return;
  const segments = canonicalSegments(value.slice(1), /\//u);
  return segments ? { flavor: "posix", volume: "/", segments } : undefined;
}

function absolutePath(value: string): AbsolutePath | undefined {
  if (/^[a-z]:[\\/]/iu.test(value) || /^[\\/]{2}/u.test(value)) {
    return windowsAbsolute(value);
  }
  return posixAbsolute(value);
}

function relativeSegments(
  value: string,
  rootFlavor: PathFlavor,
): string[] | undefined {
  if (!value || /^[a-z]:/iu.test(value) || /^[\\/]/u.test(value)) return;
  // A backslash is a separator on Windows but an ordinary filename character
  // on POSIX. Do not reinterpret that ambiguous form under a POSIX root.
  if (rootFlavor === "posix" && value.includes("\\")) return;
  if (rootFlavor === "windows" && value.includes(":")) return;
  return canonicalSegments(value, rootFlavor === "windows" ? /[\\/]/u : /\//u);
}

function containedRelativePath(
  root: AbsolutePath,
  candidate: AbsolutePath,
): string | undefined {
  if (root.flavor !== candidate.flavor) return;
  const fold = root.flavor === "windows"
    ? (value: string) => value.toLocaleLowerCase("en-US")
    : (value: string) => value;
  if (fold(root.volume) !== fold(candidate.volume)) return;
  if (candidate.segments.length < root.segments.length) return;
  if (!root.segments.every((segment, index) =>
    fold(segment) === fold(candidate.segments[index]!))) return;
  const relative = candidate.segments.slice(root.segments.length);
  return relative.length ? relative.join("/") : ".";
}

function externalPresentation(candidate: string): ProjectPathPresentation {
  return {
    displayPath: safeBasename(candidate),
    diagnosticPath: candidate,
    projectRelative: false,
  };
}

/**
 * Presentation only: filesystem access continues to use the exact validated
 * absolute path. A path outside the Project, on another volume, rooted without
 * a volume, drive-relative, or otherwise ambiguous receives only a safe label.
 */
export function presentProjectPath(
  projectRoot: string,
  candidate: string,
): ProjectPathPresentation {
  const root = absolutePath(projectRoot);
  if (!root) return externalPresentation(candidate);

  const absoluteCandidate = absolutePath(candidate);
  if (absoluteCandidate) {
    const displayPath = containedRelativePath(root, absoluteCandidate);
    return displayPath === undefined
      ? externalPresentation(candidate)
      : { displayPath, diagnosticPath: candidate, projectRelative: true };
  }

  const relative = relativeSegments(candidate, root.flavor);
  if (!relative) return externalPresentation(candidate);
  return {
    displayPath: relative.join("/"),
    diagnosticPath: candidate,
    projectRelative: true,
  };
}

/** Distinguish external sources without revealing their private parent folders. */
export function presentedFileIdentity(projectRoot: string, candidate: string): string {
  const presented = presentProjectPath(projectRoot, candidate);
  if (presented.projectRelative) return presented.displayPath;
  let hash = 0xcbf29ce484222325n;
  for (const character of candidate) hash = BigInt.asUintN(64, (hash ^ BigInt(character.codePointAt(0)!)) * 0x100000001b3n);
  return `${presented.displayPath} · external ${hash.toString(36)}`;
}

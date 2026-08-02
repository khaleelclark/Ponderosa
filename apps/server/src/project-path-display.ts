import path from "node:path";

export interface ProjectPathDisplayContext {
  hostPath: string;
  homePath: string;
  managedWorkspacesRoot: string;
}

const GENERATED_PRIVATE_WORKSPACE = /^project-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function pathImplementation(value: string): typeof path.posix | typeof path.win32 {
  return /^(?:[a-z]:[\\/]|\\\\)/iu.test(value) ? path.win32 : path.posix;
}

/** Human-facing path only. Canonical Project identity and filesystem access
 * continue to use the unmodified absolute host path. */
export function displayProjectPath(input: ProjectPathDisplayContext): string {
  const implementation = pathImplementation(input.hostPath);
  const normalizeComparisonPath = (value: string): string => {
    let normalized = implementation.normalize(value);
    const root = implementation.parse(normalized).root;
    while (normalized.length > root.length && normalized.endsWith(implementation.sep)) {
      normalized = normalized.slice(0, -implementation.sep.length);
    }
    return normalized;
  };
  const hostPath = normalizeComparisonPath(input.hostPath);
  const homePath = normalizeComparisonPath(input.homePath);
  const managedRoot = normalizeComparisonPath(input.managedWorkspacesRoot);
  const caseFold = implementation === path.win32
    ? (value: string) => value.toLocaleLowerCase()
    : (value: string) => value;
  const equal = (left: string, right: string) => caseFold(left) === caseFold(right);
  const inside = (candidate: string, root: string): string | undefined => {
    const relative = implementation.relative(root, candidate);
    return relative && relative !== ".." && !relative.startsWith(`..${implementation.sep}`)
      && !implementation.isAbsolute(relative)
      ? relative
      : undefined;
  };

  if (
    equal(implementation.dirname(hostPath), managedRoot)
    && GENERATED_PRIVATE_WORKSPACE.test(implementation.basename(hostPath))
  ) {
    return "Private workspace";
  }

  if (equal(hostPath, homePath)) return "~";
  const homeRelative = inside(hostPath, homePath);
  return homeRelative ? `~${implementation.sep}${homeRelative}` : input.hostPath;
}

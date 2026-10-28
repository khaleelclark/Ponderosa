import type { AgentPortablePackageDto } from "@ponderosa/core";

const CANONICAL_ARTIFACT_ID_SOURCE = "[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,254}[A-Za-z0-9])?";
const CANONICAL_ARTIFACT_ID = new RegExp(`^${CANONICAL_ARTIFACT_ID_SOURCE}$`, "u");
const CANONICAL_ARTIFACT_REFERENCE = new RegExp(
  `ponderosa:\\/\\/artifact\\/(${CANONICAL_ARTIFACT_ID_SOURCE})`,
  "gu",
);
const CANONICAL_ARTIFACT_ID_CHARACTER = /[A-Za-z0-9._:-]/u;

function canonicalArtifactReferenceMatches(text: string): Array<{
  reference: string;
  artifactId: string;
  index: number;
}> {
  const matches: Array<{ reference: string; artifactId: string; index: number }> = [];
  const matcher = new RegExp(CANONICAL_ARTIFACT_REFERENCE.source, CANONICAL_ARTIFACT_REFERENCE.flags);
  for (let match = matcher.exec(text); match; match = matcher.exec(text)) {
    const reference = match[0];
    const artifactId = match[1]!;
    const index = match.index!;
    const followingCharacter = text[index + reference.length];
    if (artifactId.length === 256 && followingCharacter !== undefined &&
        CANONICAL_ARTIFACT_ID_CHARACTER.test(followingCharacter)) {
      while (matcher.lastIndex < text.length &&
          CANONICAL_ARTIFACT_ID_CHARACTER.test(text[matcher.lastIndex]!)) {
        matcher.lastIndex += 1;
      }
      continue;
    }
    matches.push({ reference, artifactId, index });
  }
  return matches;
}

export function collectReachableArtifactIds(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const match of canonicalArtifactReferenceMatches(value)) {
      found.add(match.artifactId);
    }
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReachableArtifactIds(item, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, item] of Object.entries(value)) {
    if (key === "artifactId" && typeof item === "string" && item.trim()) found.add(item);
    if (key === "artifactIds" && Array.isArray(item)) {
      for (const id of item) if (typeof id === "string" && id.trim()) found.add(id);
    }
    collectReachableArtifactIds(item, found);
  }
  return found;
}

/** Offsets are UTF-16 indices into a bounded window, including enough context
 * on each side to recognize a reference split across a history chunk. */
export function artifactIdsIntersectingTextRange(text: string, start: number, end: number): string[] {
  return canonicalArtifactReferenceMatches(text)
    .filter(match => match.index < end && match.index + match.reference.length > start)
    .map(match => match.artifactId);
}

function portableAgentTopologyError(portablePackage: AgentPortablePackageDto): string | undefined {
  if (portablePackage.kind !== "agent" && portablePackage.kind !== "organization") {
    return "Agent package kind must match its organization shape";
  }
  if (typeof portablePackage.rootRef !== "string" || !portablePackage.rootRef.trim()) {
    return "Agent package rootRef must identify the unique organization root";
  }
  if ((portablePackage.kind === "agent") !== (portablePackage.agents.length === 1)) {
    return "Agent package kind must match its organization shape";
  }

  const nodes = new Map<string, { managerRef?: string }>();
  for (const candidate of portablePackage.agents as unknown[]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return "Agent package nodes must have a consistent organization shape";
    }
    const node = candidate as { ref?: unknown; managerRef?: unknown };
    if (typeof node.ref !== "string" || !node.ref.trim() ||
        (node.managerRef !== undefined && (typeof node.managerRef !== "string" || !node.managerRef.trim()))) {
      return "Agent package nodes must have non-empty string refs";
    }
    if (nodes.has(node.ref)) return "Agent package refs must be unique";
    if (node.managerRef === node.ref) return "organization package contains a self manager reference";
    nodes.set(node.ref, node.managerRef === undefined ? {} : { managerRef: node.managerRef as string });
  }
  if (!nodes.has(portablePackage.rootRef)) return "Agent package rootRef must identify the unique organization root";
  for (const node of nodes.values()) {
    if (node.managerRef && !nodes.has(node.managerRef)) {
      return "organization package contains an external manager reference";
    }
  }

  const roots = [...nodes].filter(([, node]) => node.managerRef === undefined).map(([ref]) => ref);
  if (roots.length !== 1 || roots[0] !== portablePackage.rootRef) {
    return "Agent package rootRef must identify the unique organization root";
  }
  const children = new Map<string, string[]>();
  for (const [ref, node] of nodes) {
    if (!node.managerRef) continue;
    const siblings = children.get(node.managerRef) ?? [];
    siblings.push(ref);
    children.set(node.managerRef, siblings);
  }
  const reachable = new Set<string>();
  const pending = [portablePackage.rootRef];
  while (pending.length) {
    const ref = pending.pop()!;
    if (reachable.has(ref)) return "every imported Agent must be reachable exactly once from rootRef";
    reachable.add(ref);
    pending.push(...(children.get(ref) ?? []));
  }
  if (reachable.size !== nodes.size) {
    return "every imported Agent must be reachable exactly once from rootRef";
  }
  return undefined;
}

export function rewritePortableArtifactReferences(text: string, artifactRefMap: ReadonlyMap<string, string>): string {
  let rewritten = "";
  let copiedThrough = 0;
  for (const match of canonicalArtifactReferenceMatches(text)) {
    const destinationId = artifactRefMap.get(match.artifactId);
    rewritten += text.slice(copiedThrough, match.index);
    rewritten += destinationId && destinationId !== match.artifactId
      ? `ponderosa://artifact/${destinationId}`
      : match.reference;
    copiedThrough = match.index + match.reference.length;
  }
  return rewritten + text.slice(copiedThrough);
}

export {
  CANONICAL_ARTIFACT_ID,
  portableAgentTopologyError,
};

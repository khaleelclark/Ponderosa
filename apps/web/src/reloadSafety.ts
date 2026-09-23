import { useEffect } from "react";

const blockers = new Set<string>();

export function setReloadBlocker(id: string, blocked: boolean): void {
  if (blocked) blockers.add(id);
  else blockers.delete(id);
}

export function reloadBlockers(): string[] {
  return [...blockers].sort();
}

/** Prevents a service-worker activation from interrupting an unsaved form or
 * an in-flight canonical mutation. Draft composers persist independently and
 * therefore do not need to block safe convergence. */
export function useReloadBlocker(id: string, blocked: boolean): void {
  useEffect(() => {
    setReloadBlocker(id, blocked);
    return () => setReloadBlocker(id, false);
  }, [blocked, id]);
}

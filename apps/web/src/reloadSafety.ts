import { useEffect } from "react";
import { currentProductScope } from "./api/productScope";
import type { AssistantMountWindow } from "./assistantMount";

const blockers = new Set<string>();

export function setReloadBlocker(id: string, blocked: boolean): void {
  if (blocked) blockers.add(id);
  else blockers.delete(id);
}

export function reloadBlockers(): string[] {
  const own=[...blockers];
  if(typeof window!=="undefined"&&currentProductScope()==="dev")own.push(...((window as AssistantMountWindow).__ponderosaAssistantMount?.blockers()??[]));
  return [...new Set(own)].sort();
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

const unsavedForms = new Set<string>();

/** Settings drafts are not persisted; protect both navigation and reload. */
export function useUnsavedForm(id: string, dirty: boolean): void {
  useReloadBlocker(id, dirty);
  useEffect(() => {
    if (!dirty) return;
    unsavedForms.add(id);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      unsavedForms.delete(id);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [dirty, id]);
}

export function confirmUnsavedNavigation(): boolean {
  if(unsavedForms.size>0&&!window.confirm("Discard unsaved Settings edits and leave this page?"))return false;
  return currentProductScope()!=="dev"||(window as AssistantMountWindow).__ponderosaAssistantMount?.canLeave()!==false;
}

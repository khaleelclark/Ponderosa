import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
type Issue = { detail: string; retry(): void };
const Context = createContext<{ issues: Record<string, Issue>; report(id: string, issue?: Issue): void }>({ issues: {}, report() {} });
export function WorkspaceRefreshProvider({ children }: { children: ReactNode }) {
  const [issues, setIssues] = useState<Record<string, Issue>>({});
  const report = useCallback((id: string, issue?: Issue) => setIssues(current => {
    const next = { ...current }; if (issue) next[id] = issue; else delete next[id]; return next;
  }), []);
  return <Context.Provider value={{ issues, report }}>{children}</Context.Provider>;
}
export const useWorkspaceRefreshIssues = () => useContext(Context).issues;
export function useReportWorkspaceRefresh(detail: string | undefined, retry: () => void) {
  const { report } = useContext(Context), id = useId(), retryRef = useRef(retry);
  retryRef.current = retry;
  useEffect(() => {
    if (detail) report(id, { detail, retry: () => retryRef.current() });
    return () => report(id);
  }, [detail, id, report]);
}

import {isBranchesPath} from "../../api/productScope.js";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { branchRoutePath, parseBranchRoute, retainedBranchDrafts, type BranchRoute } from '../../branchesRouting';
import {confirmUnsavedNavigation} from '../../reloadSafety';

const DirtyContext = createContext<(key: string, dirty: boolean) => void>(() => {});
const GuardContext = createContext<(action: () => void) => boolean>(action => { action(); return true; });

export function useBranchDraftGuard(key: string, dirty: boolean): void {
  const register = useContext(DirtyContext);
  useLayoutEffect(() => { register(key, dirty); return () => register(key, false); }, [key, dirty, register]);
}
export const useBranchNavigationGuard = () => useContext(GuardContext);

/** One guard for route changes, nested dialogs, browser history, and reload. */
export function BranchNavigation({ children }: { children(router: {
  route: BranchRoute;
  navigate(route: BranchRoute, replace?: boolean): boolean;
}): ReactNode }): JSX.Element {
  const [route, setRoute] = useState(() => parseBranchRoute(window.location.search));
  const historyIndex=useRef<number>(Number.isSafeInteger(window.history.state?.branchesIndex)?window.history.state.branchesIndex:0);
  const restoringHistory=useRef(false);
  const current = useRef(route);
  current.current = route;
  const dirty = useRef(new Set<string>());
  const register = useCallback((key: string, value: boolean) => {
    if (value) dirty.current.add(key); else dirty.current.delete(key);
  }, []);
  const confirmLeave = useCallback((keepWorkflowDraft = false, keepEditorDraft = false, keepSettingsDraft = false, keepLocalKeys:readonly string[]=[]) =>
    (keepSettingsDraft||confirmUnsavedNavigation())&&((![...dirty.current].some(key => !(keepWorkflowDraft && key === 'workflow') && !(keepEditorDraft && key === 'workflow-editor') && !keepLocalKeys.includes(key))) ||
    window.confirm('Discard unsaved changes? Workflow variables, workflow edits, execution settings, and capability changes that have not been saved will be lost.')), []);
  const guard = useCallback((action: () => void): boolean => {
    if (!confirmLeave()) return false;
    action();
    return true;
  }, [confirmLeave]);
  const navigate = useCallback((next: BranchRoute, replace = false): boolean => {
    if (branchRoutePath(next) === branchRoutePath(current.current)) return true;
    // Definition edits stay in BranchesWorkspace; editor-local fields survive
    // same-Branch tab and execution inspection while the editor stays mounted.
    const retained = retainedBranchDrafts(current.current, next);
    if (!confirmLeave(retained.workflow, retained.editor, retained.settings, retained.localKeys)) return false;
    if(!replace)historyIndex.current++;
    window.history[replace ? 'replaceState' : 'pushState']({branchesIndex:historyIndex.current}, '', branchRoutePath(next));
    setRoute(next);
    return true;
  }, [confirmLeave]);
  useEffect(()=>{
    if(new URLSearchParams(window.location.search).get('tab')==='parameters')window.history.replaceState(window.history.state,'',branchRoutePath(route)+window.location.hash);
  },[route]);
  useEffect(()=>{
    const open=(event:MessageEvent)=>{
      if(event.data?.type!=='ponderosa:open-route'||typeof event.data.url!=='string')return;
      const target=new URL(event.data.url,window.location.origin);
      if(target.origin===window.location.origin&&isBranchesPath(target.pathname))navigate(parseBranchRoute(target.search));
    };
    navigator.serviceWorker?.addEventListener('message',open);
    return ()=>navigator.serviceWorker?.removeEventListener('message',open);
  },[navigate]);
  useEffect(() => {
    window.history.replaceState({...window.history.state,branchesIndex:historyIndex.current},'');
    const pop = (event:PopStateEvent) => {
      if(restoringHistory.current){restoringHistory.current=false;return;}
      const nextIndex=event.state?.branchesIndex;
      const next = parseBranchRoute(window.location.search);
      const retained = retainedBranchDrafts(current.current, next);
      if(confirmLeave(retained.workflow, retained.editor, retained.settings, retained.localKeys)){
        if(Number.isSafeInteger(nextIndex))historyIndex.current=nextIndex;
        setRoute(next);
      }else if(Number.isSafeInteger(nextIndex)&&nextIndex!==historyIndex.current){
        restoringHistory.current=true;
        window.history.go(historyIndex.current-nextIndex);
      }else window.history.pushState({branchesIndex:historyIndex.current},'',branchRoutePath(current.current));
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (dirty.current.size) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('popstate', pop);
    window.addEventListener('beforeunload', unload);
    return () => { window.removeEventListener('popstate', pop); window.removeEventListener('beforeunload', unload); };
  }, [confirmLeave]);
  return <DirtyContext.Provider value={register}><GuardContext.Provider value={guard}>{children({ route, navigate })}</GuardContext.Provider></DirtyContext.Provider>;
}

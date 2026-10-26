import {isBranchesPath} from "../../api/productScope.js";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { branchRoutePath, parseBranchRoute, retainedBranchDrafts, type BranchRoute } from '../../branchesRouting';
import {confirmUnsavedNavigation} from '../../reloadSafety';
import {ConfirmDialog} from '../ConfirmationDialogs';

const DirtyContext = createContext<(key: string, dirty: boolean) => void>(() => {});
const GuardContext = createContext<(action: () => void, abandonWorkflow?: boolean) => boolean>(action => { action(); return true; });
export interface BranchWorkflowLeaveActions {
  branchId?: string;
  save(complete: (success: boolean) => void): void;
  discard(complete: (success: boolean) => void): void;
  pending: boolean;
  canSave: boolean;
  canDiscard: boolean;
}
type WorkflowActionsGetter = () => BranchWorkflowLeaveActions;
const WorkflowLeaveContext = createContext<(get: WorkflowActionsGetter, refresh?: boolean) => () => void>(() => () => {});

/** Register once; asynchronous navigation always reads the current workflow owner. */
export function useBranchWorkflowLeaveGuard(actions: BranchWorkflowLeaveActions): void {
  const register = useContext(WorkflowLeaveContext), latest = useRef(actions);
  latest.current = actions;
  const get = useRef(() => latest.current);
  useLayoutEffect(() => register(get.current), [register]);
  useLayoutEffect(() => { register(get.current, true); }, [register, actions.branchId, actions.pending, actions.canSave, actions.canDiscard]);
}

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
  const restoringHistory=useRef<(() => void)>();
  const replayingHistory=useRef<{route:BranchRoute;index:number}>();
  const current = useRef(route);
  current.current = route;
  const generation = useRef(0);
  const dirty = useRef(new Set<string>());
  const workflow = useRef<WorkflowActionsGetter>();
  const [, refreshWorkflowActions] = useState(0);
  type Retained = ReturnType<typeof retainedBranchDrafts>;
  type LeaveIntent = { owner: BranchRoute; generation: number; action(): void; retained: Retained; started?: boolean };
  const intent = useRef<LeaveIntent>();
  const [prompt, setPrompt] = useState<LeaveIntent>();
  const cancelLeave = useCallback(() => { intent.current = undefined; setPrompt(undefined); }, []);
  const registerWorkflow = useCallback((get: WorkflowActionsGetter, refresh = false) => {
    if (refresh) {
      if (workflow.current === get) {
        if (intent.current && intent.current.owner.branchId !== get().branchId) cancelLeave();
        refreshWorkflowActions(value => value + 1);
      }
      return () => {};
    }
    workflow.current = get;
    refreshWorkflowActions(value => value + 1);
    return () => { if (workflow.current === get) { workflow.current = undefined; cancelLeave(); } };
  }, [cancelLeave]);
  const register = useCallback((key: string, value: boolean) => {
    if (value) dirty.current.add(key); else dirty.current.delete(key);
  }, []);
  const confirmOtherLeave = useCallback((retained: Retained) =>
    (retained.settings||confirmUnsavedNavigation())&&((![...dirty.current].some(key => key !== 'workflow' && key !== 'workflow-editor' && !retained.localKeys.includes(key))) ||
    window.confirm('Discard unsaved changes? Workflow variables, workflow edits, execution settings, and capability changes that have not been saved will be lost.')), []);
  const requestLeave = useCallback((action: () => void, retained: Retained): boolean => {
    if (intent.current) return false;
    if ((!retained.workflow && dirty.current.has('workflow')) || (!retained.editor && dirty.current.has('workflow-editor'))) {
      const pending = { owner: current.current, generation: generation.current, action, retained };
      intent.current = pending;
      setPrompt(pending);
      return false;
    }
    if (!confirmOtherLeave(retained)) return false;
    action();
    return true;
  }, [confirmOtherLeave]);
  const finishLeave = useCallback((pending: LeaveIntent, success: boolean) => {
    if (intent.current !== pending) return;
    const owns = pending.generation === generation.current && pending.owner.branchId === current.current.branchId && workflow.current?.().branchId === pending.owner.branchId;
    cancelLeave();
    if (success && owns && confirmOtherLeave(pending.retained)) pending.action();
  }, [cancelLeave, confirmOtherLeave]);
  const settleWorkflow = (kind: 'save' | 'discard') => {
    const pending = intent.current, actions = workflow.current?.();
    if (!pending || pending.started || !actions || actions.branchId !== pending.owner.branchId || actions.pending || !(kind === 'save' ? actions.canSave : actions.canDiscard)) return;
    pending.started = true;
    setPrompt(undefined);
    try { actions[kind](success => finishLeave(pending, success)); }
    catch { finishLeave(pending, false); }
  };
  const guard = useCallback((action: () => void, abandonWorkflow = false): boolean => requestLeave(action, {workflow:!abandonWorkflow,editor:!abandonWorkflow,settings:false,localKeys:[]}), [requestLeave]);
  const commitRoute = useCallback((next: BranchRoute, replace: boolean) => {
    if(!replace)historyIndex.current++;
    window.history[replace ? 'replaceState' : 'pushState']({branchesIndex:historyIndex.current}, '', branchRoutePath(next));
    generation.current++;
    setRoute(next);
  }, []);
  const navigate = useCallback((next: BranchRoute, replace = false): boolean => {
    if (branchRoutePath(next) === branchRoutePath(current.current)) return true;
    // Definition edits stay in BranchesWorkspace; editor-local fields survive
    // same-Branch tab and execution inspection while the editor stays mounted.
    const retained = retainedBranchDrafts(current.current, next);
    return requestLeave(() => commitRoute(next, replace), retained);
  }, [requestLeave, commitRoute]);
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
      if(restoringHistory.current){const restored=restoringHistory.current;restoringHistory.current=undefined;restored();return;}
      if(replayingHistory.current){const replay=replayingHistory.current;replayingHistory.current=undefined;historyIndex.current=replay.index;generation.current++;setRoute(replay.route);return;}
      const nextIndex=event.state?.branchesIndex;
      const next = parseBranchRoute(window.location.search);
      const retained = retainedBranchDrafts(current.current, next);
      const workflowBlocked = (!retained.workflow && dirty.current.has('workflow')) || (!retained.editor && dirty.current.has('workflow-editor'));
      if (!intent.current && !workflowBlocked) {
        if (confirmOtherLeave(retained)) {
          if(Number.isSafeInteger(nextIndex))historyIndex.current=nextIndex;
          generation.current++;
          setRoute(next);
        } else if(Number.isSafeInteger(nextIndex)&&nextIndex!==historyIndex.current) {
          restoringHistory.current=()=>{};
          window.history.go(historyIndex.current-nextIndex);
        } else window.history.pushState({branchesIndex:historyIndex.current},'',branchRoutePath(current.current));
        return;
      }
      if(Number.isSafeInteger(nextIndex)&&nextIndex!==historyIndex.current){
        // Put the accepted URL back before any asynchronous save/review dialog.
        restoringHistory.current=()=>requestLeave(()=>{replayingHistory.current={route:next,index:nextIndex};window.history.go(nextIndex-historyIndex.current)},retained);
        window.history.go(historyIndex.current-nextIndex);
      }else{
        window.history.pushState({branchesIndex:historyIndex.current},'',branchRoutePath(current.current));
        requestLeave(()=>commitRoute(next,false),retained);
      }
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (dirty.current.size) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('popstate', pop);
    window.addEventListener('beforeunload', unload);
    return () => { window.removeEventListener('popstate', pop); window.removeEventListener('beforeunload', unload); };
  }, [requestLeave, commitRoute, confirmOtherLeave]);
  const actions = workflow.current?.();
  return <DirtyContext.Provider value={register}><WorkflowLeaveContext.Provider value={registerWorkflow}><GuardContext.Provider value={guard}>{children({ route, navigate })}
    <ConfirmDialog open={Boolean(prompt)} title="Unsaved Changes" confirmLabel="Save And Leave" cancelLabel="Back To Editing" pending={actions?.pending} confirmDisabled={!actions?.canSave} onCancel={cancelLeave} onConfirm={()=>settleWorkflow('save')} secondaryAction={{label:'Discard And Leave',disabled:!actions?.canDiscard,onClick:()=>settleWorkflow('discard')}}>Save your workflow changes before leaving?</ConfirmDialog>
  </GuardContext.Provider></WorkflowLeaveContext.Provider></DirtyContext.Provider>;
}

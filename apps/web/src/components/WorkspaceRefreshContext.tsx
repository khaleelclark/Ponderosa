import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type {WorkspaceConnectionState} from '../hooks/useWorkspaceStream';
import {availabilityFailure, errorDetail, readIssueKey, type WorkspaceReadIssue} from '../workspaceAvailability';
type Issue = { detail: string; retry(): unknown; read?: WorkspaceReadIssue };
const Context = createContext<{
  issues: Record<string, Issue>; report(id: string, issue?: Issue): void;
  verified:boolean; shared: boolean; incident: number; dismissed: ReadonlySet<string>;
  dismiss(key: string): void; retry(): void; retrying: boolean;
}>({ issues: {}, report() {}, verified:false, shared:false, incident:0, dismissed:new Set(), dismiss(){}, retry(){}, retrying:false });
export function WorkspaceRefreshProvider({ children, connection }: { children: ReactNode; connection?: WorkspaceConnectionState }) {
  const [issues, setIssues] = useState<Record<string, Issue>>({});
  const [dismissed,setDismissed]=useState<ReadonlySet<string>>(new Set());
  const pending=useRef(new Set<string>()),participants=useRef(new Set<string>()),episode=useRef(false);
  const [sharedIncident,setSharedIncident]=useState(false);
  const [incident,setIncident]=useState(0);
  const verified=connection?.status==='live'&&connection.phaseEvidenceFresh;
  const disconnected=Boolean(connection&&(connection.status==='reconnecting'||connection.status==='stale'||connection.status==='unavailable'||connection.prolongedDisconnect));
  const verifiedRef=useRef(verified);verifiedRef.current=verified;
  const report = useCallback((id: string, issue?: Issue) => setIssues(current => {
    const previous=current[id];
    // State updaters can be replayed by React. Keep the captured report pure.
    const nextIssue=issue?.read&&previous?.read?.owner===issue.read.owner&&previous.read.resource===issue.read.resource&&!issue.read.error&&(!issue.read.success||!verifiedRef.current)&&previous.read.error
      ? {...previous,read:{...issue.read,error:previous.read.error}} : issue;
    if(previous?.detail===nextIssue?.detail&&previous?.read?.owner===nextIssue?.read?.owner&&previous?.read?.resource===nextIssue?.read?.resource&&previous?.read?.success===nextIssue?.read?.success&&previous?.read?.hasData===nextIssue?.read?.hasData&&previous?.read?.active===nextIssue?.read?.active&&previous?.read?.error===nextIssue?.read?.error)return current;
    const next={...current};if(nextIssue)next[id]=nextIssue;else delete next[id];return next;
  }), []);
  const candidates=Object.values(issues).filter(issue=>issue.read?.active!==false&&availabilityFailure(issue.read?.error));
  const corroborated=candidates.length>0&&(disconnected||new Set(candidates.map(issue=>issue.read!.resource)).size>1);
  useLayoutEffect(()=>{
    for(const issue of Object.values(issues))if(issue.read&&availabilityFailure(issue.read.error)){
      const key=readIssueKey(issue.read);pending.current.add(key);participants.current.add(key);
    }
    const activeReads=Object.values(issues).flatMap(issue=>issue.read&&issue.read.active!==false?[issue.read]:[]);
    const activeKeys=new Set(activeReads.map(readIssueKey));
    // Multiple retained views may observe the same logical resource. A fresh
    // duplicate cannot clear a still-failed or unsettled active reader.
    const blockedKeys=new Set(activeReads.filter(read=>read.error||!read.success).map(readIssueKey));
    const healthyKeys=new Set(activeReads.filter(read=>read.success&&!read.error&&!blockedKeys.has(readIssueKey(read))).map(readIssueKey));
    if(verified)for(const key of healthyKeys)pending.current.delete(key);
    const activePending=[...pending.current].some(key=>activeKeys.has(key));
    if((disconnected||activePending)&&!episode.current){episode.current=true;setIncident(value=>value+1);}
    const recovered=Boolean(verified&&!disconnected&&!activePending);
    // A no-op layout dispatch still schedules work while React is replaying a
    // lower-priority report. Dispatch only actual presentation transitions.
    const nextShared=corroborated||!recovered&&sharedIncident;
    if(nextShared!==sharedIncident)setSharedIncident(nextShared);
    const cleared=recovered?new Set([...participants.current].filter(key=>!pending.current.has(key))):new Set<string>();
    if(verified&&dismissed.size){
      const nextDismissed=new Set([...dismissed].filter(key=>{
        const [owner,kind]=JSON.parse(key);
        return !(healthyKeys.has(owner)&&kind!=='availability'||cleared.has(owner));
      }));
      if(nextDismissed.size!==dismissed.size)setDismissed(nextDismissed);
    }
    if(recovered){
      for(const key of cleared)participants.current.delete(key);
      // Detached owners retain their unresolved evidence and dismissal.
      episode.current=false;
    }
  },[issues,verified,disconnected,corroborated,sharedIncident,dismissed]);
  const shared=sharedIncident||corroborated;
  const dismiss=useCallback((key:string)=>setDismissed(current=>new Set([...current,key])),[]);
  const inFlight=useRef(false),[retrying,setRetrying]=useState(false);
  const retry=()=>{
    if(inFlight.current||connection?.retrying)return;
    inFlight.current=true;setRetrying(true);
    // Refetch every failed active reader. TanStack and the existing GET
    // coalescer deduplicate identical physical reads, not unrelated queries
    // which happen to share an owner/resource label.
    const readers=Object.values(issues).filter(issue=>!issue.read||issue.read.active!==false&&issue.read.error);
    const work=[()=>connection?.retry?.(),...readers.map(issue=>issue.retry)];
    void Promise.allSettled(work.map(run=>Promise.resolve().then(run))).finally(()=>{inFlight.current=false;setRetrying(false);});
  };
  return <Context.Provider value={{ issues, report, verified, shared, incident, dismissed, dismiss, retry, retrying }}>{children}</Context.Provider>;
}
export const useWorkspaceRefresh = () => useContext(Context);
export const useWorkspaceRefreshIssues = () => {
  const context=useContext(Context);
  return Object.fromEntries(Object.entries(context.issues).filter(([,issue])=>!issue.read||issue.read.active!==false&&context.shared&&availabilityFailure(issue.read.error)));
};
export function useReportWorkspaceRead(read:WorkspaceReadIssue){
  const context=useContext(Context),id=useId(),retryRef=useRef(read.retry);retryRef.current=read.retry;
  const retry=useCallback(()=>retryRef.current(),[]);
  const detail=read.error?`${read.resource}: ${errorDetail(read.error)}`:'';
  useLayoutEffect(()=>{context.report(id,{detail,retry,read:{...read,retry}});},[context.report,context.verified,id,read.owner,read.resource,read.hasData,read.active,read.success,read.error,detail,retry]);
  useLayoutEffect(()=>()=>context.report(id),[context.report,id]);
  return context;
}
export function useReportWorkspaceRefresh(detail: string | undefined, retry: () => void) {
  const { report } = useContext(Context), id = useId(), retryRef = useRef(retry);
  retryRef.current = retry;
  useEffect(() => {
    if (detail) report(id, { detail, retry: () => retryRef.current() });
    return () => report(id);
  }, [detail, id, report]);
}

import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Dialog,DialogActions,DialogContent,DialogTitle,Paper,Stack,Typography} from '@mui/material';
import type {AgentDto,NativeTaskInventory,NativeTaskStopRequest,NativeTaskStopReceipt} from '@ponderosa/core';
import {requestJson} from '../api/real';
import {currentProductScope} from '../api/productScope';
import {createClientId} from '../clientId';
import {useWorkspaceReadOnly} from './WorkspaceReadOnlyContext';
import {nativeTaskCommandValid,nativeTaskInventoryValid,nativeTaskReceiptMatches,nativeTaskRecoveryPath,nativeTaskTarget} from './nativeTasks';
export function NativeTaskControls({agent}:{agent:AgentDto}) {
 const scope=JSON.stringify([window.location.origin,currentProductScope(),agent.id]);
 return <NativeTaskPanel key={scope} agent={agent} scope={scope}/>;
}
function NativeTaskPanel({agent,scope}:{agent:AgentDto;scope:string}) {
 const base=`/api/agents/${encodeURIComponent(agent.id)}/native-tasks`,storageKey=`native-task-stops:${scope}`;
 const [restored]=useState(()=>{try{const raw=localStorage.getItem(storageKey);const commands:unknown=raw?JSON.parse(raw):[];if(!Array.isArray(commands)||!commands.every(nativeTaskCommandValid)||new Set(commands.map(nativeTaskTarget)).size!==commands.length||new Set(commands.map(c=>c.idempotencyKey)).size!==commands.length)throw Error();return {commands:commands as NativeTaskStopRequest[],error:''};}catch{return {commands:[] as NativeTaskStopRequest[],error:'Saved stop commands unavailable · new stops held'};}});
 const [commands,setCommands]=useState(restored.commands),[storageError,setStorageError]=useState(restored.error);
 const [inventory,setInventory]=useState<NativeTaskInventory>(),[receipts,setReceipts]=useState<Record<string,NativeTaskStopReceipt>>({});
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[confirm,setConfirm]=useState<NativeTaskStopRequest>();
 const readOnly=useWorkspaceReadOnly(),lock=useRef(false),mounted=useRef(true),owner=useRef('');
 const identity=JSON.stringify([agent.id,agent.projectId,agent.conversationId,agent.activeEngine,agent.workingCopy]);owner.current=identity;
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 useEffect(()=>{setInventory(undefined);setConfirm(undefined);},[identity]);
 const guarded=async(action:()=>Promise<void>)=>{if(lock.current)return;lock.current=true;setBusy(true);try{await action();}catch(e){if(mounted.current)setNotice(`${e instanceof Error?e.message:String(e)} · no replay`);}finally{lock.current=false;if(mounted.current){setBusy(false);setConfirm(undefined);if(owner.current!==identity){setInventory(undefined);setNotice('Agent boundary changed · inspect saved original command');}}}};
 const accept=(command:NativeTaskStopRequest,value:unknown)=>{if(!nativeTaskReceiptMatches(command,value))throw Error('Missing or different exact receipt · outcome unknown');if(mounted.current)setReceipts(prior=>({...prior,[command.idempotencyKey]:value}));};
 const inspect=()=>void guarded(async()=>{setInventory(undefined);const value=await requestJson<unknown>(base,{cache:'no-store'});if(!nativeTaskInventoryValid(value))throw Error('Exact inventory unavailable · absence unconfirmed');if(mounted.current&&owner.current===identity){setInventory(value);setNotice('Live native inventory · server revalidates stop authority');}});
 const recover=(command:NativeTaskStopRequest)=>void guarded(async()=>{const value=await requestJson<unknown>(nativeTaskRecoveryPath(base,command),{cache:'no-store'});accept(command,value);setNotice('Original-key receipt read · source completion unchanged');});
 const stop=(command:NativeTaskStopRequest)=>void guarded(async()=>{
  if(readOnly||storageError||!inventory||!nativeTaskCommandValid(command)||inventory.runId!==command.runId||inventory.sourceFence!==command.sourceFence||inventory.sessionId!==command.sessionId||!inventory.tasks.some(t=>t.taskKey===command.taskKey&&t.cancellable)||commands.some(c=>nativeTaskTarget(c)===nativeTaskTarget(command)))throw Error('Exact current unsent target required');
  const next=[...commands,command];
  try{const raw=localStorage.getItem(storageKey);if(JSON.stringify(raw?JSON.parse(raw):[])!==JSON.stringify(commands))throw Error();localStorage.setItem(storageKey,JSON.stringify(next));setCommands(next);}catch{setStorageError('Stop command storage conflict · new stops held');throw Error('Original command could not be saved · no POST sent');}
  setInventory(undefined);setNotice('Original command saved · outcome unknown');
  const value=await requestJson<unknown>(`${base}/stop`,{method:'POST',body:JSON.stringify(command)});accept(command,value);setNotice('Native receipt recorded · source completion unchanged');
 });
 return <Paper variant="outlined" sx={{p:2}}><Stack spacing={1}>
  <Typography variant="subtitle1">Native tasks</Typography><Button onClick={()=>setOpen(true)}>Inspect native tasks</Button>
  <Dialog open={open} onClose={()=>!busy&&setOpen(false)} fullWidth maxWidth="md"><DialogTitle>Native tasks</DialogTitle><DialogContent><Stack spacing={2} sx={{pt:1}}>
   <Typography variant="body2">Per-task control · Run Stop remains in the Agent header.</Typography>
   <Alert severity="info">Native acknowledgment does not establish source effects or Run completion · process drain unobserved</Alert>
   {notice&&<Alert severity="warning">{notice}</Alert>}{storageError&&<Alert severity="error">{storageError}</Alert>}
   <Button disabled={busy} onClick={inspect}>Refresh live inventory</Button>
   {inventory&&<><Typography sx={{overflowWrap:'anywhere'}}>Run {inventory.runId} · fence {inventory.sourceFence} · session {inventory.sessionId}</Typography>{!inventory.tasks.length&&<Typography>No tasks in this complete live inventory</Typography>}{inventory.tasks.map(task=>{
    const prior=commands.find(c=>nativeTaskTarget(c)===nativeTaskTarget({...inventory,taskKey:task.taskKey,idempotencyKey:''}));
    return <Paper key={task.taskKey} variant="outlined" sx={{p:1}}><Stack spacing={1}><Typography sx={{overflowWrap:'anywhere'}}>{task.kind} · {task.taskId}</Typography><Typography variant="body2" sx={{overflowWrap:'anywhere'}}>Task key {task.taskKey}{task.taskRunId&&` · task Run ${task.taskRunId}`}{task.itemId&&` · item ${task.itemId}`}{task.processId&&` · process ${task.processId}`}</Typography><Button color="error" disabled={busy||readOnly||!!storageError||!task.cancellable||!!prior} onClick={()=>setConfirm({runId:inventory.runId,sourceFence:inventory.sourceFence,sessionId:inventory.sessionId,taskKey:task.taskKey,idempotencyKey:createClientId()})}>{!task.cancellable?'Native stop unavailable':prior?'Original command retained':'Stop native task'}</Button></Stack></Paper>;
   })}</>}
   {commands.map(command=><Paper key={command.idempotencyKey} variant="outlined" sx={{p:1}}><Stack spacing={1}><Typography sx={{overflowWrap:'anywhere'}}>Original command {command.idempotencyKey} · Run {command.runId} · fence {command.sourceFence} · session {command.sessionId} · task {command.taskKey}</Typography><Typography>Outcome {receipts[command.idempotencyKey]?.outcome??'unknown'} · processDrainObserved: false</Typography><Button disabled={busy} onClick={()=>recover(command)}>Read original receipt</Button></Stack></Paper>)}
  </Stack></DialogContent><DialogActions><Button disabled={busy} onClick={()=>setOpen(false)}>Close</Button></DialogActions></Dialog>
  <Dialog open={!!confirm} onClose={()=>!busy&&setConfirm(undefined)}><DialogTitle>Stop this native task?</DialogTitle><DialogContent><Typography sx={{overflowWrap:'anywhere'}}>{confirm?.taskKey}</Typography><Typography>One native stop request. External effects remain; the original Run may continue.</Typography></DialogContent><DialogActions><Button disabled={busy} onClick={()=>setConfirm(undefined)}>Cancel</Button><Button color="error" disabled={busy||readOnly} onClick={()=>confirm&&stop(confirm)}>Stop task</Button></DialogActions></Dialog>
 </Stack></Paper>;
}

import {ConfirmDialog} from './ConfirmationDialogs';
import {useRef,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Alert,Button,FormControlLabel,Stack,Switch} from '@mui/material';
import type {OutputAgentAppDto,AssistantStatusDto} from '@ponderosa/core';
import {requestJson} from '../api/real';
/** Added only to persistent Branch Agent settings, alongside existing policy controls. */
export function OutputAgentDesignation({agentId}:{agentId:string}):JSX.Element{
 const [moveSpeaker,setMoveSpeaker]=useState(false);
 const assistant=useQuery({queryKey:['assistant-status'],queryFn:()=>requestJson<AssistantStatusDto>('/api/branches/assistant'),retry:false});
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),pending=useRef(false);
 const query=useQuery({queryKey:['output-designation',agentId],retry:false,queryFn:async()=>{
  try{return await requestJson<OutputAgentAppDto>(`/api/branches/output-apps/${agentId}`);}catch(cause){if((cause as {status?:number}).status===404)return null;throw cause;}
 }});
 const change=async(enabled:boolean,speaker=enabled&&(query.data?.speaker??false))=>{if(pending.current)return;pending.current=true;setBusy(true);try{setError('');await requestJson(`/api/branches/output-apps/${agentId}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({enabled,speaker})});await query.refetch();await assistant.refetch();}catch(cause){setError((cause as Error).message);}finally{pending.current=false;setBusy(false);}};
 const designateSpeaker=async()=>{if(pending.current||!assistant.data)return;pending.current=true;setBusy(true);setError('');try{await requestJson('/api/branches/assistant/speaker',{method:'POST',body:JSON.stringify({agentId,expectedSpeakerId:assistant.data.app?.agentId??null})});setMoveSpeaker(false);await query.refetch();await assistant.refetch();}catch(cause){setError((cause as Error).message);await assistant.refetch();}finally{pending.current=false;setBusy(false);}};
 return <Stack><FormControlLabel label="Output App" control={<Switch disabled={query.isPending||busy||query.isError} checked={Boolean(query.data)} onChange={(_,value)=>void change(value)}/>}/>
  {query.data&&<><Button href={query.data.url} target="_blank" rel="noreferrer">Open Output App</Button><FormControlLabel label="Ponderosa Speaker" control={<Switch disabled={busy||assistant.isPending||assistant.isError} checked={query.data.speaker} onChange={(_,value)=>{if(!value)void change(true,false);else if(assistant.data?.app&&assistant.data.app.agentId!==agentId)setMoveSpeaker(true);else void designateSpeaker();}}/>}/></>}
  <ConfirmDialog open={moveSpeaker} title="Move Ponderosa speaker?" confirmLabel="Move Speaker" cancelLabel="Cancel" onCancel={()=>{if(!busy)setMoveSpeaker(false);}} onConfirm={()=>void designateSpeaker()}>{assistant.data?.app?.pauseOnSpeakerRemoval?(assistant.data.app.automatic?'Use this Agent? The previous speaker’s automatic workflow will pause.':'Use this Agent? The previous speaker’s automatic workflow will stay paused.'):'Use this Agent? Existing workflow settings will stay the same.'}</ConfirmDialog>
  {assistant.isError&&<Alert severity="error" action={<Button onClick={()=>void assistant.refetch()}>Retry</Button>}>{assistant.error.message}</Alert>}
  {(error||query.isError)&&<Alert severity="error" action={query.isError?<Button onClick={()=>void query.refetch()}>Retry</Button>:undefined}>{error||(query.error as Error)?.message}</Alert>}
 </Stack>;
}

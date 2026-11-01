import {useRef,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {Alert,Button,FormControlLabel,Stack,Switch} from '@mui/material';
import type {AssistantStatusDto} from '@ponderosa/core';
import {requestJson} from '../api/real';

export function AssistantSettings():JSX.Element {
 const client=useQueryClient(),pending=useRef(false);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const status=useQuery({queryKey:['assistant-status'],queryFn:()=>requestJson<AssistantStatusDto>('/api/branches/assistant')});
 const change=async(enabled:boolean)=>{
  if(pending.current)return;
  pending.current=true;setBusy(true);setError('');
  try{
   const next=await requestJson<AssistantStatusDto>('/api/branches/assistant',{method:'POST',body:JSON.stringify({enabled})});
   client.setQueryData(['assistant-status'],next);
   await client.invalidateQueries({queryKey:['assistant-initialize']});
  }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
  finally{pending.current=false;setBusy(false);}
 };
 return <Stack spacing={1}>
  <FormControlLabel label={status.data?.enabled?'Assistant enabled':'Assistant disabled'} control={<Switch checked={status.data?.enabled??false} disabled={busy||status.isPending||status.isError} onChange={(_,value)=>void change(value)}/>}/>
  <Button href="/assistant" sx={{alignSelf:'start'}}>Open Assistant</Button>
  {(error||status.isError)&&<Alert severity="error" action={status.isError?<Button onClick={()=>void status.refetch()}>Retry</Button>:undefined}>{error||status.error?.message}</Alert>}
 </Stack>;
}

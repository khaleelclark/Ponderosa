import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Alert,Button,FormControlLabel,Stack,Switch} from '@mui/material';
import type {OutputAgentAppDto} from '@ponderosa/core';
import {requestJson} from '../api/real';
/** Added only to persistent Branch Agent settings, alongside existing policy controls. */
export function OutputAgentDesignation({agentId}:{agentId:string}):JSX.Element{
 const [error,setError]=useState('');
 const query=useQuery({queryKey:['output-designation',agentId],retry:false,queryFn:async()=>{
  try{return await requestJson<OutputAgentAppDto>(`/api/branches/output-apps/${agentId}`);}catch(cause){if((cause as {status?:number}).status===404)return null;throw cause;}
 }});
 const change=async(enabled:boolean,speaker=false)=>{try{setError('');await requestJson(`/api/branches/output-apps/${agentId}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({enabled,speaker})});await query.refetch();}catch(cause){setError((cause as Error).message);}};
 return <Stack><FormControlLabel label="Output app" control={<Switch disabled={query.isPending} checked={Boolean(query.data)} onChange={(_,value)=>void change(value)}/>}/>
  {query.data&&<><Button href={query.data.url} target="_blank" rel="noreferrer">Open output app</Button><FormControlLabel label="Ponderosa speaker" control={<Switch checked={query.data.speaker} onChange={(_,value)=>void change(true,value)}/>}/></>}
  {(error||query.isError)&&<Alert severity="error">{error||(query.error as Error)?.message}</Alert>}
 </Stack>;
}

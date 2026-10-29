import {useEffect,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Alert,Box,Button,Dialog,DialogContent,DialogTitle,FormControlLabel,Stack,Switch,MenuItem,TextField,Typography} from '@mui/material';
import type {AssistantStatusDto,OutputAgentAppDto} from '@ponderosa/core';
import {realApi,requestJson} from '../api/real';
import type {BranchRoute} from '../branchesRouting';
import {BranchChats} from './branches/BranchChats';
import {WorkspaceConnectionProvider} from './WorkspaceConnectionContext';
import {useWorkspaceStream} from '../hooks/useWorkspaceStream';


/** The output URL reuses canonical Agent chat, attachments, voice and streams. */
export function OutputAgentApp():JSX.Element{
 const assistant=window.location.pathname==='/assistant';
 const id=assistant?undefined:decodeURIComponent(window.location.pathname.split('/')[2]??'');
 const connection=useWorkspaceStream();
 const [settings,setSettings]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [automatic,setAutomatic]=useState(true),[minutes,setMinutes]=useState(10),[model,setModel]=useState(''),[engine,setEngine]=useState('');
 const [route,setRoute]=useState<BranchRoute>();
 const status=useQuery({queryKey:['assistant-status'],queryFn:()=>requestJson<AssistantStatusDto>('/api/branches/assistant')});
 const output=useQuery({queryKey:['output-app',id],enabled:!assistant&&Boolean(id),retry:false,queryFn:()=>requestJson<OutputAgentAppDto>(`/api/branches/output-apps/${encodeURIComponent(id!)}`)});
 const engines=useQuery({queryKey:['output-app-engines'],queryFn:()=>realApi.listEngines()});
 const app=assistant?status.data?.app:output.data;
 useEffect(()=>{if(app){setAutomatic(app.automatic);setMinutes((app.everyMs??600000)/60000);setModel(app.model??'');setEngine(app.engine);setRoute({branchId:app.branchId,tab:'chats',chatId:app.chatId,workspace:{kind:'agent',projectId:app.projectId,agentId:app.agentId}});}},[app?.agentId]);
 const refresh=async()=>{if(assistant)await status.refetch();else await output.refetch();};
 const act=async(work:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await work();await refresh();}catch(cause){setError((cause as Error).message);}finally{setBusy(false);}};
 const configure=(enabled:boolean)=>act(()=>requestJson('/api/branches/assistant',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled})}));
 useEffect(()=>{if(assistant&&status.data&&!status.data.initialized)void act(()=>requestJson('/api/branches/assistant',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({initialize:true})}));},[assistant,status.data?.initialized]);
 return <WorkspaceConnectionProvider value={connection}><Box sx={{height:'100dvh',display:'flex',flexDirection:'column',minHeight:0}}>
  <Stack direction="row" alignItems="center" spacing={1} sx={{p:1,borderBottom:1,borderColor:'divider'}}>
   <Typography variant="h6" sx={{flex:1}}>{app?.title??'Assistant'}</Typography><Button href="/home">Ponderosa</Button><Button onClick={()=>setSettings(true)}>Settings</Button>
  </Stack>
  {error&&<Alert severity="error">{error}</Alert>}
  {(status.isError||output.isError)&&<Alert severity="error">{((status.error??output.error) as Error)?.message??'Output app unavailable'}</Alert>}
  {!app&&assistant&&status.data?.initialized&&<Stack spacing={1} sx={{p:2}}><Typography>Assistant is disabled</Typography><Button disabled={busy} onClick={()=>void configure(true)}>Enable Assistant</Button></Stack>}
  {!app&&!error&&!status.isError&&!output.isError&&!status.data?.initialized&&<Typography role="status" sx={{p:2}}>Loading…</Typography>}
  {app&&route&&<Box sx={{flex:1,minHeight:0,display:'flex'}}><BranchChats branchId={app.branchId} engines={engines.data??[]} enginesLoaded={Boolean(engines.data)} branchRoute={route} onNavigate={next=>{setRoute(next);return true;}}/></Box>}
  <Dialog open={settings} onClose={()=>setSettings(false)} fullWidth maxWidth="xs"><DialogTitle>Settings</DialogTitle><DialogContent><Stack spacing={2} sx={{pt:1}}>
   {app&&<><FormControlLabel control={<Switch checked={automatic} onChange={(_,value)=>setAutomatic(value)}/>} label="Run automatically"/>
    <TextField label="Check every (minutes)" type="number" value={minutes} onChange={event=>setMinutes(Number(event.target.value))} inputProps={{min:1}}/>
    <Button disabled={busy} onClick={()=>void act(()=>requestJson(`/api/branches/output-apps/${app.agentId}/schedule`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({expectedVersionId:app.versionId,automatic,everyMs:minutes*60000})}))}>Save schedule</Button>
    <TextField select label="Provider" value={engine} onChange={event=>{setEngine(event.target.value);setModel(engines.data?.find(item=>item.id===event.target.value)?.defaultModel??'');}}>{engines.data?.map(item=><MenuItem key={item.id} value={item.id}>{item.displayName}</MenuItem>)}</TextField>
    <TextField select label="Model" SelectProps={{displayEmpty:true}} InputLabelProps={{shrink:true}} value={model} onChange={event=>setModel(event.target.value)}><MenuItem value="">Provider default</MenuItem>{model&&!engines.data?.find(item=>item.id===engine)?.models.some(item=>item.id===model)&&<MenuItem value={model}>{model}</MenuItem>}{engines.data?.find(item=>item.id===engine)?.models.filter(item=>item.id).map(item=><MenuItem key={item.id} value={item.id}>{item.label}</MenuItem>)}</TextField>
    <Button disabled={busy} onClick={()=>void act(()=>realApi.updateAgent(app.agentId,{activeEngine:engine,model:model.trim()||null}))}>Save model</Button>
    <Button href={`/branches?branch=${encodeURIComponent(app.branchId)}&tab=workflow`}>More options</Button></>}
   {assistant&&<Button disabled={busy} onClick={()=>void configure(!status.data?.enabled)}>{status.data?.enabled?'Disable Assistant':'Enable Assistant'}</Button>}
  </Stack></DialogContent></Dialog>
 </Box></WorkspaceConnectionProvider>;
}


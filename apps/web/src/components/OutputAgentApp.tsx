import {useUnsavedForm} from '../reloadSafety';
import {ConfirmDialog} from './ConfirmationDialogs';
import {useAppViewport} from '../hooks/useAppViewport';
import {setStandaloneWorkspaceOwner} from '../api/productScope';
import {useEffect,useRef,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Alert,Box,Button,Dialog,DialogActions,DialogContent,DialogTitle,FormControlLabel,Stack,Switch,MenuItem,TextField,Typography} from '@mui/material';
import type {AssistantStatusDto,OutputAgentAppDto} from '@ponderosa/core';
import {realApi,requestJson} from '../api/real';
import type {BranchRoute} from '../branchesRouting';
import type {ColorMode} from '../theme';
import {BranchChats} from './branches/BranchChats';
import {WorkspaceConnectionProvider} from './WorkspaceConnectionContext';
import {useWorkspaceStream} from '../hooks/useWorkspaceStream';
import {useWorkspacePreferences} from '../hooks/queries';
import {useWorkspaceFont} from '../hooks/useWorkspaceFont';
import {TextSizeSetting} from './TextSizeSetting';

/** Output apps use canonical Agent chat, attachments, voice, calls and streams. */
export function OutputAgentApp({colorMode,onToggleColorMode}:{colorMode:ColorMode;onToggleColorMode():void}):JSX.Element{
 useAppViewport();
 const assistant=window.location.pathname==='/assistant';
 const id=assistant?undefined:decodeURIComponent(window.location.pathname.split('/')[2]??'');
 const connection=useWorkspaceStream();
 const preferences=useWorkspacePreferences();
 useWorkspaceFont(preferences.data?.fontFamily);
 const [discardSettings,setDiscardSettings]=useState(false);
 const [settings,setSettings]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const inFlight=useRef(false);
 const [automatic,setAutomatic]=useState(true),[minutes,setMinutes]=useState('10'),[model,setModel]=useState(''),[engine,setEngine]=useState('');
 const [route,setRoute]=useState<BranchRoute>();
 const status=useQuery({queryKey:['assistant-status'],enabled:assistant,queryFn:()=>requestJson<AssistantStatusDto>('/api/branches/assistant'),refetchInterval:15000});
 const output=useQuery({queryKey:['output-app',id],enabled:!assistant&&Boolean(id),retry:false,queryFn:()=>requestJson<OutputAgentAppDto>(`/api/branches/output-apps/${encodeURIComponent(id!)}`),refetchInterval:15000});
 const engines=useQuery({queryKey:['output-app-engines'],queryFn:()=>realApi.listEngines()});
 const app=assistant?status.data?.app:output.data;
 const ownerKey=app?`${app.branchId}:${app.chatId}:${app.agentId}`:'';
 useEffect(()=>{
  if(!app){setRoute(undefined);return;}
  setStandaloneWorkspaceOwner({branchId:app.branchId,chatId:app.chatId});
  setRoute({branchId:app.branchId,tab:'chats',chatId:app.chatId,workspace:{kind:'agent',projectId:app.projectId,agentId:app.agentId}});
  return()=>setStandaloneWorkspaceOwner(undefined);
 },[ownerKey]);
 // Refresh the draft when settings opens; background refreshes must not erase edits.
 useEffect(()=>{if(settings&&app){setAutomatic(app.automatic);setMinutes(String((app.everyMs??600000)/60000));setModel(app.model??'');setEngine(app.engine);}},[settings,ownerKey]);
 const refresh=async()=>{if(assistant)await status.refetch();else await output.refetch();};
 const act=async(work:()=>Promise<unknown>)=>{
  if(inFlight.current)return;
  inFlight.current=true;setBusy(true);setError('');
  try{await work();await refresh();}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
  finally{inFlight.current=false;setBusy(false);}
 };
 const configure=(enabled:boolean)=>act(()=>requestJson('/api/branches/assistant',{method:'POST',body:JSON.stringify({enabled})}));
 useEffect(()=>{if(assistant&&status.data&&!status.data.initialized)void act(()=>requestJson('/api/branches/assistant',{method:'POST',body:JSON.stringify({initialize:true})}));},[assistant,status.data?.initialized]);
 const interval=Number(minutes),validInterval=minutes.trim()!==''&&Number.isFinite(interval)&&interval>=1&&Number.isSafeInteger(interval*60000);
 const settingsDirty=Boolean(app&&(automatic!==app.automatic||interval!==(app.everyMs??600000)/60000||engine!==app.engine||model!==(app.model??'')));
 useUnsavedForm('output-app-settings',settings&&settingsDirty);
 const closeSettings=()=>{if(busy)return;if(settingsDirty)setDiscardSettings(true);else setSettings(false);};
 const saveSchedule=()=>{
  if(!app||!validInterval)return;
  void act(()=>requestJson(`/api/branches/output-apps/${encodeURIComponent(app.agentId)}/schedule`,{method:'PUT',body:JSON.stringify({expectedVersionId:app.versionId,expectedSettingsRevision:app.settingsRevision,automatic,everyMs:interval*60000})}));
 };
 return <WorkspaceConnectionProvider value={connection}><Box component="main" sx={{height:'var(--ponderosa-app-viewport-block-size, 100dvh)',display:'flex',flexDirection:'column',minHeight:0,minWidth:0,pb:'env(safe-area-inset-bottom)'}}>
  <Stack direction="row" alignItems="center" spacing={1} useFlexGap flexWrap="wrap" sx={{p:1,pt:'max(8px, env(safe-area-inset-top))',borderBottom:1,borderColor:'divider',flexShrink:0}}>
   <Typography component="h1" variant="h6" sx={{flex:'1 1 8rem',minWidth:0,overflowWrap:'anywhere'}}>{app?.title??(assistant?'Assistant':'Chat')}</Typography>
   {app&&route&&(route.workspace?.kind!=='agent'||route.workspace.agentId!==app.agentId)&&<Button onClick={()=>setRoute({branchId:app.branchId,tab:'chats',chatId:app.chatId,workspace:{kind:'agent',projectId:app.projectId,agentId:app.agentId}})}>Back to chat</Button>}
   <Button href="/home">Ponderosa</Button><Button onClick={()=>{setError('');setSettings(true);}}>Settings</Button>
  </Stack>
  {error&&!settings&&<Alert severity="error">{error}</Alert>}
  {(status.isError||output.isError)&&<Alert severity="error" action={<Button onClick={()=>void refresh()}>Retry</Button>}>{((status.error??output.error) as Error)?.message??'Chat unavailable'}</Alert>}
  {!app&&assistant&&status.data?.setupError&&<Alert severity="error">{status.data.setupError.message}</Alert>}
  {!app&&assistant&&status.data?.initialized&&<Stack spacing={1} sx={{p:2}}><Typography>Assistant is disabled</Typography><Button disabled={busy} onClick={()=>void configure(true)}>Enable Assistant</Button></Stack>}
  {!app&&(assistant?status.isPending||busy:output.isPending)&&<Typography role="status" sx={{p:2}}>Loading…</Typography>}
  {app&&route&&<Box sx={{flex:1,minHeight:0,minWidth:0,display:'flex'}}><BranchChats standalone branchId={app.branchId} engines={engines.data??[]} enginesLoaded={Boolean(engines.data)} branchRoute={route} onNavigate={next=>{
   setRoute(next);return true;
  }}/></Box>}
  <Dialog open={settings} onClose={closeSettings} aria-labelledby="output-app-settings-title" fullWidth maxWidth="xs">
   <DialogTitle id="output-app-settings-title">Settings</DialogTitle><DialogContent><Stack spacing={2} sx={{pt:1}}>
    {error&&<Alert severity="error">{error}</Alert>}
    <Button onClick={onToggleColorMode}>Use {colorMode==='dark'?'Light':'Dark'} Mode</Button><TextSizeSetting/>
    {app&&<><FormControlLabel control={<Switch disabled={busy} checked={automatic} onChange={(_,value)=>setAutomatic(value)}/>} label="Run automatically"/>
     <TextField disabled={busy} label="Check every (minutes)" type="number" value={minutes} onChange={event=>setMinutes(event.target.value)} error={!validInterval} helperText={!validInterval?'Enter at least 1 minute.':undefined} inputProps={{min:1,step:'any'}}/>
     <Button disabled={busy||!validInterval} onClick={saveSchedule}>Save schedule</Button>
     {engines.isError&&<Alert severity="error" action={<Button onClick={()=>void engines.refetch()}>Retry</Button>}>{engines.error.message}</Alert>}
     <TextField disabled={busy||engines.isPending} select label="Provider" value={engine} onChange={event=>{setEngine(event.target.value);setModel(engines.data?.find(item=>item.id===event.target.value)?.defaultModel??'');}}>
      {engine&&!engines.data?.some(item=>item.id===engine)&&<MenuItem value={engine}>{engine}</MenuItem>}
      {engines.data?.map(item=><MenuItem key={item.id} value={item.id}>{item.displayName}</MenuItem>)}
     </TextField>
     <TextField disabled={busy||engines.isPending} select label="Model" SelectProps={{displayEmpty:true}} InputLabelProps={{shrink:true}} value={model} onChange={event=>setModel(event.target.value)}>
      <MenuItem value="">Provider default</MenuItem>{model&&!engines.data?.find(item=>item.id===engine)?.models.some(item=>item.id===model)&&<MenuItem value={model}>{model}</MenuItem>}{engines.data?.find(item=>item.id===engine)?.models.filter(item=>item.id).map(item=><MenuItem key={item.id} value={item.id}>{item.label}</MenuItem>)}
     </TextField>
     <Button disabled={busy||!engine} onClick={()=>void act(()=>realApi.updateAgent(app.agentId,{activeEngine:engine,model:model.trim()||null}))}>Save model</Button>
     <Button href={`/branches?branch=${encodeURIComponent(app.branchId)}&tab=workflow`}>More options</Button>
    </>}
    {assistant&&<Button disabled={busy||status.isPending} onClick={()=>void configure(!status.data?.enabled)}>{status.data?.enabled?'Disable Assistant':'Enable Assistant'}</Button>}
   </Stack></DialogContent><DialogActions><Button disabled={busy} onClick={closeSettings}>Done</Button></DialogActions>
  </Dialog>
  <ConfirmDialog open={discardSettings} title="Unsaved settings" confirmLabel="Discard changes" cancelLabel="Keep editing" onCancel={()=>setDiscardSettings(false)} onConfirm={()=>{setDiscardSettings(false);setSettings(false);}}>Discard unsaved schedule or model changes?</ConfirmDialog>
 </Box></WorkspaceConnectionProvider>;
}

import {ConversationChromeContext} from './ConversationChromeContext';
import {PrimaryHeaderActionsOutlet} from './PrimaryHeaderActions';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import ArrowBackIosNewIcon from '@mui/icons-material/ArrowBackIosNew';
import {IconButton,Tooltip,CircularProgress} from '@mui/material';
import {MobileNavigationButton} from './MobileNavigationContext';
import {nextIntervalTime} from "@ponderosa/core";
import {confirmUnsavedNavigation,useUnsavedForm} from '../reloadSafety';
import {ConfirmDialog} from './ConfirmationDialogs';
import {useAppViewport} from '../hooks/useAppViewport';
import {setStandaloneWorkspaceOwner} from '../api/productScope';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
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

function ConversationNotice({title,cause,onRetry}:{title:string;cause:string;onRetry?():void}):JSX.Element{
 return <Alert severity="error" sx={{mx:{xs:1,sm:2},my:1,py:.25,flexShrink:0}} action={onRetry?<Button onClick={onRetry}>Retry</Button>:undefined}>
  <Typography variant="body2">{title}</Typography>
  <Box component="details" sx={{fontSize:'.8125rem',lineHeight:1.5,'& summary':{cursor:'pointer',py:.5,minHeight:44},'& pre':{m:0,maxHeight:'20vh',overflow:'auto',whiteSpace:'pre-wrap',overflowWrap:'anywhere',font:'inherit'}}}><summary>Details</summary><pre>{cause}</pre></Box>
 </Alert>;
}
/** Output apps use canonical Agent chat, attachments, voice, calls and streams. */
export function OutputAgentApp({colorMode,onToggleColorMode,embedded=false,returnTo}:{colorMode:ColorMode;onToggleColorMode():void;embedded?:boolean;returnTo?:string}):JSX.Element{
 useAppViewport();
 const [statusHost,setStatusHost]=useState<HTMLDivElement|null>(null);
 const [callActionsHost,setCallActionsHost]=useState<HTMLDivElement|null>(null);
 const assistant=embedded||window.location.pathname==='/assistant';
 const id=assistant?undefined:decodeURIComponent(window.location.pathname.split('/')[2]??'');
 const connection=useWorkspaceStream();
 const preferences=useWorkspacePreferences();
 useWorkspaceFont(preferences.data?.fontFamily);
 const [discardSettings,setDiscardSettings]=useState(false);
 const [settings,setSettings]=useState(false),[error,setError]=useState(''),[pendingAction,setPendingAction]=useState<false|'saving'|'reloading'>(false),[saved,setSaved]=useState('');
 const busy=Boolean(pendingAction);
 const inFlight=useRef(false);
 const ownerGeneration=useRef(0),mounted=useRef(false);
 const [automatic,setAutomatic]=useState(true),[minutes,setMinutes]=useState('10'),[model,setModel]=useState(''),[engine,setEngine]=useState('');
 const [route,setRoute]=useState<BranchRoute>();
 const [scheduleBase,setScheduleBase]=useState<OutputAgentAppDto>(),[runtimeBase,setRuntimeBase]=useState<OutputAgentAppDto>();
 const status=useQuery({queryKey:['assistant-status'],enabled:assistant,queryFn:()=>requestJson<AssistantStatusDto>('/api/branches/assistant'),refetchInterval:15000});
 const output=useQuery({queryKey:['output-app',id],enabled:!assistant&&Boolean(id),retry:false,queryFn:()=>requestJson<OutputAgentAppDto>(`/api/branches/output-apps/${encodeURIComponent(id!)}`),refetchInterval:15000});
 const engines=useQuery({queryKey:['output-app-engines'],queryFn:()=>realApi.listEngines()});
 const app=assistant?status.data?.app:output.data;
 const ownerKey=app?`${app.branchId}:${app.chatId}:${app.agentId}`:'';
 // Fence feedback before paint and invalidate late completions, including A → B → A.
 useLayoutEffect(()=>{
  mounted.current=true;ownerGeneration.current++;setSaved('');setError('');
  return()=>{mounted.current=false;ownerGeneration.current++;};
 },[ownerKey]);
 useEffect(()=>{
  if(!app){setRoute(undefined);return;}
  setStandaloneWorkspaceOwner({branchId:app.branchId,chatId:app.chatId});
  setRoute({branchId:app.branchId,tab:'chats',chatId:app.chatId,workspace:{kind:'agent',projectId:app.projectId,agentId:app.agentId,view:'chat'}});
  return()=>setStandaloneWorkspaceOwner(undefined);
 },[ownerKey]);
 // Refresh the draft when settings opens; background refreshes must not erase edits.
 const loadDraft=(value:OutputAgentAppDto)=>{setScheduleBase(value);setRuntimeBase(value);setAutomatic(value.automatic);setMinutes(String((value.everyMs??600000)/60000));setModel(value.model??'');setEngine(value.engine);};
 useEffect(()=>{if(settings&&app)loadDraft(app);},[settings,ownerKey]);
 const refresh=async(onFresh?:(value:OutputAgentAppDto)=>void)=>{
  try{
   const result=assistant?await status.refetch():await output.refetch();
   const fresh=assistant?(result.data as AssistantStatusDto|undefined)?.app:result.data as OutputAgentAppDto|undefined;
   if(!result.error&&fresh)onFresh?.(fresh);
   return result.error;
  }catch(cause){return cause instanceof Error?cause:new Error(String(cause));}
 };
 const retryRefresh=async(reloadDraft=false)=>{
  if(inFlight.current)return;
  inFlight.current=true;setPendingAction('reloading');
  const generation=ownerGeneration.current;
  const cause=await refresh(value=>{if(reloadDraft&&mounted.current&&generation===ownerGeneration.current)loadDraft(value);});
  inFlight.current=false;if(mounted.current)setPendingAction(false);
  if(mounted.current&&generation===ownerGeneration.current){setSaved('');setError(cause?`Could not refresh settings: ${cause.message}`:'');}
 };
 const act=async<T,>(work:()=>Promise<T>,savedLabel='',onCommitted?:(value:T)=>void)=>{
  if(inFlight.current)return;
  const generation=ownerGeneration.current;
  const current=()=>mounted.current&&generation===ownerGeneration.current;
  inFlight.current=true;setPendingAction('saving');setError('');setSaved('');
  try{
   const committed=await work();
   // Only this mutation can advance its draft baseline; a later read may contain another editor's work.
   if(current())onCommitted?.(committed);
   const cause=await refresh();
   if(current()){
    setSaved(cause?'':savedLabel);
    setError(cause?`Changes saved, but settings could not be refreshed: ${cause.message}`:'');
   }
  }catch(cause){if(current()){setSaved('');setError(cause instanceof Error?cause.message:String(cause));}}
  finally{inFlight.current=false;if(mounted.current)setPendingAction(false);}
 };
 const configure=(enabled:boolean)=>act(()=>requestJson('/api/branches/assistant',{method:'POST',body:JSON.stringify({enabled})}));
 useEffect(()=>{if(assistant&&status.data&&!status.data.initialized)void act(()=>requestJson('/api/branches/assistant',{method:'POST',body:JSON.stringify({initialize:true})}));},[assistant,status.data?.initialized]);
 const scheduleSource=settings?scheduleBase:app;
 const editableInterval=scheduleSource?.triggerKind==='manual'||scheduleSource?.schedule?.scheduleKind==='interval';
 const intervalChanged=Boolean(editableInterval&&scheduleSource&&Number(minutes)!==(scheduleSource.everyMs??600000)/60000);
 const interval=Number(minutes);let intervalError:string|undefined;
 if(editableInterval){
  if(!minutes.trim()||interval<1)intervalError='Enter at least 1 minute.';
  else try{const now=Date.now();nextIntervalTime(interval*60000,now,now);}
  catch(cause){intervalError=cause instanceof Error?cause.message:'Invalid interval.';}
 }
 const validInterval=!intervalError;
 const settingsDirty=Boolean(scheduleBase&&(automatic!==scheduleBase.automatic||intervalChanged)||runtimeBase&&(engine!==runtimeBase.engine||model!==(runtimeBase.model??'')));
 useUnsavedForm('output-app-settings',settings&&settingsDirty);
 const closeSettings=()=>{if(busy)return;if(settingsDirty)setDiscardSettings(true);else setSettings(false);};
 const saveSchedule=()=>{
  if(!app||!scheduleBase||!validInterval)return;
  void act(()=>requestJson<OutputAgentAppDto>(`/api/branches/output-apps/${encodeURIComponent(app.agentId)}/schedule`,{method:'PUT',body:JSON.stringify({expectedVersionId:scheduleBase.versionId,expectedSettingsRevision:scheduleBase.settingsRevision,automatic,...(intervalChanged||(scheduleBase.triggerKind==='manual'&&automatic)?{everyMs:interval*60000}:{})})}),'Schedule saved',value=>setScheduleBase(value));
 };
 return <ConversationChromeContext.Provider value={{statusHost,callActionsHost}}><WorkspaceConnectionProvider value={connection}><Box component={embedded?'section':'main'} data-assistant-conversation={assistant||undefined} sx={{height:embedded?'100%':'var(--ponderosa-app-viewport-block-size, 100dvh)',flex:1,display:'flex',flexDirection:'column',minHeight:0,minWidth:0,pb:'env(safe-area-inset-bottom)'}}>
  <Stack component="header" direction="row" alignItems="center" spacing={1} sx={{px:{xs:1,sm:2.5},minHeight:{xs:76,sm:64},pt:embedded?0:'env(safe-area-inset-top)',borderBottom:1,borderColor:'divider',flexShrink:0}}>
   {embedded?<><MobileNavigationButton/>{returnTo&&<Tooltip title="Back to your Chat"><IconButton href={returnTo} aria-label="Back to your Chat" onClick={event=>{if(!confirmUnsavedNavigation())event.preventDefault();}} sx={{width:44,height:44}}><ArrowBackIosNewIcon sx={{fontSize:20}}/></IconButton></Tooltip>}</>:<Button href="/home" color="inherit" sx={{minHeight:44}}>Ponderosa</Button>}
   <Box sx={{flex:1,minWidth:0}}><Typography component="h1" sx={{fontWeight:650,fontSize:'1rem',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{assistant?'Assistant':app?.title??'Chat'}</Typography>
    <Box ref={setStatusHost} sx={{minWidth:0,maxWidth:260,'& .MuiStack-root':{flexWrap:'nowrap'},'& .MuiTypography-root':{overflow:'hidden',textOverflow:'ellipsis'}}}/></Box>
   {app&&route&&(route.workspace?.kind!=='agent'||route.workspace.agentId!==app.agentId)&&<Button onClick={()=>setRoute({branchId:app.branchId,tab:'chats',chatId:app.chatId,workspace:{kind:'agent',projectId:app.projectId,agentId:app.agentId,view:'chat'}})}>Back to chat</Button>}
   <Box ref={setCallActionsHost} sx={{display:'flex',alignItems:'center',flexShrink:0,'&:empty':{display:'none'}}}/>
   <Box sx={{display:{xs:'none',sm:'flex'}}}><PrimaryHeaderActionsOutlet/></Box>
   <Tooltip title="Conversation settings"><IconButton aria-label="Settings" onClick={()=>{setError('');setSaved('');setSettings(true);}} sx={{width:44,height:44}}><SettingsOutlinedIcon sx={{fontSize:21}}/></IconButton></Tooltip>
  </Stack>
  {error&&!settings&&<ConversationNotice title="Conversation settings need attention." cause={error} onRetry={()=>void retryRefresh()}/>}
  {(status.isError||output.isError)&&<ConversationNotice title={app?'Conversation updates are temporarily unavailable.':assistant?'Assistant could not be opened.':'This conversation could not be opened.'} cause={((status.error??output.error) as Error)?.message??'Chat unavailable'} onRetry={()=>void retryRefresh()}/>}
  {!app&&assistant&&status.data?.setupError&&<ConversationNotice title="Assistant needs attention before it can open." cause={status.data.setupError.message} onRetry={()=>void retryRefresh()}/>}
  {!app&&assistant&&status.data?.initialized&&<Stack spacing={1.5} alignItems="center" justifyContent="center" sx={{flex:1,p:3,textAlign:'center'}}><Typography component="h2" sx={{fontSize:'1.5rem',fontWeight:600}}>Your Assistant is paused</Typography><Typography color="text.secondary">Enable Assistant to continue your conversation.</Typography><Button disabled={busy} onClick={()=>void configure(true)}>Enable Assistant</Button></Stack>}
  {!app&&(assistant?status.isPending||busy:output.isPending)&&<Stack role="status" alignItems="center" justifyContent="center" spacing={2} sx={{flex:1,p:3}}><CircularProgress size={24}/><Typography color="text.secondary">Opening your conversation…</Typography></Stack>}
  {app&&route&&<Box sx={{flex:1,minHeight:0,minWidth:0,display:'flex'}}><BranchChats standalone branchId={app.branchId} engines={engines.data??[]} enginesLoaded={Boolean(engines.data)} branchRoute={route} onNavigate={next=>{
   setRoute(next);return true;
  }}/></Box>}
  <Dialog open={settings} onClose={closeSettings} aria-labelledby="output-app-settings-title" fullWidth maxWidth="xs">
   <DialogTitle id="output-app-settings-title">Settings</DialogTitle><DialogContent><Stack spacing={2} sx={{pt:1}}>
    {error&&<Alert severity="error">{error}</Alert>}
    <Typography role="status" variant="body2" sx={{minHeight:"1.5em"}}>{pendingAction==='reloading'?'Reloading…':busy?'Saving…':saved}</Typography>
    <Button onClick={onToggleColorMode}>Use {colorMode==='dark'?'Light':'Dark'} Mode</Button><TextSizeSetting/><Button href="/branches?settings=activity">Provider activity</Button>
    {app&&<><FormControlLabel control={<Switch disabled={busy} checked={automatic} onChange={(_,value)=>{setSaved('');setAutomatic(value);}}/>} label="Run automatically"/>
     {editableInterval?<TextField disabled={busy} label="Check every (minutes)" type="number" value={minutes} onChange={event=>{setSaved('');setMinutes(event.target.value);}} error={!validInterval} helperText={intervalError} inputProps={{min:1,step:'any'}}/>:<Typography>{scheduleSource?.schedule?.scheduleKind==='cron'?`Cron schedule: ${scheduleSource?.schedule.expression} (${scheduleSource?.schedule.timezone})`:scheduleSource?.schedule?.scheduleKind==='once'?`Once at ${scheduleSource?.schedule.at}`:scheduleSource?.triggerKind==='filesystem'?'When files change':'When a webhook event arrives'}</Typography>}
     <Button disabled={busy||!validInterval} onClick={saveSchedule}>Save schedule</Button>
     {engines.isError&&<Alert severity="error" action={<Button onClick={()=>void engines.refetch()}>Retry</Button>}>{engines.error.message}</Alert>}
     <TextField disabled={busy||engines.isPending} select label="Provider" value={engine} onChange={event=>{setSaved('');setEngine(event.target.value);setModel(engines.data?.find(item=>item.id===event.target.value)?.defaultModel??'');}}>
      {engine&&!engines.data?.some(item=>item.id===engine)&&<MenuItem value={engine}>{engine}</MenuItem>}
      {engines.data?.map(item=><MenuItem key={item.id} value={item.id}>{item.displayName}</MenuItem>)}
     </TextField>
     <TextField disabled={busy||engines.isPending} select label="Model" SelectProps={{displayEmpty:true}} InputLabelProps={{shrink:true}} value={model} onChange={event=>{setSaved('');setModel(event.target.value);}}>
      <MenuItem value="">Provider default</MenuItem>{model&&!engines.data?.find(item=>item.id===engine)?.models.some(item=>item.id===model)&&<MenuItem value={model}>{model}</MenuItem>}{engines.data?.find(item=>item.id===engine)?.models.filter(item=>item.id).map(item=><MenuItem key={item.id} value={item.id}>{item.label}</MenuItem>)}
     </TextField>
     <Button disabled={busy||!engine||!runtimeBase?.runtimeSettings} onClick={()=>void act(()=>realApi.updateAgent(app.agentId,{activeEngine:engine,model:model.trim()||null,expectedRuntimeSettings:runtimeBase!.runtimeSettings}),'Model saved',value=>setRuntimeBase({...runtimeBase!,engine:value.activeEngine,model:value.model??undefined,runtimeSettings:{activeEngine:value.activeEngine,model:value.model??null,effort:value.effort??null,speed:value.speed??null}}))}>Save model</Button>
     <Button href={`/branches?branch=${encodeURIComponent(app.branchId)}&tab=workflow`}>More options</Button>
     <Button disabled={busy} onClick={()=>void retryRefresh(true)}>Discard draft and reload</Button>
    </>}
    {assistant&&<Button disabled={busy||status.isPending} onClick={()=>void configure(!status.data?.enabled)}>{status.data?.enabled?'Disable Assistant':'Enable Assistant'}</Button>}
   </Stack></DialogContent><DialogActions><Button disabled={busy} onClick={closeSettings}>Done</Button></DialogActions>
  </Dialog>
  <ConfirmDialog open={discardSettings} title="Unsaved settings" confirmLabel="Discard changes" cancelLabel="Keep editing" onCancel={()=>setDiscardSettings(false)} onConfirm={()=>{setDiscardSettings(false);setSettings(false);}}>Discard unsaved schedule or model changes?</ConfirmDialog>
 </Box></WorkspaceConnectionProvider></ConversationChromeContext.Provider>;
}

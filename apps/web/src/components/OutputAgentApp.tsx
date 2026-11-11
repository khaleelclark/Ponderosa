import {createClientId} from "../clientId";
import {productApiPath} from "../api/productScope";
import {useMutationNotification} from "./MutationNotifications";
import {WorkspaceQueryError} from "./WorkspaceQueryError";
import {workspaceRead,availabilityFailure} from "../workspaceAvailability";
import {ConversationChromeContext} from './ConversationChromeContext';
import {PrimaryHeaderActionsOutlet} from './PrimaryHeaderActions';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import ArrowBackIosNewIcon from '@mui/icons-material/ArrowBackIosNew';
import {IconButton,Tooltip,CircularProgress} from '@mui/material';
import {MobileNavigationButton} from './MobileNavigationContext';
import {normalizeAgentTitle,nextIntervalTime} from "@ponderosa/core";
import {confirmUnsavedNavigation,useUnsavedForm} from '../reloadSafety';
import {ConfirmDialog} from './ConfirmationDialogs';
import {useAppViewport} from '../hooks/useAppViewport';
import {setStandaloneWorkspaceOwner} from '../api/productScope';
import {useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {ThemeProvider} from '@mui/material/styles';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {ApiRequestError} from '../api/types';
import {Alert,Box,Button,Dialog,DialogActions,DialogContent,DialogTitle,FormControlLabel,Stack,Switch,MenuItem,TextField,Typography} from '@mui/material';
import type {AssistantStatusDto,OutputAgentAppDto} from '@ponderosa/core';
import {realApi,requestJson} from '../api/real';
import type {BranchRoute} from '../branchesRouting';
import {ponderosaSurfaceVariables,createPonderosaTheme,type ColorMode} from '../theme';
import {BranchChats} from './branches/BranchChats';
import {WorkspaceConnectionNotice} from './WorkspaceConnectionNotice';
import {WorkspaceRefreshProvider} from './WorkspaceRefreshContext';
import {WorkspaceConnectionProvider} from './WorkspaceConnectionContext';
import {useWorkspaceStream} from '../hooks/useWorkspaceStream';
import {useWorkspacePreferences} from '../hooks/queries';
import {useWorkspaceFont} from '../hooks/useWorkspaceFont';
import {TextSizeSetting} from './TextSizeSetting';

function ConversationNotice({title,cause,onRetry}:{title:string;cause:string;onRetry?():void}):JSX.Element{
 const [expanded,setExpanded]=useState(true);
 if(!expanded)return <Box component="details" sx={{mx:1,fontSize:".8125rem"}}><summary>{title}</summary><Typography variant="caption">{cause}</Typography>{onRetry&&<Button onClick={onRetry}>Retry</Button>}</Box>;
 return <Alert severity="error" onClose={()=>setExpanded(false)} sx={{mx:{xs:1,sm:2},my:1,py:.25,flexShrink:0}} action={onRetry?<Button onClick={onRetry}>Retry</Button>:undefined}>
  <Typography variant="body2">{title}</Typography>
  <Box component="details" sx={{fontSize:'.8125rem',lineHeight:1.5,'& summary':{cursor:'pointer',py:.5,minHeight:44},'& pre':{m:0,maxHeight:'20vh',overflow:'auto',whiteSpace:'pre-wrap',overflowWrap:'anywhere',font:'inherit'}}}><summary>Details</summary><pre>{cause}</pre></Box>
 </Alert>;
}
/** Output apps use canonical Agent chat, attachments, voice, calls and streams. */
export function OutputAgentApp({colorMode,onToggleColorMode,embedded=false,returnTo,onIdentityChanged}:{colorMode:ColorMode;onToggleColorMode():void;embedded?:boolean;returnTo?:string;onIdentityChanged?():void}):JSX.Element{
 useAppViewport(!embedded);
 const assistantTheme=useMemo(()=>createPonderosaTheme(colorMode,"assistant"),[colorMode]);
 const [statusHost,setStatusHost]=useState<HTMLDivElement|null>(null);
 const [callActionsHost,setCallActionsHost]=useState<HTMLDivElement|null>(null);
 const assistant=embedded||window.location.pathname==='/assistant';
 const id=assistant?undefined:decodeURIComponent(window.location.pathname.split('/')[2]??'');
 const connection=useWorkspaceStream();
 const preferences=useWorkspacePreferences();
 useWorkspaceFont(preferences.data?.fontFamily);
 const [discardSettings,setDiscardSettings]=useState(false);
 const notify=useMutationNotification(),client=useQueryClient();
 const [name,setName]=useState(''),[nameBase,setNameBase]=useState<OutputAgentAppDto>();
 const [conflict,setConflict]=useState(false),[disableSettings,setDisableSettings]=useState(false);
 const [settings,setSettings]=useState(false),[error,setError]=useState(''),[pendingAction,setPendingAction]=useState<false|'saving'|'reloading'>(false),[saved,setSaved]=useState('');
 const busy=Boolean(pendingAction);
 const inFlight=useRef(false);
 const ownerGeneration=useRef(0),mounted=useRef(false);
 const [automatic,setAutomatic]=useState(true),[minutes,setMinutes]=useState('10'),[model,setModel]=useState(''),[engine,setEngine]=useState('');
 const [route,setRoute]=useState<BranchRoute>();
 const [scheduleBase,setScheduleBase]=useState<OutputAgentAppDto>(),[runtimeBase,setRuntimeBase]=useState<OutputAgentAppDto>();
 const status=useQuery({queryKey:['assistant-status'],enabled:assistant,queryFn:({signal})=>requestJson<AssistantStatusDto>('/api/branches/assistant',{signal}),refetchInterval:15000});
 const output=useQuery({queryKey:['output-app',id],enabled:!assistant&&Boolean(id),retry:false,queryFn:({signal})=>requestJson<OutputAgentAppDto>(`/api/branches/output-apps/${encodeURIComponent(id!)}`,{signal}),refetchInterval:15000});
 const engines=useQuery({queryKey:['output-app-engines'],queryFn:()=>realApi.listEngines()});
 const app=assistant?status.data?.app:output.data;
 const displayName=app?.title??(assistant?'Assistant':'Chat');
 useEffect(()=>{if(assistant)document.title=`${displayName} · Ponderosa`;},[assistant,displayName]);
 const ownerKey=app?`${app.branchId}:${app.chatId}:${app.agentId}`:'';
 // The Core host has its own QueryClient; refresh its GET projection, never its setup POST.
 useEffect(()=>{if(assistant&&app)onIdentityChanged?.();},[assistant,ownerKey,app?.title]);
 // Fence feedback before paint and invalidate late completions, including A → B → A.
 useLayoutEffect(()=>{
  mounted.current=true;ownerGeneration.current++;setSaved('');setError('');setConflict(false);setDisableSettings(false);
  return()=>{mounted.current=false;ownerGeneration.current++;};
 },[ownerKey]);
 useEffect(()=>{
  if(!app){setRoute(undefined);return;}
  setStandaloneWorkspaceOwner({branchId:app.branchId,chatId:app.chatId});
  setRoute({branchId:app.branchId,tab:'chats',chatId:app.chatId,workspace:{kind:'agent',projectId:app.projectId,agentId:app.agentId,view:'chat'}});
  return()=>setStandaloneWorkspaceOwner(undefined);
 },[ownerKey]);
 // Refresh the draft when settings opens; background refreshes must not erase edits.
 const loadDraft=(value:OutputAgentAppDto)=>{setConflict(false);setNameBase(value);setName(value.title);setScheduleBase(value);setRuntimeBase(value);setAutomatic(value.automatic);setMinutes(String((value.everyMs??600000)/60000));setModel(value.model??'');setEngine(value.engine);};
 useEffect(()=>{if(settings&&app)loadDraft(app);},[settings,ownerKey]);
 const refresh=async(onFresh?:(value:OutputAgentAppDto)=>void)=>{
  try{
   const result=assistant?await status.refetch():await output.refetch();
   const fresh=assistant?(result.data as AssistantStatusDto|undefined)?.app:result.data as OutputAgentAppDto|undefined;
   if(!result.error&&fresh)onFresh?.(fresh);
   return result.error;
  }catch(cause){return cause instanceof Error?cause:new Error(String(cause));}
 };
 const commitApp=(patch:Partial<OutputAgentAppDto>)=>{
  if(assistant)client.setQueryData<AssistantStatusDto>(['assistant-status'],current=>current?.app?{...current,app:{...current.app,...patch}}:current);
  else client.setQueryData<OutputAgentAppDto>(['output-app',id],current=>current?{...current,...patch}:current);
 };
 const retryRefresh=async(reloadDraft=false)=>{
  if(inFlight.current)return;
  inFlight.current=true;setPendingAction('reloading');
  const generation=ownerGeneration.current;
  const cause=await refresh(value=>{if(reloadDraft&&mounted.current&&generation===ownerGeneration.current)loadDraft(value);});
  inFlight.current=false;if(mounted.current)setPendingAction(false);
  if(mounted.current&&generation===ownerGeneration.current){setSaved('');if(!cause)setError('');}
 };
 const act=async<T,>(work:()=>Promise<T>,savedLabel='',onCommitted?:(value:T)=>void,operation='configure',announce=true)=>{
  if(inFlight.current)return;
  const generation=ownerGeneration.current;
  const key=JSON.stringify([productApiPath("/api/branches"),ownerKey||(assistant?"assistant":id),operation]);
  const incident=createClientId("settings-feedback-");
  const current=()=>mounted.current&&generation===ownerGeneration.current;
  inFlight.current=true;setPendingAction('saving');setError('');setSaved('');
  try{
   const committed=await work();
   if(announce)notify({key,message:"",dismiss:true});
   // Only this mutation can advance its draft baseline; a later read may contain another editor's work.
   if(current())onCommitted?.(committed);
   const cause=await refresh();
   if(current()){
    setSaved(cause?'Changes saved. Current settings are still being checked.':savedLabel);
    setError('');
   }
  }catch(cause){if(current()&&(announce||!availabilityFailure(cause))){setSaved('');setError(cause instanceof Error?cause.message:String(cause));if(cause instanceof ApiRequestError&&cause.status===409)setConflict(true);}if(announce)notify({key,incident,severity:'error',message:`${displayName} Settings Not Saved`,description:'Review the original conversation settings before retrying.',details:cause instanceof Error?cause.message:String(cause)});}
  finally{inFlight.current=false;if(mounted.current)setPendingAction(false);}
 };
 const configure=(enabled:boolean)=>act(()=>requestJson('/api/branches/assistant',{method:'POST',body:JSON.stringify({enabled})}));
 useEffect(()=>{if(assistant&&status.data&&!status.data.initialized)void act(()=>requestJson('/api/branches/assistant',{method:'POST',body:JSON.stringify({initialize:true})}),'',undefined,'initialize',false);},[assistant,status.data?.initialized]);
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
 let nameError:string|undefined;
 try{if(assistant)normalizeAgentTitle(name);}catch(cause){nameError=cause instanceof Error?cause.message:String(cause);}
 const nameChanged=Boolean(assistant&&nameBase&&name.trim()!==nameBase.title);
 const scheduleChanged=Boolean(scheduleBase&&(automatic!==scheduleBase.automatic||intervalChanged));
 const runtimeChanged=Boolean(runtimeBase&&(engine!==runtimeBase.engine||model!==(runtimeBase.model??'')));
 const settingsDirty=nameChanged||scheduleChanged||runtimeChanged;
 const settingsStale=Boolean(app&&(conflict||nameBase&&nameBase.title!==app.title||scheduleBase&&scheduleBase.settingsRevision!==app.settingsRevision||runtimeBase&&JSON.stringify(runtimeBase.runtimeSettings)!==JSON.stringify(app.runtimeSettings)));
 const saveName=()=>{
  if(!app||!nameBase||nameError||!nameChanged)return;
  void act(()=>realApi.updateAgent(app.agentId,{title:name.trim(),expectedTitle:nameBase.title}),'Name Saved',value=>{
   setName(value.title);setNameBase({...nameBase,title:value.title});commitApp({title:value.title});
   void client.invalidateQueries({queryKey:['agent',app.agentId]});
   void client.invalidateQueries({queryKey:['conversation']});
  },'name');
 };
 useUnsavedForm('output-app-settings',settings&&settingsDirty);
 const closeSettings=()=>{if(busy)return;if(settingsDirty)setDiscardSettings(true);else setSettings(false);};
 const saveSchedule=()=>{
  if(!app||!scheduleBase||!validInterval||!scheduleChanged)return;
  void act(()=>requestJson<OutputAgentAppDto>(`/api/branches/output-apps/${encodeURIComponent(app.agentId)}/schedule`,{method:'PUT',body:JSON.stringify({expectedVersionId:scheduleBase.versionId,expectedSettingsRevision:scheduleBase.settingsRevision,automatic,...(intervalChanged||(scheduleBase.triggerKind==='manual'&&automatic)?{everyMs:interval*60000}:{})})}),'Schedule Saved',value=>{setScheduleBase(value);commitApp(value);},'schedule');
 };
 const descriptorRead=workspaceRead(assistant?"assistant":`output:${id}`,assistant?displayName:"Conversation",assistant?status:output,Boolean(app));
 return <ThemeProvider theme={assistantTheme}><ConversationChromeContext.Provider value={{assistantAgentId:assistant?app?.agentId:undefined,statusHost,callActionsHost}}><WorkspaceConnectionProvider value={connection}><WorkspaceRefreshProvider connection={connection}><Box component={embedded?'section':'main'} data-assistant-conversation data-assistant-layout={assistant||undefined} sx={{...ponderosaSurfaceVariables(colorMode),"--assistant-outgoing":assistantTheme.palette.primary.main,"--assistant-on-outgoing":assistantTheme.palette.primary.contrastText,containerType:assistant?"inline-size":undefined,bgcolor:"background.default",height:embedded?'100%':'var(--ponderosa-app-viewport-block-size, 100dvh)',flex:1,display:'flex',flexDirection:'column',minHeight:0,minWidth:0,pb:'env(safe-area-inset-bottom)'}}>
  <Stack component="header" direction="row" alignItems="center" spacing={assistant?0:1} sx={{px:{xs:1,sm:2.5},minHeight:{xs:76,sm:64},pt:embedded?0:'env(safe-area-inset-top)',borderBottom:1,borderColor:'divider',flexShrink:0,...(assistant?{display:'grid',gridTemplateColumns:'repeat(3, minmax(0, 1fr))'}:{})}}>
   <Box sx={{display:'flex',alignItems:'center',minWidth:0}}>
    {embedded?<><MobileNavigationButton/>{returnTo&&<Tooltip title="Back To Your Chat"><IconButton href={returnTo} aria-label="Back To Your Chat" onClick={event=>{if(!confirmUnsavedNavigation())event.preventDefault();}} sx={{width:44,height:44}}><ArrowBackIosNewIcon sx={{fontSize:20}}/></IconButton></Tooltip>}</>:<Button href="/home" color="inherit" sx={{minHeight:44}}>Ponderosa</Button>}
    {assistant&&<WorkspaceConnectionNotice connection={connection} hasSavedData={Boolean(app)}/>}
   </Box>
   <Box data-conversation-contact sx={{flex:1,minWidth:0,textAlign:assistant?'center':undefined}}><Typography component="h1" sx={{fontWeight:650,fontSize:'1rem',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{displayName}</Typography>
    <Box ref={setStatusHost} sx={{minWidth:0,maxWidth:assistant?'100%':260,'& .MuiStack-root':{flexWrap:'nowrap'},'& .MuiTypography-root':{overflow:'hidden',textOverflow:'ellipsis'}}}/></Box>
   <Box sx={{display:'flex',alignItems:'center',justifyContent:'flex-end',minWidth:0}}>
    {app&&route&&(route.workspace?.kind!=='agent'||route.workspace.agentId!==app.agentId)&&<Button onClick={()=>setRoute({branchId:app.branchId,tab:'chats',chatId:app.chatId,workspace:{kind:'agent',projectId:app.projectId,agentId:app.agentId,view:'chat'}})}>Back To Chat</Button>}
    {!assistant&&<WorkspaceConnectionNotice connection={connection} hasSavedData={Boolean(app)}/>}
    <Box ref={setCallActionsHost} sx={{display:'flex',alignItems:'center',flexShrink:0,'&:empty':{display:'none'}}}/>
    <Box sx={{display:{xs:'none',sm:'flex'},...(assistant?{"@container (max-width: 700px)":{display:"none"}}:{})}}><PrimaryHeaderActionsOutlet/></Box>
    <Tooltip title={`${displayName} Settings`}><IconButton aria-label="Settings" onClick={()=>{setError('');setSaved('');setSettings(true);}} sx={{width:44,height:44}}><SettingsOutlinedIcon sx={{fontSize:21}}/></IconButton></Tooltip>
   </Box>
  </Stack>
  {error&&!settings&&<Box component="details" sx={{mx:1,fontSize:".8125rem"}}><summary>Conversation Settings Need Attention</summary><Typography variant="caption">{error}</Typography><Button onClick={()=>setSettings(true)}>Open Settings</Button></Box>}
  <WorkspaceQueryError initial={!app} reportOnly={settings} read={descriptorRead}/>
  {!app&&assistant&&status.data?.setupError&&<ConversationNotice title="Assistant needs attention before it can open." cause={status.data.setupError.message} onRetry={()=>void retryRefresh()}/>}
  {!app&&assistant&&status.data?.initialized&&<Stack spacing={1.5} alignItems="center" justifyContent="center" sx={{flex:1,p:3,textAlign:'center'}}><Typography component="h2" sx={{fontSize:'1.5rem',fontWeight:600}}>Your Assistant Is Paused</Typography><Typography color="text.secondary">Enable Assistant to continue your conversation.</Typography><Button disabled={busy} onClick={()=>void configure(true)}>Enable Assistant</Button></Stack>}
  {!app&&(assistant?status.isPending||busy:output.isPending)&&<Stack role="status" alignItems="center" justifyContent="center" spacing={2} sx={{flex:1,p:3}}><CircularProgress size={24}/><Typography color="text.secondary">Opening your conversation…</Typography></Stack>}
  {app&&route&&<Box sx={{flex:1,minHeight:0,minWidth:0,display:'flex'}}><BranchChats standalone branchId={app.branchId} engines={engines.data??[]} enginesLoaded={Boolean(engines.data)} branchRoute={route} onNavigate={next=>{
   setRoute(next);return true;
  }}/></Box>}
  <Dialog open={settings} onClose={closeSettings} aria-labelledby="output-app-settings-title" fullWidth maxWidth="xs">
   <DialogTitle id="output-app-settings-title" sx={{overflowWrap:"anywhere"}}>{assistant?`${displayName} Settings`:"Settings"}</DialogTitle><DialogContent><Stack spacing={2} sx={{pt:1}}>
    {settings&&<WorkspaceQueryError read={descriptorRead}/>}
    {error&&<Box component="details"><summary>Settings Action Needs Attention</summary><Typography variant="caption">{error}</Typography></Box>}
    <Typography role="status" variant="body2" sx={{minHeight:"1.5em"}}>{pendingAction==='reloading'?'Reloading…':busy?'Saving…':saved}</Typography>
    {!assistant&&<><Button onClick={onToggleColorMode}>Use {colorMode==='dark'?'Light':'Dark'} Mode</Button><TextSizeSetting/><Button href={assistant?'/settings/activity':'/branches?settings=activity'}>Provider Activity</Button></>}
    {app&&<>
     {assistant&&<Box component="section" aria-label="Profile"><Stack spacing={1.5}><Typography component="h2" variant="subtitle1">Profile</Typography><TextField disabled={busy} label="Name" value={name} onChange={event=>{setSaved('');setName(event.target.value);}} error={Boolean(nameError)} helperText={nameError}/><Button disabled={busy||Boolean(nameError)||!nameChanged} onClick={saveName}>Save Name</Button></Stack></Box>}
     <Box component="section" aria-label="Model"><Stack spacing={1.5}><Typography component="h2" variant="subtitle1">Model</Typography>
     <WorkspaceQueryError read={workspaceRead("workspace","Engines",engines)}/>
     <TextField disabled={busy||engines.isPending} select label="Provider" value={engine} onChange={event=>{setSaved('');setEngine(event.target.value);setModel(engines.data?.find(item=>item.id===event.target.value)?.defaultModel??'');}}>
      {engine&&!engines.data?.some(item=>item.id===engine)&&<MenuItem value={engine}>{engine}</MenuItem>}
      {engines.data?.map(item=><MenuItem key={item.id} value={item.id}>{item.displayName}</MenuItem>)}
     </TextField>
     <TextField disabled={busy||engines.isPending} select label="Model" SelectProps={{displayEmpty:true}} InputLabelProps={{shrink:true}} value={model} onChange={event=>{setSaved('');setModel(event.target.value);}}>
      <MenuItem value="">Provider Default</MenuItem>{model&&!engines.data?.find(item=>item.id===engine)?.models.some(item=>item.id===model)&&<MenuItem value={model}>{model}</MenuItem>}{engines.data?.find(item=>item.id===engine)?.models.filter(item=>item.id).map(item=><MenuItem key={item.id} value={item.id}>{item.label}</MenuItem>)}
     </TextField>
     <Button disabled={busy||!engine||!runtimeBase?.runtimeSettings||!runtimeChanged} onClick={()=>{if(!runtimeChanged)return;void act(()=>realApi.updateAgent(app.agentId,{activeEngine:engine,model:model.trim()||null,expectedRuntimeSettings:runtimeBase!.runtimeSettings}),'Model Saved',value=>{const patch={engine:value.activeEngine,model:value.model??undefined,runtimeSettings:{activeEngine:value.activeEngine,model:value.model??null,effort:value.effort??null,speed:value.speed??null}};setRuntimeBase({...runtimeBase!,...patch});commitApp(patch);},'runtime');}}>Save Model</Button></Stack></Box>
     <Box component="section" aria-label="Automatic Checks"><Stack spacing={1.5}><Typography component="h2" variant="subtitle1">Automatic Checks</Typography>
     {assistant&&<Typography variant="body2" color="text.secondary">Automatic checks inspect permitted project status at the chosen interval.</Typography>}
     <FormControlLabel control={<Switch disabled={busy} checked={automatic} onChange={(_,value)=>{setSaved('');setAutomatic(value);}}/>} label="Run Automatically"/>
     {editableInterval?<TextField disabled={busy} label="Check Every (Minutes)" type="number" value={minutes} onChange={event=>{setSaved('');setMinutes(event.target.value);}} error={!validInterval} helperText={intervalError} inputProps={{min:1,step:'any'}}/>:<Typography>{scheduleSource?.schedule?.scheduleKind==='cron'?`Cron schedule: ${scheduleSource?.schedule.expression} (${scheduleSource?.schedule.timezone})`:scheduleSource?.schedule?.scheduleKind==='once'?`Once at ${scheduleSource?.schedule.at}`:scheduleSource?.triggerKind==='filesystem'?'When files change':'When a webhook event arrives'}</Typography>}
     <Button disabled={busy||!validInterval||!scheduleChanged} onClick={saveSchedule}>Save Schedule</Button></Stack></Box>
     {!assistant&&<Button href={`/branches?branch=${encodeURIComponent(app.branchId)}&tab=workflow`}>More Options</Button>}
     {settingsStale&&<Box><Typography variant="body2">Reload replaces only the Name, Model and Automatic Checks edits in this dialog; message drafts and attachments are kept.</Typography><Button disabled={busy} onClick={()=>void retryRefresh(true)}>Reload Saved Settings</Button></Box>}
    </>}
    {assistant&&<><Box component="section" aria-label="App Settings"><Typography component="h2" variant="subtitle1">App Settings</Typography><Button href="/settings/general" onClick={event=>{if(!confirmUnsavedNavigation())event.preventDefault();}}>Appearance And Text Size</Button><Button href="/settings/activity" onClick={event=>{if(!confirmUnsavedNavigation())event.preventDefault();}}>Provider Activity</Button></Box><Box sx={{borderTop:1,borderColor:'divider',pt:2}}><Typography variant="body2" color="text.secondary">Disabling {displayName} pauses automatic checks and removes its Assistant role; its Agent and conversation history are kept.</Typography><Button color={status.data?.enabled?"error":"primary"} disabled={busy||status.isPending} onClick={()=>{if(status.data?.enabled)setDisableSettings(true);else void configure(true);}}>{status.data?.enabled?`Disable ${displayName}`:`Enable ${displayName}`}</Button></Box></>}
   </Stack></DialogContent><DialogActions><Button disabled={busy} onClick={closeSettings}>Done</Button></DialogActions>
  </Dialog>
  <ConfirmDialog open={discardSettings} title="Unsaved Settings" confirmLabel="Discard Changes" cancelLabel="Keep Editing" onCancel={()=>setDiscardSettings(false)} onConfirm={()=>{setDiscardSettings(false);setSettings(false);}}>Discard unsaved settings edits to the name, model or automatic checks? Message drafts and attachments will be kept.</ConfirmDialog>
  <ConfirmDialog open={disableSettings} title={<Box sx={{overflowWrap:"anywhere"}}>{`Disable ${displayName}`}</Box>} confirmLabel="Disable" onCancel={()=>setDisableSettings(false)} onConfirm={()=>{setDisableSettings(false);void configure(false);}}>Pause automatic checks and remove the Assistant role for {displayName}? Its Agent and conversation history will be kept.</ConfirmDialog>
 </Box></WorkspaceRefreshProvider></WorkspaceConnectionProvider></ConversationChromeContext.Provider></ThemeProvider>;
}

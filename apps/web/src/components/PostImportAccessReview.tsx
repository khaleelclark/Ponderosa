import {ConfirmDialog} from './ConfirmationDialogs';
import {Alert,Button,MenuItem,Paper,Stack,TextField,Typography} from '@mui/material';
import {useCallback,useEffect,useState} from 'react';
import {useMutation,useQuery} from '@tanstack/react-query';
import {chatBrowserOwnerId,type ImportAgentPackageResponse} from '@ponderosa/core';
import {api} from '../api';
import {requestJson} from '../api/real';
import {useUnsavedForm} from '../reloadSafety';
export type ImportSettingsResult=Pick<ImportAgentPackageResponse,'workingFilesDestination'|'workingRoots'|'accessSettingsToReview'|'liveWorkingRoots'|'reviewedMetadataApplications'|'reviewedUserDataApplications'>;
type StateChange=(key:string,dirty:boolean,busy:boolean)=>void;
type Suggestion=NonNullable<ImportAgentPackageResponse['accessSettingsToReview']>[number];

function MemoryChoice({chatId,suggestions,onStateChange,chatTitle,agentTitle}:{chatId:string;suggestions:Suggestion[];onStateChange:StateChange;chatTitle:string;agentTitle:(id:string)=>string}):JSX.Element {
 const [choice,setChoice]=useState('');
 const current=useQuery({queryKey:['local-memory-grant',chatId],queryFn:()=>requestJson<{chatId:string;readGlobal:boolean;revision:number}>(`/api/local-memory/grants/${encodeURIComponent(chatId)}`),retry:false});
 const save=useMutation({mutationFn:()=>requestJson(`/api/local-memory/grants/${encodeURIComponent(chatId)}`,{method:'PUT',body:JSON.stringify({readGlobal:choice==='allow',expectedRevision:current.data!.revision})}),onSuccess:()=>{setChoice('');void current.refetch();},onError:()=>{setChoice('');void current.refetch();}});
 useEffect(()=>{onStateChange(`memory:${chatId}`,Boolean(choice),save.isPending);return()=>onStateChange(`memory:${chatId}`,false,false);},[chatId,choice,save.isPending,onStateChange]);
 useUnsavedForm(`import-memory:${chatId}`,Boolean(choice));
 return <Paper variant="outlined" sx={{p:2}}><Stack spacing={1}>
  <Typography variant="subtitle1">Global memory · {chatTitle}</Typography>
  <Typography variant="body2">Source suggestions: {suggestions.map(item=>`${agentTitle(item.agentId)}: ${item.source.readGlobalMemory?'allow':'deny'}`).join(', ')}</Typography>
  <Typography variant="body2">Current: {current.data?(current.data.readGlobal?'allowed':'denied'):'unavailable'} · This choice affects every Agent in this Chat.</Typography>
  {(current.error||save.error)&&<Alert severity="error">{current.error?.message||save.error?.message}</Alert>}
  <TextField select label="Destination Chat global-memory read access" value={choice} disabled={save.isPending||!current.data||current.isFetching} onChange={event=>setChoice(event.target.value)}><MenuItem value="">Keep current access</MenuItem><MenuItem value="allow">Allow</MenuItem><MenuItem value="deny">Deny</MenuItem></TextField>
  <Stack direction="row" spacing={1}><Button disabled={!choice||save.isPending||!current.data||current.isFetching} onClick={()=>save.mutate()}>Apply memory choice</Button><Button disabled={save.isPending} onClick={()=>void current.refetch()}>Reload</Button></Stack>
 </Stack></Paper>;
}
function BrowserChoice({suggestion,onStateChange,title}:{suggestion:Suggestion;onStateChange:StateChange;title:string}):JSX.Element {
 const {agentId,conversationId,source}=suggestion,owner=chatBrowserOwnerId(conversationId);
 const [saved,setSaved]=useState(''),[profile,setProfile]=useState('');
 const current=useQuery({queryKey:['import-browser-access',owner,agentId],queryFn:async()=>({saved:await api.getSavedBrowserAccess(owner),preference:await api.getBrowserAgentPreference(owner,agentId)}),retry:false});
 const profiles=useQuery({queryKey:['browser-profiles',owner],queryFn:()=>api.listBrowserProfiles(owner),retry:false});
 const saveAccess=useMutation({mutationFn:()=>api.setSavedBrowserAccess(owner,agentId,saved==='allow'),onSuccess:()=>{setSaved('');void current.refetch();}});
 const saveProfile=useMutation({mutationFn:()=>api.updateBrowserAgentPreference(owner,agentId,profile==='disposable'?{mode:'disposable'}:{mode:'trusted',profileId:profile}),onSuccess:()=>{setProfile('');void current.refetch();}});
 useEffect(()=>{onStateChange(`browser:${agentId}`,Boolean(saved||profile),saveAccess.isPending||saveProfile.isPending);return()=>onStateChange(`browser:${agentId}`,false,false);},[agentId,saved,profile,saveAccess.isPending,saveProfile.isPending,onStateChange]);
 useUnsavedForm(`import-browser:${agentId}`,Boolean(saved||profile));
 return <Paper variant="outlined" sx={{p:2}}><Stack spacing={1}>
  <Typography variant="subtitle1">Browser · {title}</Typography>
  <Typography variant="body2">Source: saved access {source.savedBrowserAllowed===undefined?'unspecified':source.savedBrowserAllowed?'allowed':'denied'} · {source.browserMode??'unspecified'}{source.sourceProfileName?` · ${source.sourceProfileName} (source label)`:''}</Typography>
  <Typography variant="body2">Destination: saved access {current.data?(current.data.saved.agentIds.includes(agentId)?'allowed':'denied'):'unavailable'} · {current.data?.preference.profileName??current.data?.preference.mode??'unavailable'}</Typography>
  {(current.error||profiles.error||saveAccess.error||saveProfile.error)&&<Alert severity="error">{current.error?.message||profiles.error?.message||saveAccess.error?.message||saveProfile.error?.message}</Alert>}
  <TextField select fullWidth SelectProps={{SelectDisplayProps:{style:{whiteSpace:"normal",overflowWrap:"anywhere"}}}} label="Destination saved-browser access" value={saved} disabled={!current.data||saveAccess.isPending} onChange={event=>setSaved(event.target.value)}><MenuItem value="">Keep current access</MenuItem><MenuItem value="allow">Allow</MenuItem><MenuItem value="deny">Deny</MenuItem></TextField>
  <Button disabled={!saved||!current.data||saveAccess.isPending} onClick={()=>saveAccess.mutate()}>Apply saved-browser choice</Button>
  <TextField select fullWidth SelectProps={{SelectDisplayProps:{style:{whiteSpace:"normal",overflowWrap:"anywhere"}}}} label="Destination browser profile" value={profile} disabled={!current.data||!profiles.data||saveProfile.isPending} onChange={event=>setProfile(event.target.value)}><MenuItem value="">Keep current profile</MenuItem><MenuItem value="disposable">Disposable browser</MenuItem>{profiles.data?.map(item=><MenuItem key={item.id} value={item.id}>{item.name}</MenuItem>)}</TextField>
  <Button disabled={!profile||!current.data||saveProfile.isPending} onClick={()=>saveProfile.mutate()}>Apply profile choice</Button>
  <Button onClick={()=>{void current.refetch();void profiles.refetch();}}>Reload browser settings</Button>
 </Stack></Paper>;
}
export function PostImportAccessReview({result,onDone,projectId}:{result:ImportSettingsResult;onDone():void;projectId?:string}):JSX.Element {
 const [states,setStates]=useState<Record<string,{dirty:boolean;busy:boolean}>>({});
 const [discard,setDiscard]=useState(false);
 const onStateChange=useCallback<StateChange>((key,dirty,busy)=>setStates(previous=>({...previous,[key]:{dirty,busy}})),[]);
 const busy=Object.values(states).some(item=>item.busy),dirty=Object.values(states).some(item=>item.dirty);
 const agents=useQuery({queryKey:['import-result-agents',projectId],enabled:Boolean(projectId),queryFn:()=>api.listAgents(projectId!),retry:false});
 const chats=useQuery({queryKey:['import-result-chats',projectId],enabled:Boolean(projectId),queryFn:()=>api.listConversations(projectId!),retry:false});
 const suggestions=result.accessSettingsToReview??[];
 const agentIds=[...new Set(suggestions.map(item=>item.agentId))],chatIds=[...new Set(suggestions.map(item=>item.conversationId))];
 const mappedAgents=useQuery({queryKey:['import-result-mapped-agents',agentIds],enabled:!projectId&&agentIds.length>0,queryFn:()=>Promise.all(agentIds.map(async id=>(await api.getAgent(id,1)).agent)),retry:false});
 const mappedChats=useQuery({queryKey:['import-result-mapped-chats',chatIds],enabled:!projectId&&chatIds.length>0,queryFn:()=>Promise.all(chatIds.map(async id=>(await api.getConversation(id,1)).conversation)),retry:false});
 const agentTitle=(id:string)=>(agents.data??mappedAgents.data)?.find(item=>item.id===id)?.title??`Imported Agent ${id}`;
 const memory=new Map<string,Suggestion[]>();
 for(const item of suggestions)if(item.source.readGlobalMemory!==undefined)memory.set(item.conversationId,[...(memory.get(item.conversationId)??[]),item]);
 return <Stack spacing={2}><Stack direction="row" spacing={1} sx={{alignItems:"center",justifyContent:"space-between"}}><Typography variant="h6">Import complete</Typography><Button variant="contained" disabled={busy} onClick={()=>dirty?setDiscard(true):onDone()}>Done</Button></Stack>
  {(mappedAgents.error||mappedChats.error)&&<Alert severity="error">{mappedAgents.error?.message||mappedChats.error?.message}</Alert>}
  <NativeApplications result={result}/>
  {result.workingFilesDestination&&<Typography>Restored folder: {result.workingFilesDestination}</Typography>}
  {result.workingRoots?.map(root=><Typography key={JSON.stringify([root.ref,root.destination])}>Restored folder: {root.destination} · {root.agentIds.length} Agents</Typography>)}
  {result.liveWorkingRoots?.map(root=><Typography key={JSON.stringify([root.ref,root.path])}>Live working folder: {root.path} · {root.agentIds.map(agentTitle).join(', ')}</Typography>)}
  {[...memory].map(([chatId,items])=><MemoryChoice key={chatId} chatId={chatId} suggestions={items} chatTitle={(chats.data??mappedChats.data)?.find(item=>item.id===chatId)?.title??'Destination Chat'} agentTitle={agentTitle} onStateChange={onStateChange}/>)}
  {suggestions.filter(item=>item.source.savedBrowserAllowed!==undefined||item.source.browserMode!==undefined).map(item=><BrowserChoice key={item.agentId} suggestion={item} title={agentTitle(item.agentId)} onStateChange={onStateChange}/>)}
  <ConfirmDialog open={discard} title="Unapplied settings" confirmLabel="Discard choices" cancelLabel="Keep editing" onCancel={()=>setDiscard(false)} onConfirm={onDone}>Discard unapplied choices?</ConfirmDialog>
 </Stack>;
}

/** A partial native write is evidence to inspect, never permission to repeat it. */
export function NativeApplications({result}:{result:Pick<ImportAgentPackageResponse,'reviewedMetadataApplications'|'reviewedUserDataApplications'>}):JSX.Element {
 return <Stack spacing={1}>{[...(result.reviewedMetadataApplications??[]).map(item=>({...item,family:'File metadata'})),...(result.reviewedUserDataApplications??[]).map(item=>({...item,family:'Git and provider settings'}))].map(item=><Alert key={item.family+':'+item.ref+':'+item.path} severity={item.state==='completed'?'success':'warning'}><Typography variant="body2" sx={{overflowWrap:'anywhere'}}>{item.family}: {item.state==='completed'?'restored':item.state==='applying'?'completion unconfirmed':'incomplete'} · {item.path}</Typography>{item.error&&<><Typography variant="body2">{item.error.code??'Native application failed'}{item.error.partialStatePossible?' · partial files retained · do not repeat automatically':''}</Typography><details><summary>Observed result</summary><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(item.error.observed,null,2)}</Typography></details></>}</Alert>)}</Stack>;
}

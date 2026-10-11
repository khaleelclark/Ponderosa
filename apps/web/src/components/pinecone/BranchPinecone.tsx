import {useEffect,useRef,useState} from 'react';
import {useMutation,useQuery} from '@tanstack/react-query';
import {Alert,Avatar,Box,Button,Chip,CircularProgress,IconButton,Stack,TextField,Tooltip,Typography} from '@mui/material';
import ArrowUpwardRoundedIcon from '@mui/icons-material/ArrowUpwardRounded';
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';
import type {BranchBindings,BranchContextDto,BranchDto,InstalledBranchPackage,TriggerDefinitionDto} from '@ponderosa/core';
import type {BranchRoute} from '../../branchesRouting';
import {realApi,requestJson} from '../../api/real';
import {useWorkspaceStream} from '../../hooks/useWorkspaceStream';
import {useAgentStream} from '../../hooks/useAgentStream';
import {queryKeys} from '../../queryKeys';
import {ApiRequestError} from '../../api/types';
import {definitiveSubmissionStatus} from '../idempotentAttempt';
import {WorkspaceConnectionProvider} from '../WorkspaceConnectionContext';
import {WorkspaceConnectionNotice} from '../WorkspaceConnectionNotice';
import {BranchPackageDialog} from '../branches/BranchPackageDialog';
import {BranchNotifications} from '../branches/BranchNotifications';
import {ChatMessageBody,CommunicationDocumentCard} from '../chat/ChatMessages';
import {DecisionCard} from '../decisions/DecisionCard';
import {PineconeMark} from './PineconeMark';
import {pineconeBranchPackage} from './pineconeBranchPackage';
import {pineconeDraftKey,pineconeMessages} from './branchPineconeModel';
import {reviewedDefinition} from './responsibilities';

/** A standalone assistant surface on the existing Branch engine and communication APIs. */
export function BranchPinecone({route,onNavigate}:{route:BranchRoute;onNavigate(route:BranchRoute,replace?:boolean):boolean}):JSX.Element {
  const connection=useWorkspaceStream();
  const engines=useQuery({queryKey:['engines'],queryFn:()=>realApi.listEngines()});
  const [installation,setInstallation]=useState<InstalledBranchPackage>();
  const newInstallation=()=>setInstallation(pineconeBranchPackage());
  return <WorkspaceConnectionProvider value={connection}><Box sx={{height:'100dvh',display:'flex',flexDirection:'column',bgcolor:'background.default'}}>
    <WorkspaceConnectionNotice connection={connection}/>
    {route.branchId?<PineconeConversation key={route.branchId} branchId={route.branchId} onNavigate={onNavigate}/>:<Stack spacing={3} alignItems="center" justifyContent="center" sx={{flex:1,p:3,textAlign:'center'}}>
      <PineconeMark sx={{fontSize:72}}/><Typography variant="h3" fontWeight={700}>Meet Pinecone.</Typography>
      <Typography color="text.secondary" sx={{maxWidth:480}}>Text your assistant. Behind the conversation, a small research team looks for things that could help you.</Typography>
      <Button variant="contained" size="large" disabled={!engines.data?.length} onClick={newInstallation}>Create a new Pinecone</Button>
      {engines.error&&<Alert severity="error">Providers could not be loaded. <Button onClick={()=>void engines.refetch()}>Retry</Button></Alert>}
      <Typography variant="caption" color="text.secondary">Discovery checks every 10 minutes. You can pause them anytime.</Typography>
      <Button onClick={()=>onNavigate({tab:'workflow'})}>Open Branches</Button>
    </Stack>}
    {installation&&<BranchPackageDialog pkg={installation} branches={[]} engines={engines.data??[]} onClose={()=>setInstallation(undefined)} onInstalled={branch=>{setInstallation(undefined);return onNavigate({branchId:branch.id,tab:'pinecone'})}}/>}
  </Box></WorkspaceConnectionProvider>;
}

function PineconeConversation({branchId,onNavigate}:{branchId:string;onNavigate(route:BranchRoute):boolean}):JSX.Element {
  const branch=useQuery({queryKey:['branch',branchId],queryFn:()=>requestJson<BranchDto>(`/api/branches/${branchId}`),refetchInterval:5000});
  const bindings=useQuery({queryKey:['pinecone-bindings',branchId,branch.data?.bindingRevisionId],queryFn:()=>requestJson<BranchBindings>(`/api/branches/${branchId}/configuration`),enabled:Boolean(branch.data),retry:false});
  const id=bindings.data?.agents.spokesperson;
  const owner=useQuery({queryKey:['pinecone-owner',id],queryFn:async()=>{const detail=await realApi.getAgent(id!,1);const chat=await requestJson<BranchContextDto>(`/api/branches/contexts/${detail.agent.conversationId}`);if(chat.branchId!==branchId||chat.executionId||detail.agent.archived)throw Error('Spokesperson is not an active persistent member of this Branch');return detail.agent},enabled:Boolean(id),retry:false});
  const trigger=useQuery({queryKey:['branch-trigger',branchId],queryFn:()=>requestJson<TriggerDefinitionDto>(`/api/branches/${branchId}/trigger`),enabled:Boolean(branch.data?.triggerId),refetchInterval:5000,retry:false});
  const [controlError,setControlError]=useState(''),[controlBlocked,setControlBlocked]=useState(false),[notice,setNotice]=useState('');
  const actionLock=useRef(false),checkKey=useRef<string>();
  const refresh=()=>{void branch.refetch();void trigger.refetch()};
  const controls=useMutation({retry:false,mutationFn:async(action:'check'|'toggle')=>{
    if(actionLock.current||!branch.data||!trigger.data)throw Error('Discovery state is unavailable');
    actionLock.current=true;
    try{
      if(action==='check'){checkKey.current??=crypto.randomUUID();await requestJson(`/api/branches/${branchId}/executions`,{method:'POST',body:JSON.stringify({occurrenceKey:checkKey.current,input:'User requested a proactive check now.'})});checkKey.current=undefined;return 'Discovery check accepted.';}
      await realApi.updateTrigger(trigger.data.id,{enabled:!trigger.data.enabled,reviewedDefinition:reviewedDefinition(trigger.data)});
      return trigger.data.enabled?'Discovery paused. Already accepted work may finish. You can still text Pinecone.':'Discovery resumed.';
    }finally{actionLock.current=false;}
  },onSuccess:message=>{setNotice(message);setControlError('');refresh()},onError:error=>{setControlBlocked(true);setControlError(`${error.message} Reload discovery state before another action; an accepted check is never automatically resubmitted.`);refresh()}});
  const advanced=(tab:BranchRoute['tab']='chats')=>onNavigate({branchId,tab,chatId:owner.data?.conversationId,...(owner.data?{workspace:{kind:'agent',projectId:owner.data.projectId,agentId:owner.data.id}}:{})});
  const issue=branch.error??bindings.error??owner.error;
  return <Stack sx={{flex:1,minHeight:0}}>
    <Stack direction="row" alignItems="center" gap={1.5} sx={{px:{xs:2,sm:4},py:2,borderBottom:1,borderColor:'divider'}}>
      <Tooltip title="Branches"><IconButton aria-label="Back to Branches" onClick={()=>onNavigate({tab:'workflow'})}><ArrowBackRoundedIcon/></IconButton></Tooltip>
      <PineconeMark sx={{fontSize:36}}/><Box sx={{flex:1}}><Typography variant="h6" fontWeight={750}>Pinecone</Typography><Typography variant="caption" color="text.secondary">Your assistant, with a little help behind the scenes</Typography></Box>
      <BranchNotifications onNavigate={onNavigate}/><Button onClick={()=>advanced()}>Details</Button>
    </Stack>
    <Stack direction="row" gap={1} useFlexGap flexWrap="wrap" alignItems="center" sx={{px:{xs:2,sm:4},py:1.5}}>
      <Chip size="small" variant="outlined" label={trigger.error?'Discovery unavailable':!branch.data||trigger.isPending?'Loading discovery…':branch.data.enabled===false?'Branch paused':!branch.data.triggerId?'No discovery schedule':trigger.data?.enabled?'Discovery on':'Discovery paused'}/>
      <Button size="small" disabled={!owner.data||!trigger.data||branch.data?.enabled===false||controls.isPending||controlBlocked||(branch.data?.activeExecutions??0)>0} onClick={()=>controls.mutate('check')}>Check now</Button>
      <Button size="small" disabled={!trigger.data||controls.isPending||controlBlocked} onClick={()=>controls.mutate('toggle')}>{trigger.data?.enabled?'Pause discovery':'Resume discovery'}</Button>
      <Button size="small" onClick={()=>advanced('executions')}>Activity</Button>
    </Stack>
    {controlError&&<Alert severity="warning" action={<Button onClick={async()=>{const result=await trigger.refetch();if(!result.error){setControlBlocked(false);setControlError('')}}}>Reload</Button>}>{controlError}</Alert>}
    {notice&&<Alert severity="info" onClose={()=>setNotice('')}>{notice}</Alert>}
    {issue?<Alert severity="error">{issue.message} <Button onClick={()=>{refresh();void bindings.refetch();void owner.refetch()}}>Retry</Button><Button onClick={()=>advanced('workflow')}>Open workflow</Button></Alert>:!id&&bindings.isSuccess?<Alert severity="info">This Branch has no Pinecone spokesperson binding. Create a new Pinecone installation or configure its organization in Branches.</Alert>:!owner.data?<Box sx={{p:3}}><CircularProgress size={22}/> Loading Pinecone…</Box>:<TextingChat key={id} branchId={branchId} agentId={id!} onAdvanced={()=>advanced()}/>}
  </Stack>;
}

function TextingChat({branchId,agentId,onAdvanced}:{branchId:string;agentId:string;onAdvanced():void}):JSX.Element {
  const key=pineconeDraftKey(branchId,agentId);
  const [draft,setDraft]=useState(()=>{try{return localStorage.getItem(key)??''}catch{return ''}});
  const attempt=useRef<{text:string;key:string}>(undefined);
  if(attempt.current===undefined){try{const stored=JSON.parse(localStorage.getItem(key+':pending')??'null');if(stored&&typeof stored.text==='string'&&typeof stored.key==='string')attempt.current=stored}catch{}}
  const [sendError,setSendError]=useState(()=>attempt.current?'An earlier message has uncertain delivery. Retry the same message to recover its receipt.':''),[accepted,setAccepted]=useState('');
  const busy=useRef(false),live=useRef(true),bottom=useRef<HTMLDivElement>(null);
  useEffect(()=>{live.current=true;return()=>{live.current=false}},[]);
  useEffect(()=>{try{draft?localStorage.setItem(key,draft):localStorage.removeItem(key)}catch{}},[key,draft]);
  const stream=useAgentStream(agentId);
  const detail=useQuery({queryKey:queryKeys.agents.detail(agentId,60),queryFn:()=>realApi.getAgent(agentId,60),refetchInterval:stream.connected?false:5000,retry:false});
  const messages=pineconeMessages(detail.data?.messages??[],agentId);
  useEffect(()=>{bottom.current?.scrollIntoView({block:'end'})},[messages.at(-1)?.id]);
  const send=useMutation({retry:false,mutationFn:async()=>{
    if(busy.current)throw Error('A message is already being sent');busy.current=true;
    const prepared=attempt.current??{text:draft.trim(),key:crypto.randomUUID()};attempt.current=prepared;
    try{localStorage.setItem(key+':pending',JSON.stringify(prepared))}catch{}
    try{return await realApi.sendMessage(agentId,{text:prepared.text,idempotencyKey:prepared.key,activeRunDelivery:'queue'})}finally{busy.current=false;}
  },onSuccess:result=>{try{localStorage.removeItem(key+':pending')}catch{}if(!live.current)return;attempt.current=undefined;setDraft('');setSendError('');setAccepted(result.queued?'Message queued for Pinecone.':'Message delivered to Pinecone.');void detail.refetch()},onError:error=>{const definitive=error instanceof ApiRequestError&&definitiveSubmissionStatus(error.status,error.message);if(definitive){attempt.current=undefined;try{localStorage.removeItem(key+':pending')}catch{}}if(live.current)setSendError(`${error.message} Your draft is retained.${definitive?' Correct the draft or retry.':' Retry sends the exact same message with the same delivery identity.'}`)}});
  const working=stream.running||(detail.data?.runs.some(run=>run.status==='running')??false);
  const submit=()=>{if((draft.trim()||attempt.current)&&!send.isPending)send.mutate()};
  return <>
    <Box component="section" aria-label="Conversation with Pinecone" sx={{flex:1,minHeight:0,overflowY:'auto',px:{xs:2,sm:4},pb:2}}>
      <Stack spacing={2} sx={{maxWidth:780,mx:'auto',pt:2}}>
        {detail.error&&<Alert severity="warning">Conversation could not refresh. <Button onClick={()=>void detail.refetch()}>Retry</Button></Alert>}
        {detail.data?.history?.hasMore&&<Button onClick={onAdvanced}>Read older conversation</Button>}
        {detail.isSuccess&&!messages.length&&<Box sx={{py:6,textAlign:'center'}}><Avatar sx={{mx:'auto',mb:2,width:56,height:56,bgcolor:'primary.main'}}>P</Avatar><Typography variant="h5">What’s on your mind?</Typography><Typography color="text.secondary" sx={{mt:1}}>Tell me what you’re working on, or what you’d like me to keep an eye out for.</Typography></Box>}
        {messages.map(message=><Box component="article" aria-label={message.role==='user'?'Your message':'Pinecone message'} key={message.id} sx={{alignSelf:message.role==='user'?'flex-end':'flex-start',maxWidth:'90%',px:2.25,py:1.5,borderRadius:3,borderBottomRightRadius:message.role==='user'?6:24,borderBottomLeftRadius:message.role==='assistant'?6:24,bgcolor:message.role==='user'?'primary.main':'action.hover',color:message.role==='user'?'primary.contrastText':'text.primary',overflowWrap:'anywhere'}}>
          {message.document?<CommunicationDocumentCard document={message.document}/>:<ChatMessageBody text={message.text} citations={message.citations} agentMentions={message.agentMentions} compactMarkdown/>}
          {!!message.attachments?.length&&<Button color="inherit" size="small" onClick={onAdvanced}>View {message.attachments.length} attachments</Button>}
          <Typography variant="caption" sx={{display:'block',opacity:.65,mt:.75}}>{new Date(message.createdAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}</Typography>
        </Box>)}
        {detail.data?.decisionEvents?.filter(event=>event.decision.status==='pending').map(event=><DecisionCard key={event.decision.id} decision={event.decision} onResolved={()=>void detail.refetch()}/>)}
        {working&&<Typography role="status" color="text.secondary" variant="body2">Pinecone is working…</Typography>}
        <div ref={bottom}/>
      </Stack>
    </Box>
    <Box component="form" onSubmit={event=>{event.preventDefault();submit()}} sx={{px:{xs:2,sm:4},pb:'max(16px, env(safe-area-inset-bottom))',pt:1}}>
      <Stack spacing={1} sx={{maxWidth:780,mx:'auto'}}>
        {sendError&&<Alert severity="warning" action={<Button disabled={send.isPending} onClick={submit}>Retry same message</Button>}>{sendError}</Alert>}
        {accepted&&<Typography variant="caption" role="status" color="text.secondary">{accepted}</Typography>}
        <Stack direction="row" alignItems="flex-end" gap={1} sx={{border:1,borderColor:'divider',borderRadius:4,p:1,bgcolor:'background.paper'}}>
          <TextField autoComplete="off" multiline maxRows={6} placeholder="Text Pinecone…" aria-label="Message Pinecone" value={draft} disabled={send.isPending||Boolean(sendError&&attempt.current)} onChange={e=>{setDraft(e.target.value);setAccepted('')}} variant="standard" fullWidth InputProps={{disableUnderline:true}} sx={{px:1,py:.5}} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();submit()}}}/>
          <IconButton type="submit" aria-label="Send message to Pinecone" disabled={!draft.trim()||send.isPending||Boolean(sendError)} sx={{bgcolor:'primary.main',color:'primary.contrastText','&:hover':{bgcolor:'primary.dark'}}}>{send.isPending?<CircularProgress size={20}/>:<ArrowUpwardRoundedIcon/>}</IconButton>
        </Stack>
        <Typography variant="caption" color="text.secondary" textAlign="center">Discovery continues in the background. <Button size="small" onClick={onAdvanced}>Files, team & more</Button></Typography>
      </Stack>
    </Box>
  </>;
}

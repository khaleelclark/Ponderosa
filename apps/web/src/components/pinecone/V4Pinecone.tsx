import {createClientId} from '../../clientId';
import {useEffect,useRef,useState} from 'react';
import {useMutation,useQuery} from '@tanstack/react-query';
import {Alert,Box,Button,CircularProgress,IconButton,Menu,MenuItem,Stack,TextField,Tooltip,Typography,useMediaQuery} from '@mui/material';
import ArrowUpwardRoundedIcon from '@mui/icons-material/ArrowUpwardRounded';
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';
import MoreVertRoundedIcon from '@mui/icons-material/MoreVertRounded';
import {MessageDeliveryStatus} from '../MessageDeliveryStatus';
import type {BranchBindings,BranchContextDto,BranchDto,TriggerDefinitionDto} from '@ponderosa/core';
import type {BranchRoute} from '../../branchesRouting';
import {realApi,requestJson} from '../../api/real';
import {useWorkspaceStream} from '../../hooks/useWorkspaceStream';
import {useAgentStream} from '../../hooks/useAgentStream';
import {queryKeys} from '../../queryKeys';
import {ApiRequestError} from '../../api/types';
import {definitiveSubmissionStatus} from '../idempotentAttempt';
import {WorkspaceConnectionProvider} from '../WorkspaceConnectionContext';
import {WorkspaceConnectionNotice} from '../WorkspaceConnectionNotice';
import {ChatMessageBody,CommunicationDocumentCard} from '../chat/ChatMessages';
import {DecisionCard} from '../decisions/DecisionCard';
import {PineconeMark} from './PineconeMark';
import {pineconeDraftKey,pineconeMessages} from './branchPineconeModel';
import {reviewedDefinition} from './responsibilities';

/** V4's original communication surface, refined without changing its Branch or Agents. */
export function V4Pinecone({route,onNavigate}:{route:BranchRoute;onNavigate(route:BranchRoute,replace?:boolean):boolean}):JSX.Element {
  const connection=useWorkspaceStream();
  return <WorkspaceConnectionProvider value={connection}><Box sx={{height:'var(--ponderosa-app-viewport-block-size, 100dvh)',minHeight:0,overflow:'hidden',display:'flex',flexDirection:'column',bgcolor:'background.default',pt:'env(safe-area-inset-top)',pl:'env(safe-area-inset-left)',pr:'env(safe-area-inset-right)'}}>
    <WorkspaceConnectionNotice connection={connection}/>
    {route.branchId&&<PineconeConversation key={route.branchId} branchId={route.branchId} onNavigate={onNavigate}/>}
  </Box></WorkspaceConnectionProvider>;
}

function PineconeConversation({branchId,onNavigate}:{branchId:string;onNavigate(route:BranchRoute):boolean}):JSX.Element {
  const [menuAnchor,setMenuAnchor]=useState<HTMLElement|null>(null);
  const closeMenu=()=>setMenuAnchor(null);
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
      if(action==='check'){checkKey.current??=createClientId();await requestJson(`/api/branches/${branchId}/executions`,{method:'POST',body:JSON.stringify({occurrenceKey:checkKey.current,input:'User requested a proactive check now.'})});checkKey.current=undefined;return 'Discovery check accepted.';}
      await realApi.updateTrigger(trigger.data.id,{enabled:!trigger.data.enabled,reviewedDefinition:reviewedDefinition(trigger.data)});
      return trigger.data.enabled?'Discovery paused. Already accepted work may finish. You can still text Pinecone.':'Discovery resumed.';
    }finally{actionLock.current=false;}
  },onSuccess:message=>{setNotice(message);setControlError('');refresh()},onError:error=>{setControlBlocked(true);setControlError(`${error.message} Reload discovery state before another action; an accepted check is never automatically resubmitted.`);refresh()}});
  const advanced=(tab:BranchRoute['tab']='chats')=>onNavigate({branchId,tab,chatId:owner.data?.conversationId,...(owner.data?{workspace:{kind:'agent',projectId:owner.data.projectId,agentId:owner.data.id}}:{})});
  const issue=branch.error??bindings.error??owner.error;
  return <Stack sx={{flex:1,minHeight:0}}>
    <Stack component="header" direction="row" alignItems="center" gap={1} sx={{flexShrink:0,px:{xs:1,sm:2},minHeight:56,borderBottom:1,borderColor:'divider'}}>
      <Tooltip title="Branches"><IconButton aria-label="Back to Branches" onClick={()=>onNavigate({tab:'workflow'})} sx={{width:44,height:44}}><ArrowBackRoundedIcon/></IconButton></Tooltip>
      <PineconeMark sx={{fontSize:24,flexShrink:0}}/><Typography variant="h6" fontWeight={700} noWrap sx={{fontSize:18,flex:1,minWidth:0}}>Pinecone</Typography>
      <IconButton aria-label="Conversation options" aria-haspopup="menu" aria-expanded={Boolean(menuAnchor)} onClick={event=>setMenuAnchor(event.currentTarget)} sx={{width:44,height:44}}><MoreVertRoundedIcon/></IconButton>
      <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={closeMenu}>
        <MenuItem onClick={()=>{closeMenu();advanced()}}>Files &amp; team</MenuItem>
        <MenuItem onClick={()=>{closeMenu();advanced('executions')}}>Research history</MenuItem>
        <MenuItem onClick={()=>{closeMenu();onNavigate({branchId,tab:'chats',global:'notifications'})}}>Notifications</MenuItem>
        <MenuItem disabled>{trigger.error?'Discovery unavailable':trigger.isPending?'Loading discovery…':trigger.data?.enabled?'Discovery on':'Discovery paused'}</MenuItem>
        <MenuItem disabled={!owner.data||!trigger.data||branch.data?.enabled===false||controls.isPending||controlBlocked||(branch.data?.activeExecutions??0)>0} onClick={()=>{closeMenu();controls.mutate('check')}}>Check now</MenuItem>
        <MenuItem disabled={!trigger.data||controls.isPending||controlBlocked} onClick={()=>{closeMenu();controls.mutate('toggle')}}>{trigger.data?.enabled?'Pause discovery':'Resume discovery'}</MenuItem>
      </Menu>
    </Stack>
    {controlError&&<Alert severity="warning" action={<Button onClick={async()=>{const result=await trigger.refetch();if(!result.error){setControlBlocked(false);setControlError('')}}}>Reload</Button>}>{controlError}</Alert>}
    {notice&&<Alert severity="info" onClose={()=>setNotice('')}>{notice}</Alert>}
    {issue?<Alert severity="error">{issue.message} <Button onClick={()=>{refresh();void bindings.refetch();void owner.refetch()}}>Retry</Button><Button onClick={()=>advanced('workflow')}>Open workflow</Button></Alert>:!id&&bindings.isSuccess?<Alert severity="info">This Branch has no Pinecone spokesperson binding. Create a new Pinecone installation or configure its organization in Branches.</Alert>:!owner.data?<Box sx={{p:3}}><CircularProgress size={22}/> Loading Pinecone…</Box>:<TextingChat key={id} branchId={branchId} agentId={id!} onAdvanced={()=>advanced()}/>}
  </Stack>;
}

function TextingChat({branchId,agentId,onAdvanced}:{branchId:string;agentId:string;onAdvanced():void}):JSX.Element {
  const compact=useMediaQuery('(max-width:599.95px), (max-height:500px)');
  const key=pineconeDraftKey(branchId,agentId);
  const [draft,setDraft]=useState(()=>{try{return localStorage.getItem(key)??''}catch{return ''}});
  const attempt=useRef<{text:string;key:string}>(undefined);
  if(attempt.current===undefined){try{const stored=JSON.parse(localStorage.getItem(key+':pending')??'null');if(stored&&typeof stored.text==='string'&&typeof stored.key==='string')attempt.current=stored}catch{}}
  const [sendError,setSendError]=useState(()=>attempt.current?'An earlier message has uncertain delivery. Retry the same message to recover its receipt.':''),[accepted,setAccepted]=useState('');
  const busy=useRef(false),live=useRef(true),conversation=useRef<HTMLElement>(null),followLatest=useRef(true);
  useEffect(()=>{live.current=true;return()=>{live.current=false}},[]);
  useEffect(()=>{try{draft?localStorage.setItem(key,draft):localStorage.removeItem(key)}catch{}},[key,draft]);
  const stream=useAgentStream(agentId);
  const detail=useQuery({queryKey:queryKeys.agents.detail(agentId,60),queryFn:()=>realApi.getAgent(agentId,60),refetchInterval:5000,retry:false});
  const messages=pineconeMessages(detail.data?.messages??[],agentId);
  useEffect(()=>{const element=conversation.current;if(element&&followLatest.current)element.scrollTop=element.scrollHeight},[messages.at(-1)?.id]);
  useEffect(()=>{const element=conversation.current;if(!element)return;const observer=new ResizeObserver(()=>{if(followLatest.current)element.scrollTop=element.scrollHeight});observer.observe(element);return()=>observer.disconnect()},[]);
  const latestReplyId=[...messages].reverse().find(message=>message.role==='assistant')?.id;
  useEffect(()=>{if(latestReplyId)setAccepted('')},[latestReplyId]);
  const send=useMutation({retry:false,mutationFn:async()=>{
    if(busy.current)throw Error('A message is already being sent');busy.current=true;
    try{
      const prepared=attempt.current??{text:draft.trim(),key:createClientId()};attempt.current=prepared;
      try{localStorage.setItem(key+':pending',JSON.stringify(prepared))}catch{}
      return await realApi.sendMessage(agentId,{text:prepared.text,idempotencyKey:prepared.key,activeRunDelivery:'queue'});
    }finally{busy.current=false;}
  },onSuccess:result=>{try{localStorage.removeItem(key+':pending')}catch{}if(!live.current)return;attempt.current=undefined;setDraft('');setSendError('');setAccepted(result.queued?'Message saved. Waiting for Pinecone…':'Message saved.');void detail.refetch()},onError:error=>{const definitive=error instanceof ApiRequestError&&definitiveSubmissionStatus(error.status,error.message);if(definitive){attempt.current=undefined;try{localStorage.removeItem(key+':pending')}catch{}}if(live.current)setSendError(`${error.message} Your draft is retained.${definitive?' Correct the draft or retry.':' Retry sends the exact same message with the same delivery identity.'}`)}});
  const working=stream.running||(detail.data?.runs.some(run=>run.status==='running')??false);
  const submit=()=>{if((draft.trim()||attempt.current)&&!send.isPending){followLatest.current=true;send.mutate()}};
  return <>
    <Box component="section" ref={conversation} aria-label="Conversation with Pinecone" tabIndex={0} onPointerDown={()=>{followLatest.current=false}} onWheel={event=>{if(event.deltaY<0)followLatest.current=false}} onScroll={event=>{const element=event.currentTarget;followLatest.current=element.scrollHeight-element.scrollTop-element.clientHeight<48}} sx={{flex:1,minHeight:0,overflowY:'auto',overscrollBehavior:'contain',px:{xs:1.5,sm:3},pb:1.5}}>
      <Stack spacing={2} sx={{maxWidth:780,mx:'auto',pt:2}}>
        {detail.error&&<Alert severity="warning">Conversation could not refresh. <Button onClick={()=>void detail.refetch()}>Retry</Button></Alert>}
        {detail.data?.history?.hasMore&&<Button onClick={onAdvanced}>Read older conversation</Button>}
        {detail.isSuccess&&!messages.length&&<Typography color="text.secondary" variant="body2" sx={{py:2}}>Your messages with Pinecone will appear here.</Typography>}
        {messages.map(message=><Box component="article" aria-label={message.role==='user'?'Your message':'Pinecone message'} key={message.id} sx={{alignSelf:message.role==='user'?'flex-end':'flex-start',minWidth:0,maxWidth:{xs:'94%',sm:'90%'},px:{xs:1.5,sm:2.25},py:1.25,borderRadius:3,borderBottomRightRadius:message.role==='user'?6:24,borderBottomLeftRadius:message.role==='assistant'?6:24,bgcolor:message.role==='user'?'primary.main':'action.hover',color:message.role==='user'?'primary.contrastText':'text.primary',overflowWrap:'anywhere'}}>
          {message.document?<CommunicationDocumentCard document={message.document}/>:<ChatMessageBody text={message.text} citations={message.citations} agentMentions={message.agentMentions} compactMarkdown/>}
          {!!message.attachments?.length&&<Button color="inherit" size="small" onClick={onAdvanced}>View {message.attachments.length} attachments</Button>}
          <Stack direction="row" alignItems="center" gap={.5} sx={{mt:.5}}><Typography variant="caption" sx={{opacity:.65}}>{new Date(message.createdAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}</Typography>{message.role==='user'&&<MessageDeliveryStatus receipts={message.deliveryReceipts} recipientName={()=>'Pinecone'} compact/>}</Stack>
          {message.role==='user'&&message.deliveryReceipts?.some(receipt=>['failed','undelivered','retry_exhausted','run_unconfirmed'].includes(receipt.state))&&<Typography variant="caption" role="alert" sx={{display:'block',mt:.5}}>Pinecone couldn’t reply. Your message is saved. <Button size="small" color="inherit" onClick={onAdvanced}>Details</Button></Typography>}
        </Box>)}
        {detail.data?.decisionEvents?.filter(event=>event.decision.status==='pending').map(event=><DecisionCard key={event.decision.id} decision={event.decision} onResolved={()=>void detail.refetch()}/>)}
        {working&&<Typography role="status" color="text.secondary" variant="body2">Pinecone is working…</Typography>}
      </Stack>
    </Box>
    <Box component="form" onSubmit={event=>{event.preventDefault();submit()}} sx={{flexShrink:0,px:{xs:1.5,sm:3},pb:'max(8px, env(safe-area-inset-bottom))',pt:1,bgcolor:'background.default'}}>
      <Stack spacing={1} sx={{maxWidth:780,mx:'auto'}}>
        {sendError&&<Alert severity="warning" action={<Button disabled={send.isPending} onClick={submit}>Retry same message</Button>}>{sendError}</Alert>}
        {accepted&&<Typography variant="caption" role="status" color="text.secondary">{accepted}</Typography>}
        <Stack direction="row" alignItems="flex-end" gap={1} sx={{border:1,borderColor:'divider',borderRadius:4,p:.5,bgcolor:'background.paper'}}>
          <TextField autoComplete="off" multiline maxRows={compact?3:6} placeholder="Text Pinecone…" inputProps={{'aria-label':'Message Pinecone'}} value={draft} disabled={send.isPending||Boolean(sendError&&attempt.current)} onChange={e=>{setDraft(e.target.value);setAccepted('')}} variant="standard" fullWidth InputProps={{disableUnderline:true}} sx={{px:1,py:.5}} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();submit()}}}/>
          <IconButton type="submit" aria-label="Send message to Pinecone" disabled={!draft.trim()||send.isPending||Boolean(sendError)} sx={{width:44,height:44,bgcolor:'primary.main',color:'primary.contrastText','&:hover':{bgcolor:'primary.dark'}}}>{send.isPending?<CircularProgress size={20}/>:<ArrowUpwardRoundedIcon/>}</IconButton>
        </Stack>
      </Stack>
    </Box>
  </>;
}

import {createClientId} from '../../clientId';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {useMutation,useQuery} from '@tanstack/react-query';
import {Alert,Box,Button,CircularProgress,Dialog,DialogTitle,DialogContent,DialogActions,IconButton,Menu,MenuItem,Stack,TextField,Tooltip,Typography,useMediaQuery} from '@mui/material';
import ArrowUpwardRoundedIcon from '@mui/icons-material/ArrowUpwardRounded';
import CallOutlinedIcon from '@mui/icons-material/CallOutlined';
import MoreVertRoundedIcon from '@mui/icons-material/MoreVertRounded';
import {MessageDeliveryStatus} from '../MessageDeliveryStatus';
import type {AgentDetailDto,BranchExecutionDto,BranchBindings,BranchContextDto,BranchDto,TriggerDefinitionDto} from '@ponderosa/core';
import type {BranchRoute} from '../../branchesRouting';
import type {ColorMode} from '../../theme';
import {realApi,requestJson} from '../../api/real';
import {useWorkspaceStream} from '../../hooks/useWorkspaceStream';
import {useAgentStream} from '../../hooks/useAgentStream';
import {queryKeys} from '../../queryKeys';
import {ApiRequestError} from '../../api/types';
import {definitiveSubmissionStatus} from '../idempotentAttempt';
import {WorkspaceConnectionProvider} from '../WorkspaceConnectionContext';
import {ProjectMemoryPanel} from '../ProjectMemoryPanel';
import {VoiceConversation} from '../speech/VoiceConversation';
import {ChatMessageBody,CommunicationDocumentCard} from '../chat/ChatMessages';
import {DecisionCard} from '../decisions/DecisionCard';
import {PineconeMark} from './PineconeMark';
import {checkStatus,safeMessageRetry,mergePineconeHistory,pineconeDraftKey,pineconeMessages} from './branchPineconeModel';
import {reviewedDefinition} from './responsibilities';

/** V4's original communication surface, refined without changing its Branch or Agents. */
export function V4Pinecone({route,onNavigate,colorMode,onToggleColorMode}:{route:BranchRoute;onNavigate(route:BranchRoute,replace?:boolean):boolean;colorMode:ColorMode;onToggleColorMode():void}):JSX.Element {
  const connection=useWorkspaceStream();
  return <WorkspaceConnectionProvider value={connection}><Box sx={{height:'var(--ponderosa-app-viewport-block-size, 100dvh)',minHeight:0,overflow:'hidden',display:'flex',flexDirection:'column',bgcolor:'background.default',pt:'env(safe-area-inset-top)',pl:'env(safe-area-inset-left)',pr:'env(safe-area-inset-right)'}}>
    {(connection.status==='stale'||connection.status==='unavailable'||connection.prolongedDisconnect)&&<Box role="status" sx={{px:2,py:.5,fontSize:12,color:'text.secondary'}}>{connection.prolongedDisconnect?'Connection unavailable. Your saved conversation stays here.':'Reconnecting…'} <Button size="small" disabled={connection.retrying} onClick={()=>connection.retry?.()}>Reconnect</Button></Box>}
    {route.branchId&&<PineconeConversation key={route.branchId} branchId={route.branchId} onNavigate={onNavigate} colorMode={colorMode} onToggleColorMode={onToggleColorMode}/>}
  </Box></WorkspaceConnectionProvider>;
}

function PineconeConversation({branchId,onNavigate,colorMode,onToggleColorMode}:{branchId:string;onNavigate(route:BranchRoute):boolean;colorMode:ColorMode;onToggleColorMode():void}):JSX.Element {
  const phone=useMediaQuery('(max-width:599.95px)');
  const [menuAnchor,setMenuAnchor]=useState<HTMLElement|null>(null);
  const [callOpen,setCallOpen]=useState(false);
  const [memoryOpen,setMemoryOpen]=useState(false),[checksOpen,setChecksOpen]=useState(false);
  const closeMenu=()=>setMenuAnchor(null);
  const branch=useQuery({queryKey:['branch',branchId],queryFn:()=>requestJson<BranchDto>(`/api/branches/${branchId}`),refetchInterval:5000});
  const bindings=useQuery({queryKey:['pinecone-bindings',branchId,branch.data?.bindingRevisionId],queryFn:()=>requestJson<BranchBindings>(`/api/branches/${branchId}/configuration`),enabled:Boolean(branch.data),retry:false});
  const id=bindings.data?.agents.spokesperson;
  const owner=useQuery({queryKey:['pinecone-owner',id],queryFn:async()=>{const detail=await realApi.getAgent(id!,1);const chat=await requestJson<BranchContextDto>(`/api/branches/contexts/${detail.agent.conversationId}`);if(chat.branchId!==branchId||chat.executionId||detail.agent.archived)throw Error('Spokesperson is not an active persistent member of this Branch');return detail.agent},enabled:Boolean(id),retry:false});
  const trigger=useQuery({queryKey:['branch-trigger',branchId],queryFn:()=>requestJson<TriggerDefinitionDto>(`/api/branches/${branchId}/trigger`),enabled:Boolean(branch.data?.triggerId),refetchInterval:5000,retry:false});
  const checks=useQuery({queryKey:['pinecone-checks',branchId],queryFn:()=>requestJson<BranchExecutionDto[]>(`/api/branches/${branchId}/executions?limit=100`),refetchInterval:15000,retry:false});
  const [controlError,setControlError]=useState(''),[controlBlocked,setControlBlocked]=useState(false),[notice,setNotice]=useState('');
  const actionLock=useRef(false),checkKey=useRef<string>();
  const refresh=()=>{void branch.refetch();void trigger.refetch()};
  const controls=useMutation({retry:false,mutationFn:async(action:'check'|'toggle')=>{
    if(actionLock.current||!branch.data||!trigger.data)throw Error('Discovery state is unavailable');
    actionLock.current=true;
    try{
      if(action==='check'){checkKey.current??=createClientId();await requestJson(`/api/branches/${branchId}/executions`,{method:'POST',body:JSON.stringify({occurrenceKey:checkKey.current,input:'User requested a proactive check now.'})});checkKey.current=undefined;return 'Discovery check accepted.';}
      await realApi.updateTrigger(trigger.data.id,{enabled:!trigger.data.enabled,reviewedDefinition:reviewedDefinition(trigger.data)});
      return trigger.data.enabled?'Check-ins paused. Already accepted work may finish. You can still text Pinecone.':'Discovery resumed.';
    }finally{actionLock.current=false;}
  },onSuccess:message=>{setNotice(message);setControlError('');refresh()},onError:error=>{setControlBlocked(true);setControlError(`${error.message} Reload discovery state before another action; an accepted check is never automatically resubmitted.`);refresh()}});
  const advanced=(tab:BranchRoute['tab']='chats')=>onNavigate({branchId,tab,chatId:owner.data?.conversationId,...(owner.data?{workspace:{kind:'agent',projectId:owner.data.projectId,agentId:owner.data.id}}:{})});
  const issue=(!branch.data&&branch.error)||(!bindings.data&&bindings.error)||(!owner.data&&owner.error);
  const stale=!issue&&(branch.error||bindings.error||owner.error);
  return <Stack sx={{flex:1,minHeight:0}}>
    <Stack component="header" direction="row" alignItems="center" gap={1} sx={{flexShrink:0,px:{xs:1,sm:2},minHeight:56,borderBottom:1,borderColor:'divider'}}>
      <PineconeMark sx={{fontSize:24,flexShrink:0}}/><Box sx={{flex:1,minWidth:0}}><Typography variant="h6" fontWeight={700} noWrap sx={{fontSize:18}}>Pinecone</Typography><Typography variant="caption" color="text.secondary">{checks.data?checkStatus(checks.data,trigger.data?.enabled):checks.error?'Check-in status unavailable':'Loading check-ins…'}</Typography></Box>
      <Tooltip title="Call Pinecone"><span><IconButton aria-label="Call Pinecone" disabled={!owner.data} onClick={()=>setCallOpen(true)} sx={{width:44,height:44}}><CallOutlinedIcon/></IconButton></span></Tooltip>
      <IconButton aria-label="Conversation options" aria-haspopup="menu" aria-expanded={Boolean(menuAnchor)} onClick={event=>setMenuAnchor(event.currentTarget)} sx={{width:44,height:44}}><MoreVertRoundedIcon/></IconButton>
      <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={closeMenu}>
        <MenuItem disabled={!owner.data} onClick={()=>{closeMenu();setMemoryOpen(true)}}>What Pinecone remembers</MenuItem>
        <MenuItem onClick={()=>{closeMenu();setChecksOpen(true)}}>Recent checks</MenuItem>
        <MenuItem onClick={()=>{closeMenu();onToggleColorMode()}}>{colorMode==='dark'?'Use light mode':'Use dark mode'}</MenuItem>
        <MenuItem disabled>{trigger.error?'Discovery unavailable':trigger.isPending?'Loading discovery…':trigger.data?.enabled?'Check-ins on':'Check-ins paused'}</MenuItem>
        <MenuItem disabled={!owner.data||!trigger.data||branch.data?.enabled===false||controls.isPending||controlBlocked||(branch.data?.activeExecutions??0)>0} onClick={()=>{closeMenu();controls.mutate('check')}}>Check now</MenuItem>
        <MenuItem disabled={!trigger.data||controls.isPending||controlBlocked} onClick={()=>{closeMenu();controls.mutate('toggle')}}>{trigger.data?.enabled?'Pause check-ins':'Resume check-ins'}</MenuItem>
      </Menu>
    </Stack>
    {controlError&&<Alert severity="warning" action={<Button onClick={async()=>{const result=await trigger.refetch();if(!result.error){setControlBlocked(false);setControlError('')}}}>Reload</Button>}>{controlError}</Alert>}
    {notice&&<Alert severity="info" onClose={()=>setNotice('')}>{notice}</Alert>}
    {stale&&<Alert severity="warning" action={<Button onClick={()=>{refresh();void bindings.refetch();void owner.refetch()}}>Retry</Button>}>Pinecone couldn’t refresh. Showing your last loaded conversation.</Alert>}
    {issue?<Alert severity="error">Pinecone couldn’t load your conversation. Please try again. <Button onClick={()=>{refresh();void bindings.refetch();void owner.refetch()}}>Retry</Button></Alert>:!id&&bindings.isSuccess?<Alert severity="info">Pinecone isn’t connected to this conversation yet. <Button onClick={()=>{refresh();void bindings.refetch()}}>Retry</Button></Alert>:!owner.data?<Box role="status" sx={{p:3}}><CircularProgress size={22}/> Loading your conversation…</Box>:<TextingChat key={id} branchId={branchId} agentId={id!} onAdvanced={()=>advanced()}/>}
    <Dialog fullScreen={phone} open={memoryOpen} onClose={()=>setMemoryOpen(false)} fullWidth maxWidth="sm" aria-label="What Pinecone remembers"><DialogTitle>What Pinecone remembers</DialogTitle><DialogContent>{owner.data&&<ProjectMemoryPanel projectId={owner.data.projectId} projectLabel="Pinecone" pinecone/>}</DialogContent><DialogActions><Button onClick={()=>setMemoryOpen(false)}>Done</Button></DialogActions></Dialog>
    <Dialog fullScreen={phone} open={checksOpen} onClose={()=>setChecksOpen(false)} fullWidth maxWidth="sm"><DialogTitle>Recent checks</DialogTitle><DialogContent><Stack spacing={2}>{checks.error&&<Typography>Check-ins couldn’t load. <Button onClick={()=>void checks.refetch()}>Retry</Button></Typography>}{checks.isPending&&<Typography role="status">Loading check-ins…</Typography>}{checks.data?.filter(e=>e.admissionSource==='automatic').map(e=><Box key={e.id}><Typography>{new Date(e.createdAt).toLocaleString()}</Typography><Typography variant="body2">{e.state==='completed'?'Check finished':e.state==='waiting'?'Still waiting for an assistant result':e.state==='failed'?'Didn’t finish':e.state==='running'||e.state==='queued'?'Still working':'Check ended'}</Typography></Box>)}</Stack></DialogContent><DialogActions><Button onClick={()=>setChecksOpen(false)}>Done</Button></DialogActions></Dialog>
    {owner.data&&<VoiceConversation projectId={owner.data.projectId} conversationId={owner.data.conversationId} agents={[{...owner.data,title:'Pinecone'}]} selectedAgentId={owner.data.id} lockAgent pinecone open={callOpen} onClose={()=>setCallOpen(false)}/>}
  </Stack>;
}

function TextingChat({branchId,agentId,onAdvanced}:{branchId:string;agentId:string;onAdvanced():void}):JSX.Element {
  const compact=useMediaQuery('(max-width:599.95px), (max-height:500px)');
  const finePointer=useMediaQuery('(pointer:fine)');
  const [newMessage,setNewMessage]=useState(false);
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
  const [olderPages,setOlderPages]=useState<AgentDetailDto[]>([]),[historyError,setHistoryError]=useState(''),[loadingHistory,setLoadingHistory]=useState(false);
  const historyBusy=useRef(false),scrollAnchor=useRef<{height:number;top:number}>();
  const oldestPage=olderPages.at(-1)??detail.data;
  const messages=pineconeMessages(mergePineconeHistory([...olderPages].reverse().map(page=>page.messages).concat([detail.data?.messages??[]])),agentId);
  const loadOlder=async()=>{
    const cursor=oldestPage?.history?.cursor;
    if(historyBusy.current||!oldestPage?.history?.hasMore||!cursor)return;
    historyBusy.current=true;setLoadingHistory(true);setHistoryError('');
    try{
      const page=await realApi.getAgent(agentId,60,cursor);
      if(!live.current)return;
      const element=conversation.current;
      if(element){scrollAnchor.current={height:element.scrollHeight,top:element.scrollTop};followLatest.current=false;}
      setOlderPages(pages=>[...pages,page]);
    }catch{if(live.current)setHistoryError('Earlier messages couldn’t load. Try again.');}
    finally{historyBusy.current=false;if(live.current)setLoadingHistory(false);}
  };
  useLayoutEffect(()=>{const element=conversation.current,anchor=scrollAnchor.current;if(element&&anchor){element.scrollTop=anchor.top+element.scrollHeight-anchor.height;scrollAnchor.current=undefined;}},[olderPages,messages.length]);
  useEffect(()=>{const element=conversation.current;if(element&&followLatest.current){element.scrollTop=element.scrollHeight;setNewMessage(false)}else if(messages.at(-1)?.role==='assistant')setNewMessage(true)},[messages.at(-1)?.id]);
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
  },onSuccess:result=>{try{localStorage.removeItem(key+':pending')}catch{}if(!live.current)return;attempt.current=undefined;setDraft('');setSendError('');setAccepted(result.queued?'Message saved. Waiting for Pinecone…':'Message saved.');void detail.refetch()},onError:error=>{const definitive=error instanceof ApiRequestError&&definitiveSubmissionStatus(error.status,error.message);if(definitive){attempt.current=undefined;try{localStorage.removeItem(key+':pending')}catch{}}if(live.current)setSendError(definitive?'Pinecone couldn’t accept that message. Your draft is kept. Please review it and try again.':'Delivery is uncertain. Your draft is kept. Retry sends the exact same message with the same delivery identity.')}});
  const working=stream.running||(detail.data?.runs.some(run=>run.status==='running')??false);
  const submit=()=>{if((draft.trim()||attempt.current)&&!send.isPending){followLatest.current=true;send.mutate()}};
  return <>
    <Box component="section" ref={conversation} aria-label="Conversation with Pinecone" tabIndex={0} onPointerDown={()=>{followLatest.current=false}} onWheel={event=>{if(event.deltaY<0)followLatest.current=false}} onScroll={event=>{const element=event.currentTarget;followLatest.current=element.scrollHeight-element.scrollTop-element.clientHeight<48}} sx={{flex:1,minHeight:0,overflowY:'auto',overscrollBehavior:'contain',px:{xs:1.5,sm:3},pb:1.5}}>
      <Stack spacing={2} sx={{maxWidth:780,mx:'auto',pt:2}}>
        {detail.error&&<Alert severity="warning">Conversation could not refresh. <Button onClick={()=>void detail.refetch()}>Retry</Button></Alert>}
        {detail.isPending&&<Typography role="status" color="text.secondary">Loading your messages…</Typography>}
        {oldestPage?.history?.hasMore&&<Button disabled={loadingHistory} onClick={()=>void loadOlder()}>{loadingHistory?'Loading earlier messages…':'Earlier messages'}</Button>}
        {historyError&&<Alert severity="warning" action={<Button disabled={loadingHistory} onClick={()=>void loadOlder()}>Retry</Button>}>{historyError}</Alert>}
        {detail.isSuccess&&!messages.length&&<Stack spacing={1} sx={{py:4}}><Typography variant="h6">What’s on your mind?</Typography><Typography color="text.secondary" variant="body2">Ask a question, talk through a decision, or tell Pinecone what you’d like help with.</Typography></Stack>}
        {messages.map(message=><Box component="article" aria-label={message.role==='user'?'Your message':'Pinecone message'} data-message-id={message.id} key={message.id} sx={{alignSelf:message.role==='user'?'flex-end':'flex-start',minWidth:0,maxWidth:{xs:'94%',sm:'90%'},px:{xs:1.5,sm:2.25},py:1.25,borderRadius:3,borderBottomRightRadius:message.role==='user'?6:24,borderBottomLeftRadius:message.role==='assistant'?6:24,bgcolor:message.role==='user'?'primary.main':'action.hover',color:message.role==='user'?'primary.contrastText':'text.primary',overflowWrap:'anywhere'}}>
          {message.document?<CommunicationDocumentCard document={message.document}/>:<ChatMessageBody text={message.text} citations={message.citations} agentMentions={message.agentMentions} compactMarkdown/>}
          {!!message.attachments?.length&&<Button color="inherit" size="small" onClick={onAdvanced}>View {message.attachments.length} attachments</Button>}
          <Stack direction="row" alignItems="center" gap={.5} sx={{mt:.5}}><Typography variant="caption" sx={{opacity:.65}}>{new Date(message.createdAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}</Typography>{message.role==='user'&&<MessageDeliveryStatus receipts={message.deliveryReceipts} recipientName={()=>'Pinecone'} compact/>}</Stack>
          {message.role==='user'&&message.deliveryReceipts?.some(receipt=>['failed','undelivered','retry_exhausted','run_unconfirmed'].includes(receipt.state))&&<Typography variant="caption" role="alert" sx={{display:'block',mt:.5}}>Pinecone couldn’t reply. Your message is saved. {safeMessageRetry(message.deliveryReceipts)&&<Button size="small" color="inherit" disabled={send.isPending||Boolean(attempt.current)} onClick={async()=>{
            const latest=await detail.refetch();const current=latest.data?.messages.find(m=>m.id===message.id);
            if(!current||!safeMessageRetry(current.deliveryReceipts)){setSendError('This message’s outcome needs review. It hasn’t been sent again.');return}
            setDraft(current.text);setSendError('');setAccepted('Review your saved message, then send to try again.');
          }}>Try again</Button>}</Typography>}
        </Box>)}
        {detail.data?.decisionEvents?.filter(event=>event.decision.status==='pending').map(event=><DecisionCard key={event.decision.id} decision={event.decision} onResolved={()=>void detail.refetch()}/>)}
        {working&&<Typography role="status" color="text.secondary" variant="body2">Pinecone is working…</Typography>}
      </Stack>
    </Box>
    {newMessage&&<Button onClick={()=>{followLatest.current=true;const element=conversation.current;if(element)element.scrollTop=element.scrollHeight;setNewMessage(false)}} sx={{alignSelf:'center'}}>↓ New message</Button>}
    <Box component="form" onSubmit={event=>{event.preventDefault();submit()}} sx={{flexShrink:0,px:{xs:1.5,sm:3},pb:'max(8px, env(safe-area-inset-bottom))',pt:1,bgcolor:'background.default'}}>
      <Stack spacing={1} sx={{maxWidth:780,mx:'auto'}}>
        {sendError&&<Alert severity="warning" action={<Button disabled={send.isPending} onClick={submit}>{attempt.current?'Retry same message':'Try again'}</Button>}>{sendError}</Alert>}
        {accepted&&<Typography variant="caption" role="status" color="text.secondary">{accepted}</Typography>}
        <Stack direction="row" alignItems="flex-end" gap={1} sx={{border:1,borderColor:'divider',borderRadius:4,p:.5,bgcolor:'background.paper'}}>
          <TextField autoComplete="off" multiline maxRows={compact?3:6} placeholder="Text Pinecone…" inputProps={{'aria-label':'Message Pinecone'}} value={draft} disabled={send.isPending||Boolean(sendError&&attempt.current)} onChange={e=>{setDraft(e.target.value);setAccepted('');if(!attempt.current)setSendError('')}} variant="standard" fullWidth InputProps={{disableUnderline:true}} sx={{px:1,py:.5}} onKeyDown={e=>{if(e.key==='Enter'&&finePointer&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();submit()}}}/>
          <IconButton type="submit" aria-label="Send message to Pinecone" disabled={!draft.trim()||send.isPending||Boolean(sendError)} sx={{width:44,height:44,bgcolor:'primary.main',color:'primary.contrastText','&:hover':{bgcolor:'primary.dark'}}}>{send.isPending?<CircularProgress size={20}/>:<ArrowUpwardRoundedIcon/>}</IconButton>
        </Stack>
      </Stack>
    </Box>
  </>;
}

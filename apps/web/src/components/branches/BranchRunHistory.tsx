import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import {Alert,Box,Button,List,ListItemButton,MenuItem,Stack,TextField,Typography} from '@mui/material';
import type {BranchExecutionDto} from '@ponderosa/core';
import {SemanticStatus,semanticAgentStatus} from '../SemanticStatus';

/** History uses recorded Run state. The selected Run's operations owner supplies its current explanation. */
export function BranchRunHistory({runs,selectedId,selectedRun,filter,onFilter,onSelect,loading,error,onRetry,hasMore,loadingMore,onMore,triggerEvents,children}:{
 runs:readonly BranchExecutionDto[];selectedId:string;selectedRun?:BranchExecutionDto;filter?:string;
 onFilter(value:string):void;onSelect(id:string):boolean;loading:boolean;error?:Error|null;onRetry():void;
 hasMore:boolean;loadingMore:boolean;onMore():void;triggerEvents:ReactNode;children:ReactNode;
}):JSX.Element {
 const [showHistory,setShowHistory]=useState(!selectedId);
 const previous=useRef(selectedId),historyScroll=useRef<HTMLDivElement>(null),detailScroll=useRef<HTMLDivElement>(null),scroll=useRef({history:0,detail:0});
 useLayoutEffect(()=>{if(historyScroll.current)historyScroll.current.scrollTop=scroll.current.history;if(detailScroll.current)detailScroll.current.scrollTop=scroll.current.detail},[showHistory]);
 useEffect(()=>{if(previous.current!==selectedId){previous.current=selectedId;scroll.current.detail=0;if(detailScroll.current)detailScroll.current.scrollTop=0;setShowHistory(!selectedId)}},[selectedId]);
 const retained=selectedRun?.id===selectedId&&!runs.some(run=>run.id===selectedId)?selectedRun:undefined;
 const renderRun=(run:BranchExecutionDto,outside=false)=><ListItemButton key={run.id} selected={run.id===selectedId} aria-current={run.id===selectedId?'true':undefined} onClick={()=>{if(onSelect(run.id))setShowHistory(false)}} sx={{alignItems:'flex-start',borderRadius:1,minHeight:64}}>
  <Stack spacing={0.75} sx={{minWidth:0,width:'100%'}}>
   <Typography variant="body2" sx={{fontWeight:600}}>{new Date(run.createdAt).toLocaleString()}</Typography>
   <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{alignItems:'center'}}>
    <SemanticStatus status={run.state==='queued'?'waiting':semanticAgentStatus(run.state)} label={run.state==='canceled'?'Canceled':run.state[0]!.toUpperCase()+run.state.slice(1)}/>
    <Typography variant="caption" color="text.secondary">{run.admissionSource==='manual'?'Manual Run':run.admissionSource==='automatic'?'Automatic Run':run.admissionSource==='call'?'Called by Workflow':'Workflow Run'}</Typography>
   </Stack>
   {outside&&<Typography variant="caption" color="text.secondary">Selected Run outside this history page or filter</Typography>}
  </Stack>
 </ListItemButton>;
 return <Box sx={{containerType:'inline-size',containerName:'branch-runs',height:'100%',minHeight:0,flex:1}}>
  <Box sx={{height:'100%',minHeight:0,display:'grid',gridTemplateColumns:'minmax(0, 1fr)', '@container branch-runs (min-width: 48rem)':{gridTemplateColumns:'minmax(15rem, 19rem) minmax(0, 1fr)'}}}>
   <Box ref={historyScroll} onScroll={event=>{scroll.current.history=event.currentTarget.scrollTop}} component="section" aria-label="Run History" sx={{display:showHistory?'flex':'none',flexDirection:'column',minWidth:0,minHeight:0,overflow:'auto',p:2,borderRight:1,borderColor:'divider','@container branch-runs (min-width: 48rem)':{display:'flex'}}}>
    <Stack spacing={1.5}>
     <Typography variant="h6">Run History</Typography>
     <TextField select size="small" label="Filter Runs" value={filter??''} onChange={event=>onFilter(event.target.value)}>
      <MenuItem value="">All Runs</MenuItem>{['queued','running','waiting','completed','failed','canceled','skipped','merged'].map(state=><MenuItem key={state} value={state}>{state[0]!.toUpperCase()+state.slice(1)}</MenuItem>)}
     </TextField>
     {triggerEvents}
     {error&&<Alert severity="error" action={<Button onClick={onRetry}>Retry</Button>}>Run history unavailable. {error.message}</Alert>}
     {loading&&!runs.length?<Typography role="status">Loading Run history…</Typography>:!error&&!runs.length?<Typography color="text.secondary">{filter?'No Runs match this filter.':'No Runs yet. Use Run Workflow to begin.'}</Typography>:null}
    </Stack>
    <List aria-label="Workflow Runs" disablePadding sx={{mt:1}}>{retained&&renderRun(retained,true)}{runs.map(run=>renderRun(run))}</List>
    {hasMore&&<Button disabled={loadingMore} onClick={onMore} sx={{mt:1,flexShrink:0}}>{loadingMore?'Loading…':'Load Older Runs'}</Button>}
   </Box>
   <Box ref={detailScroll} onScroll={event=>{scroll.current.detail=event.currentTarget.scrollTop}} component="section" aria-label="Selected Run" sx={{display:showHistory?'none':'block',minWidth:0,minHeight:0,overflow:'auto',p:{xs:1.5,sm:2},'@container branch-runs (min-width: 48rem)':{display:'block'}}}>
    <Button startIcon={<ArrowBackIcon/>} onClick={()=>setShowHistory(true)} sx={{mb:1,minHeight:44,'@container branch-runs (min-width: 48rem)':{display:'none'}}}>Run History</Button>
    {selectedId?children:<Typography color="text.secondary">Select a Run to see its result and required actions.</Typography>}
   </Box>
  </Box>
 </Box>;
}

import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import {Alert,Box,Button,List,ListItemButton,MenuItem,Skeleton,Stack,TextField,Typography} from '@mui/material';
import {notificationPreviewText,type BranchExecutionDto} from '@ponderosa/core';
import {SemanticStatus,semanticAgentStatus} from '../SemanticStatus';

const desktopLayout='@container branch-runs (min-width: 48rem)';
function runPreview(run:BranchExecutionDto):string|undefined {
 let input:string|undefined=run.input;
 if(run.admissionSource==='automatic'){
  try{const envelope=input&&input.length<=4096?JSON.parse(input):undefined;input=typeof envelope?.payload==='string'?envelope.payload:undefined}catch{input=undefined}
 }
 for(const value of [run.output,input]){
  // ponytail: inspect at most 4,096 code units for a display-only row preview;
  // larger structured inputs remain available in the selected Run's evidence.
  let text=value?.slice(0,4096).trim();if(!text)continue;
  if(text.startsWith('"')){try{const parsed:unknown=JSON.parse(text);if(typeof parsed!=='string')continue;text=parsed}catch{continue}}
  if(/^(?:branch-result-bundle:|trigger-occurrence:|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$)/iu.test(text))continue;
  const preview=notificationPreviewText(text);if(preview&&!/^[{\[]/u.test(preview))return preview;
 }
}

/** History uses recorded Run state. The selected Run's operations owner supplies its current explanation. */
export function BranchRunHistory({runs,selectedId,selectedRun,filter,onFilter,onSelect,loading,error,onRetry,hasMore,loadingMore,onMore,triggerEvents,children,active=true}:{
 runs:readonly BranchExecutionDto[];selectedId:string;selectedRun?:BranchExecutionDto;filter?:string;
 onFilter(value:string):void;onSelect(id:string,replace?:boolean):boolean;loading:boolean;error?:Error|null;onRetry():void;active?:boolean;
 hasMore:boolean;loadingMore:boolean;onMore():void;triggerEvents:ReactNode;children:ReactNode;
}):JSX.Element {
 const [showHistory,setShowHistory]=useState(!selectedId);
 const previous=useRef(selectedId),historyScroll=useRef<HTMLDivElement>(null),detailScroll=useRef<HTMLDivElement>(null),scroll=useRef({history:0,detail:0});
 const layout=useRef<HTMLDivElement>(null),automatic=useRef<string>(),attemptedFilter=useRef<string>(),wasActive=useRef(active);
 const [desktop,setDesktop]=useState(false);
 useLayoutEffect(()=>{
  const element=layout.current;if(!element)return;
  // Read the same container-query presentation that owns the columns, including
  // a desktop narrowed by its sidebar. No competing viewport breakpoint.
  const measure=()=>setDesktop(getComputedStyle(element).getPropertyValue('--branch-runs-desktop').trim()==='1');
  measure();const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect();
 },[]);
 useLayoutEffect(()=>{if(historyScroll.current)historyScroll.current.scrollTop=scroll.current.history;if(detailScroll.current)detailScroll.current.scrollTop=scroll.current.detail},[showHistory]);
 useEffect(()=>{if(!selectedId){if(active)setShowHistory(true);return;}if(previous.current!==selectedId){previous.current=selectedId;scroll.current.detail=0;if(detailScroll.current)detailScroll.current.scrollTop=0;if(automatic.current!==selectedId)setShowHistory(false);automatic.current=undefined}},[selectedId]);
 useEffect(()=>{
  const returning=active&&!wasActive.current;wasActive.current=active;
  if(!active){attemptedFilter.current=undefined;automatic.current=undefined;return;}
  if(selectedId)return;
  const candidate=(returning?previous.current:undefined)||(desktop&&!loading&&!error?previous.current||runs[0]?.id:undefined);
  if(!candidate||attemptedFilter.current===(filter??''))return;
  attemptedFilter.current=filter??'';automatic.current=candidate;
  if(!onSelect(candidate,true))automatic.current=undefined;
 },[active,selectedId,desktop,loading,error,runs,filter,onSelect]);
 const retained=selectedRun?.id===selectedId&&!runs.some(run=>run.id===selectedId)?selectedRun:undefined;
 const hasDetails=Boolean(selectedId||!error&&runs.length||loading);
 const renderRun=(run:BranchExecutionDto,outside=false)=>{const preview=runPreview(run);return <ListItemButton key={run.id} selected={run.id===selectedId} aria-current={run.id===selectedId?'true':undefined} onClick={()=>{if(onSelect(run.id))setShowHistory(false)}} sx={{alignItems:'flex-start',borderRadius:1,minHeight:64}}>
  <Stack spacing={0.75} sx={{minWidth:0,width:'100%'}}>
   <Typography variant="body2" sx={{fontWeight:600}}>{new Date(run.createdAt).toLocaleString()}</Typography>
   <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{alignItems:'center'}}>
    <SemanticStatus status={run.state==='queued'?'waiting':semanticAgentStatus(run.state)} label={run.state==='canceled'?'Canceled':run.state[0]!.toUpperCase()+run.state.slice(1)}/>
    <Typography variant="caption" color="text.secondary">{run.admissionSource==='manual'?'Manual Run':run.admissionSource==='automatic'?'Automatic Run':run.admissionSource==='call'?'Called by Workflow':'Workflow Run'}</Typography>
   </Stack>
   {preview&&<Typography variant="body2" color="text.secondary" sx={{display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical',overflow:'hidden',overflowWrap:'anywhere'}}>{preview}</Typography>}
   {outside&&<Typography variant="caption" color="text.secondary">Selected Run outside this history page or filter</Typography>}
  </Stack>
 </ListItemButton>};
 return <Box sx={{containerType:'inline-size',containerName:'branch-runs',height:'100%',minHeight:0,flex:1}}>
  <Box ref={layout} data-run-history-layout sx={{height:'100%',minHeight:0,display:'grid',gridTemplateColumns:'minmax(0, 1fr)','--branch-runs-desktop':'0',[desktopLayout]:{gridTemplateColumns:hasDetails?'minmax(15rem, 19rem) minmax(0, 1fr)':'minmax(0, 1fr)','--branch-runs-desktop':'1'}}}>
   <Box ref={historyScroll} onScroll={event=>{scroll.current.history=event.currentTarget.scrollTop}} component="section" aria-label="Run History" sx={{display:showHistory?'flex':'none',flexDirection:'column',minWidth:0,minHeight:0,overflow:'auto',p:2,borderRight:1,borderColor:'divider',[desktopLayout]:{display:'flex'}}}>
    <Stack spacing={1.5}>
     <Typography variant="h6">Run History</Typography>
     <TextField select size="small" label="Filter Runs" value={filter??''} onChange={event=>onFilter(event.target.value)}>
      <MenuItem value="">All Runs</MenuItem>{['queued','running','waiting','completed','failed','canceled','skipped','merged'].map(state=><MenuItem key={state} value={state}>{state[0]!.toUpperCase()+state.slice(1)}</MenuItem>)}
     </TextField>
     {triggerEvents}
     {error&&<Alert severity="error" action={<Button onClick={onRetry}>Retry</Button>}>Run history unavailable. {error.message}</Alert>}
     {loading&&!runs.length?<Stack role="status" aria-label="Loading Run history"><Skeleton height={24}/><Skeleton height={64}/><Skeleton height={64}/></Stack>:!error&&!runs.length?<Stack><Typography color="text.secondary">{filter?'No Runs match this filter.':'No Runs yet. Use Run Workflow to begin.'}</Typography>{filter&&<Button sx={{alignSelf:'start'}} onClick={()=>onFilter('')}>Clear Filter</Button>}</Stack>:null}
    </Stack>
    <List aria-label="Workflow Runs" disablePadding sx={{mt:1}}>{retained&&renderRun(retained,true)}{runs.map(run=>renderRun(run))}</List>
    {hasMore&&<Button disabled={loadingMore} onClick={onMore} sx={{mt:1,flexShrink:0}}>{loadingMore?'Loading…':'Load Older Runs'}</Button>}
   </Box>
   <Box ref={detailScroll} onScroll={event=>{scroll.current.detail=event.currentTarget.scrollTop}} component="section" aria-label="Selected Run" sx={{display:showHistory?'none':'block',minWidth:0,minHeight:0,overflow:'auto',p:{xs:1.5,sm:2},[desktopLayout]:{display:hasDetails?'block':'none'}}}>
    <Button startIcon={<ArrowBackIcon/>} onClick={()=>setShowHistory(true)} sx={{mb:1,minHeight:44,[desktopLayout]:{display:'none'}}}>Run History</Button>
    {selectedId?children:loading?<Stack role="status" aria-label="Loading Run details"><Skeleton height={32}/><Skeleton height={80}/><Skeleton height={80}/></Stack>:!error&&runs.length?<Typography color="text.secondary">Choose a Run from history to view its result.</Typography>:null}
   </Box>
  </Box>
 </Box>;
}

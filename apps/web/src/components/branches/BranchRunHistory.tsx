import {WorkspaceQueryError} from "../WorkspaceQueryError";
import type {WorkspaceReadIssue} from "../../workspaceAvailability";
import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import FilterListIcon from '@mui/icons-material/FilterList';
import {Alert,Box,Button,Checkbox,Dialog,DialogActions,DialogContent,DialogTitle,FormControlLabel,FormGroup,List,ListItemButton,Skeleton,Stack,Typography} from '@mui/material';
import {notificationPreviewText,type BranchExecutionDto,type BranchRunStatus} from '@ponderosa/core';
import {SemanticStatus} from '../SemanticStatus';
import {BRANCH_STATUS_FILTERS,branchExecutionStatus,branchExecutionStatusValue} from './branchRunStatus';

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

/** History rows, filters and header counts share the server's effective-status projection. */
export function BranchRunHistory({runs,selectedId,selectedRun,filters=[],onFilter,onSelect,loading,error,onRetry,read,hasMore,loadingMore,onMore,triggerEvents,rememberedId,children,active=true}:{
 read?:WorkspaceReadIssue;
 runs:readonly BranchExecutionDto[];selectedId:string;selectedRun?:BranchExecutionDto;filters?:readonly BranchRunStatus[];rememberedId?:string;
 onFilter(value:BranchRunStatus[]):void;onSelect(id:string,replace?:boolean):boolean;loading:boolean;error?:Error|null;onRetry():void;active?:boolean;
 hasMore:boolean;loadingMore:boolean;onMore():void;triggerEvents:ReactNode;children:ReactNode;
}):JSX.Element {
 const [draftFilters,setDraftFilters]=useState<BranchRunStatus[]>();
 const filterKey=filters.join(',');
 const filterSummary=filters.length===0?'All runs':filters.length===1
  ?BRANCH_STATUS_FILTERS.find(item=>item.value===filters[0])?.label:`${filters.length} statuses`;
 const [showHistory,setShowHistory]=useState(!selectedId);
 const previous=useRef(selectedId),historyScroll=useRef<HTMLDivElement>(null),detailScroll=useRef<HTMLDivElement>(null),scroll=useRef({history:0,detail:0});
 const layout=useRef<HTMLDivElement>(null),automatic=useRef<string>(),attemptedFilter=useRef<string>(),wasActive=useRef(false);
 const [desktop,setDesktop]=useState(false);
 const returnToHistory=useRef(false);
 const chosenRow=useRef<HTMLDivElement>(null);
 useLayoutEffect(()=>{
  const element=layout.current;if(!element)return;
  // Read the same container-query presentation that owns the columns, including
  // a desktop narrowed by its sidebar. No competing viewport breakpoint.
  const measure=()=>setDesktop(getComputedStyle(element).getPropertyValue('--branch-runs-desktop').trim()==='1');
  measure();const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect();
 },[]);
 useLayoutEffect(()=>{if(historyScroll.current)historyScroll.current.scrollTop=scroll.current.history;if(detailScroll.current)detailScroll.current.scrollTop=scroll.current.detail},[showHistory]);
 useLayoutEffect(()=>{
  if(showHistory&&returnToHistory.current){
   chosenRow.current?.focus({preventScroll:true});
   returnToHistory.current=false;
  }
 },[showHistory]);
 useEffect(()=>{if(!selectedId){if(active)setShowHistory(true);return;}if(previous.current!==selectedId){previous.current=selectedId;scroll.current.detail=0;if(detailScroll.current)detailScroll.current.scrollTop=0;if(automatic.current!==selectedId)setShowHistory(false);automatic.current=undefined}},[selectedId]);
 useEffect(()=>{
  const returning=active&&!wasActive.current;wasActive.current=active;
  if(!active){attemptedFilter.current=undefined;automatic.current=undefined;return;}
  if(selectedId)return;
  const candidate=(returning?rememberedId||previous.current:undefined)||(desktop&&!loading&&!error?runs[0]?.id:undefined);
  if(!candidate||attemptedFilter.current===filterKey)return;
  attemptedFilter.current=filterKey;automatic.current=candidate;
  if(!onSelect(candidate,true))automatic.current=undefined;
 },[active,selectedId,desktop,loading,error,runs,filterKey,rememberedId,onSelect]);
 const listed=runs.find(run=>run.id===selectedId);
 const selected=listed??(selectedRun?.id===selectedId?selectedRun:undefined);
 const outside=Boolean(selected&&filters.length&&!filters.includes(branchExecutionStatusValue(selected)));
 const retained=outside||!listed?selected:undefined;
 const matching=outside&&listed?runs.filter(run=>run.id!==selectedId):runs;
 const hasDetails=Boolean(selectedId||runs.length||loading);
 const renderRun=(run:BranchExecutionDto)=>{const preview=runPreview(run);return <ListItemButton key={run.id} ref={run.id===selectedId?chosenRow:undefined} selected={run.id===selectedId} aria-current={run.id===selectedId?'true':undefined} onClick={()=>{if(onSelect(run.id))setShowHistory(false)}} sx={{alignItems:'flex-start',borderRadius:1,minHeight:48,py:0.75}}>
  <Stack spacing={0.25} sx={{minWidth:0,width:'100%'}}>
   <Typography variant="body2" sx={{fontWeight:600}}>{new Date(run.admittedAt??run.createdAt).toLocaleString()}</Typography>
   <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{alignItems:'center'}}>
    <SemanticStatus {...branchExecutionStatus(run)}/>
    <Typography variant="caption" color="text.secondary">{run.admissionSource==='manual'?'Manual Run':run.admissionSource==='automatic'?'Automatic Run':run.admissionSource==='call'?'Called by Workflow':'Workflow Run'}</Typography>
   </Stack>
   {preview&&<Typography variant="body2" color="text.secondary" sx={{display:'-webkit-box',WebkitLineClamp:1,WebkitBoxOrient:'vertical',overflow:'hidden',overflowWrap:'anywhere'}}>{preview}</Typography>}
  </Stack>
 </ListItemButton>};
 return <Box sx={{containerType:'inline-size',containerName:'branch-runs',height:'100%',minHeight:0,flex:1}}>
  <Box ref={layout} data-run-history-layout sx={{height:'100%',minHeight:0,display:'grid',gridTemplateColumns:'minmax(0, 1fr)','--branch-runs-desktop':'0',[desktopLayout]:{gridTemplateColumns:hasDetails?'minmax(14rem, 17rem) minmax(0, 1fr)':'minmax(0, 1fr)','--branch-runs-desktop':'1'}}}>
   <Box ref={historyScroll} onScroll={event=>{scroll.current.history=event.currentTarget.scrollTop}} component="section" aria-label="Run History" sx={{display:showHistory?'flex':'none',flexDirection:'column',minWidth:0,minHeight:0,overflow:'auto',p:2,borderRight:1,borderColor:'divider',[desktopLayout]:{display:'flex'}}}>
    <Stack spacing={1.5}>
     <Typography variant="h6">Run History</Typography>
     <Button fullWidth variant="outlined" startIcon={<FilterListIcon/>} aria-haspopup="dialog"
      onClick={()=>setDraftFilters([...filters])} sx={{justifyContent:'flex-start',minHeight:44}}>
      Filter runs · {filterSummary}
     </Button>
     <Box>{triggerEvents}</Box>
     <Dialog open={draftFilters!==undefined} onClose={()=>setDraftFilters(undefined)} fullWidth maxWidth="xs" aria-labelledby="branch-run-filters-title">
      <DialogTitle id="branch-run-filters-title">Filter runs</DialogTitle>
      <DialogContent dividers>
       <FormGroup>
        {BRANCH_STATUS_FILTERS.map(({value,label})=><FormControlLabel key={value} label={label} sx={{minHeight:44,mr:0}}
         control={<Checkbox checked={draftFilters?.includes(value)??false} onChange={(_,checked)=>setDraftFilters(current=>
          checked?[...(current??[]),value]:(current??[]).filter(state=>state!==value))}/>}/>)}
       </FormGroup>
      </DialogContent>
      <DialogActions sx={{flexWrap:'wrap'}}>
       <Button sx={{minHeight:44}} onClick={()=>setDraftFilters([])}>Clear all</Button>
       <Button sx={{minHeight:44}} onClick={()=>setDraftFilters(undefined)}>Cancel</Button>
       <Button sx={{minHeight:44}} variant="contained" onClick={()=>{
        onFilter(BRANCH_STATUS_FILTERS.filter(item=>draftFilters?.includes(item.value)).map(item=>item.value));
        setDraftFilters(undefined);
       }}>Apply</Button>
      </DialogActions>
     </Dialog>
     {read?<WorkspaceQueryError active={active} read={read}/>:error&&<Alert severity="error" action={<Button onClick={onRetry}>Retry</Button>}>Run history unavailable. {error.message}</Alert>}
     {retained&&<Box>
      {outside&&<Typography variant="body2" color="text.secondary">This run is outside your filters</Typography>}
      <List aria-label="Selected history run" disablePadding>{renderRun(retained)}</List>
     </Box>}
     {loading&&!matching.length?<Stack role="status" aria-label="Loading Run History"><Skeleton height={24}/><Skeleton height={64}/><Skeleton height={64}/></Stack>:!error&&!matching.length?<Stack><Typography color="text.secondary">{filters.length?'No runs match these filters':'No Runs yet. Use Run once to begin.'}</Typography>{filters.length>0&&<Button sx={{alignSelf:'start',minHeight:44}} onClick={()=>onFilter([])}>Clear filters</Button>}</Stack>:null}
    </Stack>
    <List aria-label="Workflow Runs" disablePadding sx={{mt:1}}>{matching.map(renderRun)}</List>
    {hasMore&&<Button disabled={loadingMore} onClick={onMore} sx={{mt:1,flexShrink:0}}>{loadingMore?'Loading…':'Load Older Runs'}</Button>}
   </Box>
   <Box ref={detailScroll} onScroll={event=>{scroll.current.detail=event.currentTarget.scrollTop}} component="section" aria-label="Selected Run" sx={{display:showHistory?'none':'block',minWidth:0,minHeight:0,overflow:'auto',p:{xs:1.5,sm:2},[desktopLayout]:{display:hasDetails?'block':'none'}}}>
    <Button startIcon={<ArrowBackIcon/>} onClick={()=>{returnToHistory.current=true;setShowHistory(true)}} sx={{mb:1,minHeight:44,[desktopLayout]:{display:'none'},'section:has([data-branch-step-tray]) > &':{display:'none'}}}>Back to Run History</Button>
    {selectedId?children:loading?<Stack role="status" aria-label="Loading Run Details"><Skeleton height={32}/><Skeleton height={80}/><Skeleton height={80}/></Stack>:runs.length?<Typography color="text.secondary">Choose a Run from history to view its result.</Typography>:null}
   </Box>
  </Box>
 </Box>;
}

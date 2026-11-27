import {Box,Tooltip} from '@mui/material';
import type {BranchDto} from '@ponderosa/core';
import {SemanticStatusCircle} from '../SemanticStatus';
import {branchRunStatus} from './branchRunStatus';

/** Availability, trigger intake and activity are independent directory facts. */
export function BranchDirectoryStatus({branch,delayed=false}:{branch:BranchDto;delayed?:boolean}):JSX.Element {
 const unpublished=branch.versionId==='';
 const state=unpublished?'unpublished':!branch.versionId||typeof branch.enabled!=='boolean'?'unknown':branch.enabled?'enabled':'disabled';
 const availability=state==='unpublished'?'Unpublished — cannot run':state==='unknown'?'Availability unknown':state==='enabled'?'Enabled':'Disabled';
 const schedule=branch.triggerKind==='schedule';
 const nextRun=schedule&&state==='enabled'&&branch.triggerEnabled&&branch.nextFireAt?new Date(branch.nextFireAt):undefined;
 const mode=state==='unpublished'?'Unpublished':state==='disabled'?'Disabled':!branch.triggerId?'Manual':
  branch.triggerEnabled===false?(schedule?'Schedule paused':'Automatic paused'):
  nextRun?`Next ${nextRun.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}`:'Automatic';
 const intake=!branch.triggerId?'Manual':state==='unknown'||branch.triggerEnabled===undefined?'Automatic intake unknown':state!=='enabled'||!branch.triggerEnabled?'Automatic intake paused':'Automatic intake on';
 const activity=branchRunStatus(branch.runCounts,delayed);
 const count=activity.total;
 const lines=['Workflow Runs',availability,intake,...(nextRun?[`Next run ${nextRun.toLocaleString()}`]:[]),...activity.lines.slice(1)],detail=lines.join(' · ');
 return <Tooltip title={<>{lines.map(line=><Box key={line}>{line}</Box>)}</>} slotProps={{tooltip:{sx:{maxWidth:'min(280px, calc(100vw - 32px))'}}}}>
  <Box component="span" role="img" aria-label={detail} tabIndex={0} data-sidebar-column="activity" data-branch-availability={state}
   sx={{display:'inline-flex',alignItems:'center',gap:.5,flexShrink:0,color:state==='enabled'?'success.main':'text.disabled',fontSize:11,fontVariantNumeric:'tabular-nums',lineHeight:'18px',whiteSpace:'nowrap'}}>
   <SemanticStatusCircle/>
   <Box component="span" sx={{color:'text.secondary'}}>{mode}</Box>
   {count!==undefined&&count>0?<Box component="span" sx={{color:'text.secondary'}}>{count>99?'99+':count}</Box>:null}
  </Box>
 </Tooltip>;
}

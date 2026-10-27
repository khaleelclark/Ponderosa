import {Box,Tooltip} from '@mui/material';
import type {BranchDto} from '@ponderosa/core';
import {SemanticStatusCircle} from '../SemanticStatus';
import {branchRunStatus} from './branchRunStatus';

/** Availability, trigger intake and activity are independent directory facts. */
export function BranchDirectoryStatus({branch,delayed=false}:{branch:BranchDto;delayed?:boolean}):JSX.Element {
 const unpublished=branch.versionId==='';
 const state=unpublished?'unpublished':!branch.versionId||typeof branch.enabled!=='boolean'?'unknown':branch.enabled?'enabled':'paused';
 const availability=state==='unpublished'?'Unpublished — cannot run':state==='unknown'?'Availability unknown':state==='enabled'?'Enabled':'Paused';
 const mode=branch.triggerId?'Automatic':'Manual';
 const intake=!branch.triggerId?'Manual':state==='unknown'||branch.triggerEnabled===undefined?'Automatic intake unknown':state!=='enabled'||!branch.triggerEnabled?'Automatic intake paused':'Automatic intake on';
 const activity=branchRunStatus(branch.runCounts,delayed);
 const count=branch.runCounts&&activity.compact!=='…'&&activity.compact!=='!'?branch.runCounts.running+branch.runCounts.waiting+branch.runCounts.queued:undefined;
 const lines=['Workflow Runs',availability,intake,...activity.lines.slice(1)],detail=lines.join(' · ');
 return <Tooltip title={<>{lines.map(line=><Box key={line}>{line}</Box>)}</>} slotProps={{tooltip:{sx:{maxWidth:'min(280px, calc(100vw - 32px))'}}}}>
  <Box component="span" role="img" aria-label={detail} tabIndex={0} data-sidebar-column="activity" data-branch-availability={state} onContextMenu={event=>event.stopPropagation()}
   sx={{display:'inline-flex',alignItems:'center',gap:.5,flexShrink:0,color:state==='enabled'?'success.main':'text.disabled',fontSize:11,fontVariantNumeric:'tabular-nums',lineHeight:'18px',whiteSpace:'nowrap'}}>
   <SemanticStatusCircle/>
   <Box component="span" sx={{color:'text.secondary'}}>{mode}</Box>
   {count!==undefined&&count>0?<Box component="span" sx={{color:'text.secondary'}}>{count>99?'99+':count}</Box>:null}
  </Box>
 </Tooltip>;
}

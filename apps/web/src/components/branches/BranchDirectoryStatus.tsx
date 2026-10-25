import {Box,Tooltip} from '@mui/material';
import type {BranchDto} from '@ponderosa/core';

/** Availability, trigger intake and activity are independent directory facts. */
export function BranchDirectoryStatus({branch,delayed=false}:{branch:BranchDto;delayed?:boolean}):JSX.Element {
 const unpublished=branch.versionId==='';
 const state=unpublished?'unpublished':!branch.versionId||typeof branch.enabled!=='boolean'?'unknown':branch.enabled?'enabled':'paused';
 const availability=state==='unpublished'?'Unpublished — cannot run':state==='unknown'?'Availability unknown':state==='enabled'?'Enabled':'Paused';
 const mode=branch.triggerId?'Automatic':'Manual';
 const intake=!branch.triggerId?'Manual':state==='unknown'||branch.triggerEnabled===undefined?'Automatic intake unknown':state!=='enabled'||!branch.triggerEnabled?'Automatic intake paused':'Automatic intake on';
 const count=typeof branch.activeExecutions==='number'&&Number.isSafeInteger(branch.activeExecutions)&&branch.activeExecutions>=0?branch.activeExecutions:undefined;
 const activity=count===undefined?'Active executions unknown':count===0?'No active executions':`${count} active executions`;
 const lines=[availability,intake,activity+(delayed?' · Updates delayed':'')],detail=lines.join(' · ');
 return <Tooltip title={<>{lines.map(line=><Box key={line}>{line}</Box>)}</>} slotProps={{tooltip:{sx:{maxWidth:'min(280px, calc(100vw - 32px))'}}}}>
  <Box component="span" role="img" aria-label={detail} tabIndex={0} data-sidebar-column="activity" data-branch-availability={state} onContextMenu={event=>event.stopPropagation()}
   sx={{display:'inline-flex',alignItems:'center',gap:.5,flexShrink:0,color:state==='enabled'?'success.main':'text.disabled',fontSize:11,fontVariantNumeric:'tabular-nums',lineHeight:'18px',whiteSpace:'nowrap'}}>
   <Box component="svg" viewBox="0 0 8 8" aria-hidden="true" sx={{width:8,height:8,flex:'0 0 8px',display:'block'}}>
    {state==='enabled'?<circle cx="4" cy="4" r="4" fill="currentColor"/>:state==='paused'?<><circle cx="4" cy="4" r="3.5" fill="none" stroke="currentColor"/><path d="M3 2.5v3 M5 2.5v3" stroke="currentColor"/></>:state==='unpublished'?<path d="M2 1h4v6H2z M3 3h2 M3 5h2" fill="none" stroke="currentColor"/>:<text x="4" y="6.5" textAnchor="middle" fill="currentColor" fontSize="8">?</text>}
   </Box>
   <Box component="span" sx={{color:'text.secondary'}}>{mode}</Box>
   {count!==undefined&&count>0?<Box component="span" sx={{color:'text.secondary'}}>{count>99?'99+':count}</Box>:null}
  </Box>
 </Tooltip>;
}

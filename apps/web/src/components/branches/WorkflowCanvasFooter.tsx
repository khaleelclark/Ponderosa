import type {ReactNode} from 'react';
import {IconButton,Stack,Tooltip} from '@mui/material';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import CloseFullscreenIcon from '@mui/icons-material/CloseFullscreen';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import FitScreenIcon from '@mui/icons-material/FitScreen';
import UndoIcon from '@mui/icons-material/Undo';
import RedoIcon from '@mui/icons-material/Redo';
import type {WorkflowUndoRedo} from './WorkflowCanvas';

export function WorkflowCanvasFooter({viewSelector,saveControl,undoRedo,expanded,onToggleExpanded,zoomIn,zoomOut,fit}:{
 viewSelector?:ReactNode;saveControl:ReactNode;undoRedo:WorkflowUndoRedo;expanded:boolean;onToggleExpanded?():void;
 zoomIn?():void;zoomOut?():void;fit?():void;
}):JSX.Element{
 const controls=[
  [ZoomInIcon,'Zoom In',zoomIn],
  [ZoomOutIcon,'Zoom Out',zoomOut],
  [FitScreenIcon,'Fit Workflow',fit],
  [UndoIcon,'Undo',undoRedo.canUndo?undoRedo.onUndo:undefined],
  [RedoIcon,'Redo',undoRedo.canRedo?undoRedo.onRedo:undefined],
 ] as const;
 return <Stack direction="row" alignItems="center" gap={1} sx={{flexShrink:0,flexWrap:'wrap',px:1.5,pt:1,borderTop:'1px solid',borderColor:'divider',pb:'calc(8px + env(safe-area-inset-bottom, 0px))',bgcolor:'background.default'}}>
  {viewSelector}
  <Stack direction="row" sx={{flexShrink:0,bgcolor:'background.paper',border:'1px solid',borderColor:'divider',borderRadius:'12px',pointerEvents:'auto'}}>
   {controls.map(([Icon,label,action])=><Tooltip title={label} key={label}><span><IconButton aria-label={label} onClick={action} disabled={!action} sx={{width:44,height:44}}><Icon/></IconButton></span></Tooltip>)}
  </Stack>
  {onToggleExpanded&&<Tooltip title={expanded?'Collapse Workflow':'Expand Workflow'}><IconButton aria-label={expanded?'Collapse Workflow':'Expand Workflow'} aria-pressed={expanded} onClick={onToggleExpanded} sx={{width:44,height:44,bgcolor:'background.paper'}}>{expanded?<CloseFullscreenIcon/>:<OpenInFullIcon/>}</IconButton></Tooltip>}
  <Stack direction="row" alignItems="center" gap={1} sx={{ml:'auto',minWidth:0,maxWidth:'100%','& .MuiButton-root':{minHeight:44,whiteSpace:'nowrap'}}}>{saveControl}</Stack>
 </Stack>;
}

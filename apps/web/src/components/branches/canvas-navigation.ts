import type {CoordinateExtent,Viewport} from '@xyflow/react';
import type {CanvasBox,CanvasLayout,CanvasSize} from './canvas-layout';

export type WorkflowCanvasFrame={bounds:CanvasBox;start:CanvasBox;entry?:CanvasBox;firstStep?:CanvasBox};
const positive=(value:number,fallback:number)=>Number.isFinite(value)&&value>0?value:fallback;
const box=({x,y,width,height}:CanvasBox):CanvasBox=>({x,y,width,height});

/** Start and the empty-workflow action are overlays, never canonical or ELK nodes. */
export function frameWorkflowCanvas(layout:CanvasLayout,entryId:string,startSize:CanvasSize):WorkflowCanvasFrame{
 const entry=layout.nodes.find(node=>node.kind==='workflow'&&node.id===entryId);
 const width=Math.min(320,positive(startSize.width,320)),height=Math.max(44,positive(startSize.height,44));
 const start={x:entry?entry.x+(entry.width-width)/2:Math.max(0,layout.width-width)/2,y:entry?entry.y-64-height:layout.nodes.length?-64-height:0,width,height};
 const firstStep=layout.nodes.length?undefined:{x:start.x+(width-320)/2,y:start.y+height+64,width:320,height:64};
 const left=Math.min(0,start.x,firstStep?.x??0),top=Math.min(0,start.y),right=Math.max(layout.width,start.x+width,firstStep?firstStep.x+firstStep.width:0),bottom=Math.max(layout.height,start.y+height,firstStep?firstStep.y+firstStep.height:0);
 return {bounds:{x:left-32,y:top-32,width:right-left+64,height:bottom-top+64},start,...(entry?{entry:box(entry)}:{}),...(firstStep?{firstStep}:{})};
}

/** A finite native-scroll scene keeps readable scale; Fit is an explicit separate action. */
export function guidedWorkflowScene(frame:WorkflowCanvasFrame,available:CanvasSize):{width:number;height:number;viewport:Viewport}{
 const width=Math.max(frame.bounds.width,positive(available.width,1)),height=Math.max(frame.bounds.height,positive(available.height,1));
 return {width,height,viewport:{x:(width-frame.bounds.width)/2-frame.bounds.x,y:-frame.bounds.y,zoom:1}};
}

/** Expand only to the currently visible world rectangle, so a small graph can center without blank acres. */
export function workflowTranslateExtent(frame:WorkflowCanvasFrame,available:CanvasSize,zoom=1):CoordinateExtent{
 const scale=positive(zoom,1),width=Math.max(frame.bounds.width,positive(available.width,1)/scale),height=Math.max(frame.bounds.height,positive(available.height,1)/scale),x=frame.bounds.x-(width-frame.bounds.width)/2,y=frame.bounds.y;
 return [[x,y],[x+width,y+height]];
}

/** Imperative viewport restoration and resizes use the same bounds as interactive Explore panning. */
export function clampWorkflowViewport(frame:WorkflowCanvasFrame,available:CanvasSize,viewport:Viewport):Viewport{
 const zoom=positive(viewport.zoom,1),[[left,top],[right,bottom]]=workflowTranslateExtent(frame,available,zoom);
 const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,Number.isFinite(value)?value:(min+max)/2));
 return {x:clamp(viewport.x,positive(available.width,1)-right*zoom,-left*zoom),y:clamp(viewport.y,positive(available.height,1)-bottom*zoom,-top*zoom),zoom};
}

import test from 'node:test';
import assert from 'node:assert/strict';
import '../shared/web-typescript-loader.mjs';
const {frameWorkflowCanvas,guidedWorkflowScene,workflowTranslateExtent,clampWorkflowViewport}=await import('../../apps/web/src/components/branches/canvas-navigation.ts');
const node=(id,x,y,width=320,height=128)=>({id,kind:'workflow',workflowNodeId:id,x,y,width,height,ports:[]});
const layout=(nodes,width=400,height=400,edges=[])=>({key:'test',nodes,edges,width,height,groups:[]});
const inside=(outer,inner)=>inner.x>=outer.x&&inner.y>=outer.y&&inner.x+inner.width<=outer.x+outer.width&&inner.y+inner.height<=outer.y+outer.height;
const close=(a,b)=>assert.ok(Math.abs(a-b)<.001,`${a} is near ${b}`);

// Presentation Start must not drift into a pinned HUD or change the authored graph.
test('Start connects directly above the real entry, including negative Y, with bounded padding',()=>{
 const graph=layout([node('later',40,240),node('entry',40,28)]),before=structuredClone(graph);
 const frame=frameWorkflowCanvas(graph,'entry',{width:320,height:60});
 assert.deepEqual(frame.start,{x:40,y:-96,width:320,height:60});assert.deepEqual(frame.entry,{x:40,y:28,width:320,height:128});
 assert.equal(frame.entry.y-(frame.start.y+frame.start.height),64);assert.equal(frame.start.x+frame.start.width/2,frame.entry.x+frame.entry.width/2);
 assert.deepEqual(frame.bounds,{x:-32,y:-128,width:464,height:560});assert.equal(frame.firstStep,undefined);assert.deepEqual(graph,before);
});

test('empty workflows show only connected presentation Start and Add First Step at readable size',()=>{
 const graph=layout([],0,0),before=structuredClone(graph),frame=frameWorkflowCanvas(graph,'',{width:600,height:12});
 assert.deepEqual(frame.start,{x:0,y:0,width:320,height:44});assert.deepEqual(frame.firstStep,{x:0,y:108,width:320,height:64});
 assert.equal(frame.entry,undefined);assert.ok(inside(frame.bounds,frame.start)&&inside(frame.bounds,frame.firstStep));assert.deepEqual(graph,before);
 const wrapped=frameWorkflowCanvas(graph,'',{width:320,height:180});assert.equal(wrapped.firstStep.y,244);assert.equal(wrapped.bounds.height,372);
});

test('guided scene centers horizontally, starts at the top and scrolls long or wide workflows without fitting',()=>{
 for(const [width,height,available] of [[400,400,{width:1200,height:900}],[400,12000,{width:1200,height:700}],[12000,600,{width:720,height:700}]]){
  const graph=layout([node('entry',40,28)],width,height),frame=frameWorkflowCanvas(graph,'entry',{width:320,height:72}),scene=guidedWorkflowScene(frame,available);
  assert.equal(scene.viewport.zoom,1);assert.equal(scene.width,Math.max(available.width,frame.bounds.width));assert.equal(scene.height,Math.max(available.height,frame.bounds.height));
  assert.ok(inside({x:0,y:0,width:scene.width,height:scene.height},{...frame.bounds,x:frame.bounds.x+scene.viewport.x,y:frame.bounds.y+scene.viewport.y}));
  close(frame.bounds.x+scene.viewport.x+(frame.bounds.width/2),scene.width/2);close(frame.bounds.y+scene.viewport.y,0);assert.equal(frame.start.y+scene.viewport.y,32);
 }
});

test('Explore extent stays finite and allows centering without screens of blank panning at every scale',()=>{
 const frame=frameWorkflowCanvas(layout([node('entry',40,28)]),'entry',{width:320,height:72}),available={width:390,height:700};
 for(const zoom of [.1,.5,1,2]){
  const [[left,top],[right,bottom]]=workflowTranslateExtent(frame,available,zoom);
  assert.ok([left,top,right,bottom].every(Number.isFinite));assert.ok(left<=frame.bounds.x&&top<=frame.bounds.y&&right>=frame.bounds.x+frame.bounds.width&&bottom>=frame.bounds.y+frame.bounds.height);
  close(right-left,Math.max(frame.bounds.width,available.width/zoom));close(bottom-top,Math.max(frame.bounds.height,available.height/zoom));
  const viewport=clampWorkflowViewport(frame,available,{x:1e9,y:-1e9,zoom});
  assert.ok(-viewport.x/zoom>=left-.001&&(available.width-viewport.x)/zoom<=right+.001);assert.ok(-viewport.y/zoom>=top-.001&&(available.height-viewport.y)/zoom<=bottom+.001);
 }
});

test('restoration and resize use the same Explore bounds while preserving valid views',()=>{
 const frame=frameWorkflowCanvas(layout([node('entry',100,28)],1200,5000),'entry',{width:320,height:72}),available={width:800,height:600},original={x:-100,y:-500,zoom:1};
 assert.deepEqual(clampWorkflowViewport(frame,available,original),original);
 const resized=clampWorkflowViewport(frame,{width:1900,height:800},{x:-9000,y:9000,zoom:1});assert.ok(resized.x>-9000&&resized.y<9000);
 const small=frameWorkflowCanvas(layout([node('entry',40,28)]),'entry',{width:320,height:44});
 const centered=clampWorkflowViewport(small,{width:1600,height:1000},{x:0,y:0,zoom:1});
 close(centered.x+small.bounds.x+small.bounds.width/2,800);close(centered.y+small.bounds.y,0);
});

test('frame preserves wide routes, labels, shared nodes and return paths without fabricating canonical nodes',()=>{
 const graph=layout([node('entry',40,28),node('shared',450,700)],1800,1200,[{id:'first',source:'entry',target:'shared',labelBox:{x:1500,y:300,width:200,height:72},sections:[[{x:360,y:90},{x:1772,y:90},{x:1772,y:764},{x:770,y:764}]]},{id:'return',source:'shared',target:'entry',loop:true,sections:[[{x:770,y:764},{x:1750,y:764},{x:1750,y:90},{x:360,y:90}]]}]);
 const before=structuredClone(graph),frame=frameWorkflowCanvas(graph,'entry',{width:320,height:140});
 assert.ok(inside(frame.bounds,{x:0,y:0,width:graph.width,height:graph.height}));assert.deepEqual(graph,before);assert.equal(graph.nodes.filter(item=>item.id==='shared').length,1);
 const missing=frameWorkflowCanvas(graph,'deleted',{width:320,height:44});assert.equal(missing.entry,undefined);assert.equal(missing.firstStep,undefined);assert.deepEqual(graph,before);
});

/** Exercise the actual canvas owners with controlled scheduling, not a second camera implementation. */
async function canvasOwner(predicate,scope){
 const {readFileSync}=await import('node:fs'),{createRequire}=await import('node:module'),vm=await import('node:vm'),ts=createRequire(new URL('../../apps/web/package.json',import.meta.url))('typescript');
 const source=readFileSync(new URL('../../apps/web/src/components/branches/WorkflowCanvas.tsx',import.meta.url),'utf8'),ast=ts.createSourceFile('WorkflowCanvas.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),matches=[];
 function walk(node){if(predicate(node,ts,ast))matches.push(node);ts.forEachChild(node,walk)}walk(ast);assert.equal(matches.length,1,'One existing canvas owner handles this action');
 return vm.runInNewContext(ts.transpileModule('('+matches[0].getText(ast)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports:{},...scope});
}

test('returning keyboard focus after sheet close never moves the mobile canvas',async()=>{
 const focused=[],element={dataset:{id:'entry'},classList:{contains:name=>name==='react-flow__node'},focus:options=>focused.push(options.preventScroll)},lastFocusRequest={current:1};
 const run=await canvasOwner((node,ts,ast)=>ts.isArrowFunction(node)&&ts.isCallExpression(node.parent)&&node.parent.expression.getText(ast)==='useEffect'&&node.getText(ast).includes('lastFocusRequest.current=focusRequest'),{selectedExists:true,focusRequest:2,lastFocusRequest,selected:'entry',active:true,region:{current:{querySelectorAll:()=>[element]}},requestAnimationFrame:fn=>{fn();return 1},cancelAnimationFrame(){},reveal(){throw Error('Focus return must not move or zoom the canvas')}});
 run();assert.deepEqual(focused,[true]);assert.equal(lastFocusRequest.current,2);run();assert.equal(focused.length,1,'A rerender cannot replay the completed focus request');
});

test('restoring an Explore view with an already open dock does not reveal or enlarge the selection',async()=>{
 const graph=layout([node('entry',40,28)],1200,4000),frame=frameWorkflowCanvas(graph,'entry',{width:320,height:44}),view={x:-200,y:-500,zoom:.2},restored=[],revealed=[],applied={current:{mode:'explore',layout:graph,selected:'entry',docked:true}};
 const scope={flow:{getViewport:()=>view},layout:graph,frame,active:true,available:{width:800,height:600},applied,canvasViews:new Map([['branch',{explore:view}]]),branchId:'branch',selected:'entry',nativeGuided:false,mode:'explore',enterExplore:{current:undefined},fitPending:{current:false},settingsDocked:true,setFree:value=>restored.push(value),reveal:id=>revealed.push(id),requestAnimationFrame:fn=>{fn();return 1},cancelAnimationFrame(){}};
 const run=await canvasOwner((node,ts,ast)=>ts.isArrowFunction(node)&&ts.isCallExpression(node.parent)&&node.parent.expression.getText(ast)==='useLayoutEffect'&&node.getText(ast).includes('applied.current='),scope);
 run();assert.deepEqual(restored,[view]);assert.deepEqual(revealed,[],'Tab return, resize and Explore entry must keep the saved overview');
 applied.current.docked=false;run();assert.deepEqual(revealed,['entry'],'Actually opening the dock still corrects selected-card visibility');
 applied.current={mode:'explore',layout:{...graph,key:'before-insertion',nodes:[]},selected:undefined,docked:true};scope.reveal=(id,force)=>revealed.push({id,force});const inserted=await canvasOwner((node,ts,ast)=>ts.isArrowFunction(node)&&ts.isCallExpression(node.parent)&&node.parent.expression.getText(ast)==='useLayoutEffect'&&node.getText(ast).includes('applied.current='),scope);inserted();assert.deepEqual(revealed.at(-1),{id:'entry',force:true},'A newly inserted card must leave a tiny overview even if it was already onscreen');
});

test('compact low-zoom insertion uses its clicked control when the Outline trigger is absent',async()=>{
 const {createRequire}=await import('node:module'),require=createRequire(new URL('../../apps/web/package.json',import.meta.url)),opened=[],target={kind:'edge',edgeId:'failure'},clicked={id:'visible-fallback'},outline={id:'outline-trigger'},outlineButton={current:null};
 const render=await canvasOwner((node,ts)=>ts.isArrowFunction(node)&&ts.isVariableDeclaration(node.parent)&&node.parent.name.getText()==='insertionButton',{Button:'button',AddIcon:'svg',require,outlineButton,setOutlineOpen(){},edgeTarget:()=>target,onInsert:(value,anchor)=>opened.push({value,anchor})});
 const edge={id:'failure',label:'Failure Path'};render(edge).props.onClick({currentTarget:clicked});assert.equal(opened[0].anchor,clicked);assert.equal(opened[0].value,target);
 outlineButton.current=outline;render(edge,true).props.onClick({currentTarget:{id:'temporary-dialog-button'}});assert.equal(opened[1].anchor,outline,'Closing Outline retains a mounted anchor for the existing menu');
});

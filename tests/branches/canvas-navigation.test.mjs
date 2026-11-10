import test from 'node:test';
import assert from 'node:assert/strict';
import '../shared/web-typescript-loader.mjs';
const {frameWorkflowCanvas,resizeWorkflowViewport,workflowTranslateExtent,clampWorkflowViewport}=await import('../../apps/web/src/components/branches/canvas-navigation.ts');
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

test('resizing preserves zoom and the visible world center before applying finite bounds',()=>{
 const view={x:-250,y:-500,zoom:.65},before={width:1200,height:700};
 for(const after of [{width:840,height:700},{width:390,height:844},{width:1500,height:900}]){
  const next=resizeWorkflowViewport(view,before,after);assert.equal(next.zoom,view.zoom);
  close((before.width/2-view.x)/view.zoom,(after.width/2-next.x)/next.zoom);close((before.height/2-view.y)/view.zoom,(after.height/2-next.y)/next.zoom);
  assert.deepEqual(resizeWorkflowViewport(next,after,before),view);
 }
});

test('Camera extent stays finite and allows centering without screens of blank panning at every scale',()=>{
 const frame=frameWorkflowCanvas(layout([node('entry',40,28)]),'entry',{width:320,height:72}),available={width:390,height:700};
 for(const zoom of [.1,.5,1,2]){
  const [[left,top],[right,bottom]]=workflowTranslateExtent(frame,available,zoom);
  assert.ok([left,top,right,bottom].every(Number.isFinite));assert.ok(left<=frame.bounds.x&&top<=frame.bounds.y&&right>=frame.bounds.x+frame.bounds.width&&bottom>=frame.bounds.y+frame.bounds.height);
  close(right-left,Math.max(frame.bounds.width,available.width/zoom));close(bottom-top,Math.max(frame.bounds.height,available.height/zoom));
  const viewport=clampWorkflowViewport(frame,available,{x:1e9,y:-1e9,zoom});
  assert.ok(-viewport.x/zoom>=left-.001&&(available.width-viewport.x)/zoom<=right+.001);assert.ok(-viewport.y/zoom>=top-.001&&(available.height-viewport.y)/zoom<=bottom+.001);
 }
});

test('restoration and resize use the same camera bounds while preserving valid views',()=>{
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
 const run=await canvasOwner((node,ts,ast)=>ts.isArrowFunction(node)&&ts.isCallExpression(node.parent)&&node.parent.expression.getText(ast)==='useEffect'&&node.getText(ast).includes('lastFocusRequest.current=focusRequest'),{selectedExists:true,focusRequest:2,lastFocusRequest,restoringFocus:{current:false},selected:'entry',active:true,region:{current:{querySelectorAll:()=>[element]}},requestAnimationFrame:fn=>{fn();return 1},cancelAnimationFrame(){},reveal(){throw Error('Focus return must not move or zoom the canvas')}});
 run();assert.deepEqual(focused,[true]);assert.equal(lastFocusRequest.current,2);run();assert.equal(focused.length,1,'A rerender cannot replay the completed focus request');
});

test('restoring or resizing a camera never reveals a selection unless a node was inserted',async()=>{
 const graph=layout([node('entry',40,28)]),view={x:-200,y:-400,zoom:.35},restored=[],revealed=[],available={width:800,height:600};
 const applied={current:{branchId:'branch',layout:graph,selected:'entry',available:{...available}}};
 const scope={region:{current:{clientWidth:available.width,clientHeight:available.height}},flow:{getViewport:()=>view},layout:graph,frame:frameWorkflowCanvas(graph,'entry',{width:320,height:44}),active:true,available,applied,canvasViews:new Map([['branch',{viewport:view}]]),branchId:'branch',selected:'entry',selectedExists:true,revealRequest:0,lastRevealRequest:{current:0},scroll:{current:{get clientWidth(){return available.width},get clientHeight(){return available.height}}},fitPending:{current:false},resizeWorkflowViewport,setFree:value=>restored.push(value),reveal:(id,force)=>revealed.push({id,force}),requestAnimationFrame:fn=>{fn();return 1},cancelAnimationFrame(){}};
 const run=await canvasOwner((node,ts,ast)=>ts.isArrowFunction(node)&&ts.isCallExpression(node.parent)&&node.parent.expression.getText(ast)==='useLayoutEffect'&&node.getText(ast).includes('applied.current='),scope);
 run();assert.deepEqual(restored,[view]);assert.deepEqual(revealed,[],'Existing selection cannot override an overview after pane changes');
 available.width=1160;run();assert.equal(restored.at(-1).x,view.x+180);assert.equal(restored.at(-1).zoom,view.zoom);assert.deepEqual(revealed,[]);
 applied.current={branchId:'branch',layout:{...graph,key:'before-insertion',nodes:[]},available:{...available}};run();assert.deepEqual(revealed.at(-1),{id:'entry',force:true});
});

test('all insertion controls retain their exact clicked anchor, with Outline as focus-return fallback',async()=>{
 const {createRequire}=await import('node:module'),require=createRequire(new URL('../../apps/web/package.json',import.meta.url)),opened=[],target={kind:'edge',edgeId:'failure'},clicked={id:'visible-fallback'},outline={id:'outline-trigger'},outlineButton={current:null};
 const render=await canvasOwner((node,ts)=>ts.isArrowFunction(node)&&ts.isVariableDeclaration(node.parent)&&node.parent.name.getText()==='insertionButton',{Button:'button',AddIcon:'svg',require,outlineButton,setOutlineOpen(){},edgeTarget:()=>target,onInsert:(value,anchor,returnTo)=>opened.push({value,anchor,returnTo})});
 const edge={id:'failure',label:'Failure Path'};render(edge).props.onClick({currentTarget:clicked});assert.equal(opened[0].anchor,clicked);assert.equal(opened[0].value,target);
 outlineButton.current=outline;const temporary={id:'temporary-dialog-button'};render(edge,true).props.onClick({currentTarget:temporary});assert.equal(opened[1].anchor,temporary,'The clicked control supplies the captured position even when Outline closes');assert.equal(opened[1].returnTo,outline,'The mounted Outline trigger restores focus after its temporary control closes');
});


test('Fit follows toolbar reflow but ends when the workspace or camera moves',async()=>{
 const graph=layout([node('entry',40,28)],400,700),frame=frameWorkflowCanvas(graph,'entry',{width:320,height:44}),fits=[],views=[],fitPending={current:{width:390,height:600,key:graph.key}},available={width:390,height:263};
 const scope={region:{current:{clientWidth:390,clientHeight:600}},flow:{getViewport:()=>({x:0,y:0,zoom:.4})},layout:graph,frame,active:true,available,applied:{current:{branchId:'branch',layout:graph,selected:'entry',available:{...available}}},canvasViews:new Map(),branchId:'branch',selected:'entry',selectedExists:true,revealRequest:0,lastRevealRequest:{current:0},selectedExists:true,revealRequest:0,lastRevealRequest:{current:0},scroll:{current:{get clientWidth(){return available.width},get clientHeight(){return available.height}}},resizeWorkflowViewport,fitPending,setFree:view=>views.push(view),reveal(){assert.fail('Reflow must not reveal or enlarge the selected card')},getViewportForBounds:(_bounds,width,height)=>{fits.push({width,height});return {x:0,y:0,zoom:height/1000}},requestAnimationFrame:fn=>{fn();return 1},cancelAnimationFrame(){}};
 const run=await canvasOwner((node,ts,ast)=>ts.isArrowFunction(node)&&ts.isCallExpression(node.parent)&&node.parent.expression.getText(ast)==='useLayoutEffect'&&node.getText(ast).includes('applied.current='),scope);
 run();available.height=163;run();assert.deepEqual(fits,[{width:390,height:263},{width:390,height:163}]);assert.equal(views.at(-1).zoom,.163);
 fitPending.current={width:390,height:600,key:graph.key};scope.region.current.clientWidth=450;available.width=450;run();assert.equal(fitPending.current,false,'Workspace resizing ends Fit reflow and preserves its zoom');assert.equal(fits.length,2);
 const zoomBy=await canvasOwner((node,ts)=>ts.isArrowFunction(node)&&ts.isVariableDeclaration(node.parent)&&node.parent.name.getText()==='zoomBy',{flow:scope.flow,fitPending,available,setFree:view=>views.push(view)});
 zoomBy(1.2);assert.equal(fitPending.current,false);run();assert.equal(fits.length,2,'Manual zoom must end automatic Fit reflow');
 const changeWorkflow=await canvasOwner((node,ts,ast)=>ts.isArrowFunction(node)&&ts.isCallExpression(node.parent)&&node.parent.expression.getText(ast)==='useLayoutEffect'&&node.parent.arguments[1]?.getText(ast)==='[branchId]',{fitPending});fitPending.current=true;changeWorkflow();assert.equal(fitPending.current,false,'Fit intent must not override a different workflow’s saved camera');
});


test('card measurements retain border-box dimensions when ResizeObserver omits a sequence',async()=>{
 const element={offsetWidth:320,offsetHeight:104},sizes=[];let report;
 const mount=await canvasOwner((node,ts,ast)=>ts.isArrowFunction(node)&&ts.isCallExpression(node.parent)&&node.parent.expression.getText(ast)==='useLayoutEffect'&&node.getText(ast).includes('measure(kind,id,'),{ref:{current:element},kind:'nodes',id:'entry',measure:(...size)=>sizes.push(size),ResizeObserver:class{constructor(callback){report=callback}observe(){}disconnect(){}}});
 mount();for(const borderBoxSize of [undefined,{inlineSize:320,blockSize:104},[{inlineSize:320,blockSize:104}]])report([{borderBoxSize,contentRect:{width:286,height:70}}]);
 assert.deepEqual(sizes.map(size=>Array.from(size)),Array.from({length:3},()=>['nodes','entry',320,104]));
});

test('Fit waits for every rendered node and connection measurement and its matching layout',async()=>{
 const graph=layout([node('entry',0,0)],400,400,[{id:'edge'}]),scope={arranging:false,layout:graph,key:'test',measurements:{}};
 const {readFileSync}=await import('node:fs'),{createRequire}=await import('node:module'),vm=await import('node:vm'),ts=createRequire(new URL('../../apps/web/package.json',import.meta.url))('typescript');
 const source=readFileSync(new URL('../../apps/web/src/components/branches/WorkflowCanvas.tsx',import.meta.url),'utf8'),ast=ts.createSourceFile('canvas.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let expression;function walk(n){if(ts.isVariableDeclaration(n)&&n.name.getText(ast)==='measuring')expression=n.initializer.getText(ast);ts.forEachChild(n,walk)}walk(ast);assert(expression);
 const run=()=>vm.runInNewContext(expression,scope);assert.equal(run(),true);scope.measurements.nodes={entry:{width:320,height:104}};assert.equal(run(),true);scope.measurements.labels={edge:{width:100,height:26}};assert.equal(run(),false);scope.key='new measurement';assert.equal(run(),true);
});

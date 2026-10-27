import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import '../shared/web-typescript-loader.mjs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const {BranchRunHistory}=await import('../../apps/web/src/components/branches/BranchRunHistory.tsx');
const {OccurrenceAudit}=await import('../../apps/web/src/components/TriggerOccurrenceAudit.tsx');
const run=(id,state='completed',source='manual')=>({id,branchId:'workflow',createdAt:'2026-10-27T11:30:00Z',state,admissionSource:source});
const props={runs:[],selectedId:'',onFilter(){},onSelect(){return true},loading:false,onRetry(){},hasMore:false,loadingMore:false,onMore(){},triggerEvents:'Trigger Events',children:'Selected Run evidence'};
const render=extra=>renderToStaticMarkup(React.createElement(BranchRunHistory,{...props,...extra}));

test('Run History distinguishes initial, filtered, loading and unavailable states without claiming unknown is empty',()=>{
 assert.match(render(),/No Runs yet/);assert.match(render({filter:'failed'}),/No Runs match this filter/);
 assert.match(render({loading:true}),/Loading Run history/);assert.doesNotMatch(render({loading:true}),/No Runs yet/);
 const unavailable=render({error:Error('Backend offline')});assert.match(unavailable,/Run history unavailable/);assert.doesNotMatch(unavailable,/No Runs yet/);
});

test('deep-linked and filtered-out selected Runs remain represented without replacing history or exposing IDs as names',()=>{
 const html=render({runs:[run('newest','running','automatic')],selectedId:'older',selectedRun:run('older','waiting','call'),filter:'running'});
 assert.match(html,/Selected Run outside this history page or filter/);assert.match(html,/aria-current="true"/);assert.match(html,/Automatic Run/);assert.match(html,/Called by Workflow/);
 assert.doesNotMatch(html,/>older<|>newest</);assert.match(html,/Selected Run evidence/);
 const other=render({runs:[],selectedId:'older',selectedRun:run('foreign')});assert.doesNotMatch(other,/Selected Run outside/);
 const loaded=render({runs:[run('older')],selectedId:'older',selectedRun:run('older')});assert.doesNotMatch(loaded,/Selected Run outside/);
});

// Run the real component with controlled hooks to exercise its presentation-only
// navigation and retained scroll; canonical selection remains the caller's owner.
function historyFixture(){
 const require=createRequire(new URL('../../apps/web/package.json',import.meta.url)),ts=require('typescript'),exports={},states=[],refs=[],effects=[];let cursor=0;
 const hooks={useState(initial){const key=cursor++;if(!(key in states))states[key]=typeof initial==='function'?initial():initial;return[states[key],value=>{states[key]=typeof value==='function'?value(states[key]):value}]},useRef(initial){const key=cursor++;return refs[key]??={current:initial}},useEffect(effect,deps){const key=cursor++,old=states[key];if(!old||deps.some((value,i)=>value!==old[i])){states[key]=deps;effects.push(effect)}},useLayoutEffect(effect,deps){hooks.useEffect(effect,deps)}};
 const jsx=(type,props)=>({type,props});const scope={exports,require:name=>name==='react'?hooks:name==='react/jsx-runtime'?{jsx,jsxs:jsx}:name==='@mui/material'?Object.fromEntries(['Alert','Box','Button','List','ListItemButton','MenuItem','Stack','TextField','Typography'].map(name=>[name,name])):name.includes('SemanticStatus')?{SemanticStatus:'SemanticStatus',semanticAgentStatus:value=>value}: {default:'Icon'}};
 vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../apps/web/src/components/branches/BranchRunHistory.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,scope);
 function nodes(tree){return !tree||typeof tree!=='object'?[]:[tree,...[tree.props?.children].flat(Infinity).flatMap(nodes)]}
 return {render(extra){cursor=0;const tree=exports.BranchRunHistory({...props,...extra});for(const effect of effects.splice(0))effect();return nodes(tree)}};
}

test('mobile history back retains selection, filter and scroll; only explicit selection opens another Run',()=>{
 const f=historyFixture(),selected=[],filters=[],extra={runs:[run('a'),run('b')],selectedId:'a',filter:'waiting',onSelect:id=>{selected.push(id);return true},onFilter:value=>filters.push(value)};
 let nodes=f.render(extra),history=nodes.find(node=>node.props?.['aria-label']==='Run History'),detail=nodes.find(node=>node.props?.['aria-label']==='Selected Run');
 const historyElement={scrollTop:140},detailElement={scrollTop:220};history.props.ref.current=historyElement;detail.props.ref.current=detailElement;
 history.props.onScroll({currentTarget:historyElement});detail.props.onScroll({currentTarget:detailElement});
 nodes.find(node=>node.type==='Button'&&node.props.children==='Run History').props.onClick();nodes=f.render(extra);
 assert.equal(nodes.find(node=>node.props?.['aria-label']==='Run History').props.sx.display,'flex');assert.equal(historyElement.scrollTop,140);assert.equal(detailElement.scrollTop,220);assert.deepEqual(selected,[]);
 nodes.find(node=>node.type==='TextField').props.onChange({target:{value:'failed'}});assert.deepEqual(filters,['failed']);assert.deepEqual(selected,[]);
 nodes=f.render({...extra,onSelect:()=>false});nodes.find(node=>node.type==='ListItemButton').props.onClick();nodes=f.render(extra);assert.equal(nodes.find(node=>node.props?.['aria-label']==='Run History').props.sx.display,'flex','Rejected navigation leaves the history pane intact');
 nodes.find(node=>node.type==='ListItemButton'&&node.props['aria-current']==='true').props.onClick();nodes=f.render(extra);assert.deepEqual(selected,['a']);assert.equal(nodes.find(node=>node.props?.['aria-label']==='Selected Run').props.sx.display,'block');
 nodes=f.render({...extra,runs:[run('new'),...extra.runs]});assert.deepEqual(selected,['a'],'Background history must not navigate');
 nodes=f.render({...extra,selectedId:'b'});assert.equal(detailElement.scrollTop,0,'Explicit different Run starts at its result');
});

test('Trigger Events keep activation distinct from completion and raw identifiers inside disclosure without changing normal audit presentation',()=>{
 const occurrence={id:'event-id',artifactId:'artifact-id',state:'activated',provenance:{},inputHash:'hash',occurredAt:'2026-10-27T11:00:00Z'};
 const branch=renderToStaticMarkup(React.createElement(OccurrenceAudit,{occurrence,runTerminology:true}));assert.match(branch,/aria-label="Activated"/);assert.doesNotMatch(branch,/aria-label="Completed"/);assert.ok(branch.indexOf('artifact-id')>branch.indexOf('<details'));
 const pending=renderToStaticMarkup(React.createElement(OccurrenceAudit,{occurrence:{...occurrence,state:'pending'},runTerminology:true}));assert.match(pending,/Pending Activation/);
 const normal=renderToStaticMarkup(React.createElement(OccurrenceAudit,{occurrence}));assert.match(normal,/aria-label="activated"/);assert.ok(normal.indexOf('artifact-id')<normal.indexOf('<details'));
});

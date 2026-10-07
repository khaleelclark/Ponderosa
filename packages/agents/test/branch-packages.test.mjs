import assert from 'node:assert/strict';
import test from 'node:test';
import {exportBranchPackage,importBranchPackage,validateBranchTemplate} from '../dist/index.js';
const definition={schema:'ponderosa.branch.v1',name:'Portable',trigger:{kind:'manual'},entry:'script',steps:[{id:'script',kind:'script',runtime:'node',source:'console.log("ok")',cwdRef:'work',timeoutMs:1000}],controls:[],edges:[],policy:{maxConcurrentExecutions:2,failure:{action:'stop'}}};
const template={schema:'ponderosa.agent-package.v1',mode:'template',kind:'agent',exportedAt:'2026-09-17T00:00:00Z',sourceLabel:'Worker',rootRef:'root',agents:[{ref:'root',title:'Worker',engine:'codex',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false}}]};
test('portable package round trip preserves Script bytes and exposes only logical requirements',()=>{
 const exported=exportBranchPackage(definition),imported=importBranchPackage(JSON.parse(JSON.stringify(exported)));
 assert.deepEqual(imported.definition,definition);assert.deepEqual(imported.requirements,{agents:[],directories:['work'],engines:[],triggers:[]});
 assert.deepEqual(Object.keys(exported).sort(),['definition','exportedAt','schema']);
 assert.throws(()=>importBranchPackage({...exported,bindings:{directories:{work:'/private/path'}}}),/not portable/);
 assert.throws(()=>importBranchPackage({...exported,executions:[]}),/not portable/);
});
test('template import rejects runtime history, private artifacts, elevated lifecycle authority and cyclic identities',()=>{
 assert.deepEqual(validateBranchTemplate(template),template);
 for(const patch of [{mode:'full'},{sourceProjectInstructions:'private context'},{agents:[{...template.agents[0],history:[]}]},{agents:[{...template.agents[0],artifacts:[]}]},{agents:[{...template.agents[0],managerRef:'root'}]},{agents:[{...template.agents[0],managementPermissions:{allowAutomaticDescendantDeletion:true,allowAutomaticDescendantReorganization:false}}]}])assert.throws(()=>validateBranchTemplate({...template,...patch}));
});
test('Branch package validates ephemeral templates and enumerates engine bindings without local identities',()=>{
 const graph={...definition,templates:{worker:template},entry:'agent',steps:[{id:'agent',kind:'agent',target:{kind:'ephemeral_agent',templateRef:'worker'},instructions:'Work'}]};
 const parsed=importBranchPackage(exportBranchPackage(graph));assert.deepEqual(parsed.requirements.engines,['codex']);assert.deepEqual(parsed.requirements.agents,[]);
 assert.throws(()=>importBranchPackage(exportBranchPackage({...graph,templates:{}})),/template/);
});

test('portable package preserves For Each, Join policy and declared Route choices',()=>{
 const graph={...definition,entry:'map',steps:[{...definition.steps[0],id:'worker'},{...definition.steps[0],id:'billing'},{...definition.steps[0],id:'fallback'}],controls:[{id:'map',kind:'map',joinId:'join',workerId:'worker',source:'interpret',maxItems:50,maxConcurrentItems:5},{id:'join',kind:'join',forkId:'map',mode:'quorum',quorum:3,remainder:'finish',inputOrder:[],onUnmet:'continue'},{id:'route',kind:'route',otherwise:'fallback'}],edges:[{id:'item',from:'map',to:'worker',on:'selected'},{id:'return',from:'worker',to:'join',on:'success'},{id:'select',from:'join',to:'route',on:'success'},{id:'billing',from:'route',to:'billing',on:'selected',choice:'Billing'},{id:'otherwise',from:'route',to:'fallback',on:'failure'}]};
 assert.deepEqual(importBranchPackage(exportBranchPackage(graph)).definition,graph);
});

test('definition review identifies Script, instruction, path and trigger changes',async()=>{
 const {branchDefinitionChanges,validateBranchBindings,validateBranchDefinition}=await import('../dist/index.js');
 const next=structuredClone(definition);next.steps[0].label='Format Report';next.steps[0].source='console.log("changed")';next.trigger={kind:'schedule',configRef:'schedule'};
 const changes=branchDefinitionChanges(definition,next);assert.ok(changes.some(c=>c.resource==='Script'&&c.ref==='Format Report'&&c.after.includes('changed')));assert.ok(changes.some(c=>c.resource==='Trigger'));
 assert.throws(()=>validateBranchBindings({agents:{},directories:{work:''}},next),/Format Report.*Working directory is required/);
 const invalid={...definition,controls:[{id:'condition',label:'Check Approval',kind:'condition',predicate:{source:'input',equals:'yes',operator:'equalsx'},otherwise:'script'}]};
 assert.throws(()=>validateBranchDefinition(invalid),/Check Approval.*operator.*Valid fields/);
});

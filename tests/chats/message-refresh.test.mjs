import '../shared/web-typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const ts=createRequire(new URL('../../apps/web/package.json',import.meta.url))('typescript');
const source=readFileSync(new URL('../../apps/web/src/components/ProjectShell.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('ProjectShell.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const names=['openAgent','openAgentReview','openAgentFileActivity'],declarations=[];
function visit(node){if(ts.isVariableDeclaration(node)&&names.includes(node.name.getText(ast)))declarations.push('const '+node.getText(ast)+';');ts.forEachChild(node,visit)}
visit(ast);

test('message navigation stays stable through refresh and uses the latest owner and return route',()=>{
  assert.equal(declarations.length,3);
  // Control hook storage only; execute the actual navigation closures on each render.
  let cursor=0;const slots=[],navigations=[];
  const useEventCallback=fn=>{const i=cursor++;slots[i]??={current:fn,handler:(...args)=>slots[i].current(...args)};slots[i].current=fn;return slots[i].handler};
  const render=(projectId,view)=>{cursor=0;return vm.runInNewContext(ts.transpileModule(`(function(){${declarations.join('\n')}return {${names.join(',')}}})()`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{useEventCallback,projectId,route:{view},routeToPath:route=>'/return/'+route.view,navigate:route=>navigations.push(JSON.parse(JSON.stringify(route)))})};
  const before=render('first','chat'),after=render('current','team');
  for(const name of names)assert.equal(before[name],after[name],name+': a refresh must not invalidate memoized message rows');
  before.openAgent('a','technical','run-focus');before.openAgent('b');before.openAgentReview('a','run');
  before.openAgentFileActivity('a',{path:'one.txt',executionId:'run'});before.openAgentFileActivity('a',{path:'two.txt',artifactId:'artifact'});before.openAgentFileActivity('a',{path:'three.txt'});
  assert.deepEqual(navigations,[
    {kind:'agent',projectId:'current',agentId:'a',view:'technical',technicalFocusId:'run-focus'},
    {kind:'agent',projectId:'current',agentId:'b'},
    {kind:'review',projectId:'current',agentId:'a',executionId:'run',returnTo:'/return/team'},
    {kind:'review',projectId:'current',agentId:'a',path:'one.txt',executionId:'run',returnTo:'/return/team'},
    {kind:'agent',projectId:'current',agentId:'a',focusTelemetry:{stream:'artifacts',id:'artifact'}},
    {kind:'review',projectId:'current',agentId:'a',path:'three.txt',returnTo:'/return/team'},
  ]);
});

test('coordination workspace invalidations refresh the exact Agent even without a new durable mirror',()=>{
  const stream=readFileSync(new URL('../../apps/web/src/hooks/useWorkspaceStream.ts',import.meta.url),'utf8');
  const tree=ts.createSourceFile('useWorkspaceStream.ts',stream,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  let branch;
  const find=node=>{if(ts.isIfStatement(node)&&node.expression.getText(tree)==='event.type === "coordination_changed"')branch=node.thenStatement.getText(tree);ts.forEachChild(node,find)};find(tree);
  assert.ok(branch);
  const scheduled=[],scope=[];
  for(const agentId of ['one','two'])vm.runInNewContext(ts.transpileModule(branch,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{
    event:{agentId,projectId:'p',conversationIds:['chat']},
    queueAgentRoster(){},agentWorkInvalidator:{schedule(){}},collaborationChatInvalidator:{schedule(){}},
    agentDetailInvalidator:{schedule:id=>scheduled.push(id)},invalidate:key=>scope.push(key),
    queryKeys:{conversations:{targetedNextRun:id=>id}},
  });
  assert.deepEqual(scheduled,['one','two'],'a duplicate snapshot may be omitted, never its scoped detail refresh');
  assert.deepEqual(scope,['chat','chat']);
});


test('main history page merge keeps live precedence and page pagination for focus and older loads', async () => {
  const {mergeMainHistoryPage}=await import('../../apps/web/src/components/ConversationView.helpers.ts');
  const message=(id,text)=>({id,text,createdAt:'2026-01-01',canonicalOrderKey:id});
  const decision=(id,label)=>({id,label,createdAt:'2026-01-01'});
  const page={messages:[message('a','old'),message('b','page')],decisionEvents:[decision('d','old')],history:{cursor:'next-page',hasMore:true}};
  const current={messages:[message('b','retained')],decisionEvents:[decision('d','retained')],cursor:'stale',hasMore:false};
  const live={messages:[message('b','live')],decisionEvents:[decision('d','live')]};
  const result=mergeMainHistoryPage(page,current,live);
  assert.deepEqual(result.messages.map(m=>m.text),['old','live']);
  assert.equal(result.decisionEvents[0].label,'live');assert.equal(result.cursor,'next-page');assert.equal(result.hasMore,true);
  assert.deepEqual(mergeMainHistoryPage({messages:[]},undefined,undefined),{messages:[],decisionEvents:[],cursor:undefined,hasMore:false});
  assert.equal(page.messages[1].text,'page');assert.equal(current.messages[0].text,'retained');
});

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

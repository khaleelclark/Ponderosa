import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const ts=createRequire(new URL('../../apps/web/package.json',import.meta.url))('typescript');
const source=readFileSync(new URL('../../apps/web/src/components/PackageExportDisclosure.tsx',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const sharedWarning='History and stored data may contain sensitive information. Known credential fields are excluded; re-enter credentials after import. Global memory, installation permissions, live work and provider sessions are excluded.';
const jsx=(type,props)=>({type,props}),exports={};
vm.runInNewContext(compiled,{exports,require:name=>({'react/jsx-runtime':{jsx,jsxs:jsx},'@mui/material':{Alert:'Alert'},'@ponderosa/core':{FULL_PACKAGE_EXPORT_WARNING:sharedWarning},'./ConfirmationDialogs':{ConfirmDialog:'ConfirmDialog'}}[name]??assert.fail(name))});
test('full workflow export discloses exclusions before confirmation and preserves cancel/retry callbacks',async()=>{
 let exportsRequested=0,cancelled=0;const confirm=async()=>{exportsRequested++;},cancel=()=>{cancelled++;};
 const view=exports.FullPackageExportDialog({name:'Reviewed workflow',pending:false,error:'Download unavailable',onCancel:cancel,onConfirm:confirm});
 assert.equal(exports.fullPackageExportWarning,sharedWarning);assert.equal(exportsRequested,0);assert.equal(view.props.open,true);assert.equal(view.props.title,'Export Reviewed workflow');assert.equal(view.props.error,'Download unavailable');assert.equal(view.props.children[0].props.children,exports.fullPackageExportWarning);assert.match(exports.fullPackageExportWarning,/sensitive information/);assert.match(exports.fullPackageExportWarning,/Global memory, installation permissions, live work and provider sessions are excluded/);
 view.props.onCancel();assert.equal(cancelled,1);assert.equal(exportsRequested,0);await view.props.onConfirm();assert.equal(exportsRequested,1);
 const closed=exports.FullPackageExportDialog({pending:false,onCancel:cancel,onConfirm:confirm});assert.equal(closed.props.open,false);
 const pending=exports.FullPackageExportDialog({name:'Reviewed workflow',pending:true,onCancel:cancel,onConfirm:confirm});assert.equal(pending.props.pending,true);
});

// Execute the real view's two export closures with transport/download leaves stubbed.
// This keeps the test on request timing and reviewed-source binding without mounting the workspace.
function workflowExportHarness(){
 const text=readFileSync(new URL('../../apps/web/src/components/BranchesView.tsx',import.meta.url),'utf8'),file=ts.createSourceFile('BranchesView.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),closures={};
 function visit(node){if(ts.isVariableDeclaration(node)&&['exportFile','confirmFullExport'].includes(node.name.getText(file)))closures[node.name.getText(file)]=node.initializer.getText(file);ts.forEachChild(node,visit);}visit(file);assert.equal(Object.keys(closures).length,2);
 const requests=[],downloads=[],context={exports:{},draft:{branchId:'reviewed',definition:{name:'Reviewed workflow'}},fullExport:undefined,exportPending:false,exportError:undefined,requests,downloads,fail:false};
 Object.assign(context,{setFullExport:value=>{context.fullExport=value;},setExportPending:value=>{context.exportPending=value;},setExportError:value=>{context.exportError=value;},setError:message=>{context.error=message;},downloadPackageExport:async(url,options,name)=>{requests.push({url,options});if(context.fail)throw Error('Download unavailable');downloads.push({url,options,name});}});vm.createContext(context);
 for(const [name,closure] of Object.entries(closures)){const code=ts.transpileModule(`exports.${name}=(${closure});`,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;vm.runInContext(code,context);}
 return context;
}
test('actual workflow full export waits for review; cancellation and template export retain their distinct behavior',async()=>{
 const c=workflowExportHarness();await c.exports.exportFile('full');assert.equal(c.requests.length,0);assert.equal(c.downloads.length,0);assert.equal(c.fullExport.branchId,'reviewed');
 c.setFullExport(undefined);await c.exports.confirmFullExport();assert.equal(c.requests.length,0);
 await c.exports.exportFile('template');assert.equal(c.requests[0].url,'/api/branches/reviewed/package');assert.equal(c.requests[0].options.mode,'template');assert.equal(c.requests[0].options.includeValues,false);assert.equal(c.downloads.length,1);
});
test('actual workflow export failure retains the reviewed source for retry after workspace navigation',async()=>{
 const c=workflowExportHarness();await c.exports.exportFile('full');c.draft={branchId:'other',definition:{name:'Other workflow'}};c.fail=true;
 await c.exports.confirmFullExport({agent:{selectedWorkingFiles:['notes.txt']}});assert.equal(c.exportPending,false);assert.equal(c.exportError,'Download unavailable');assert.equal(c.fullExport.branchId,'reviewed');assert.equal(c.downloads.length,0);
 c.fail=false;await c.exports.confirmFullExport({agent:{selectedWorkingFiles:['notes.txt']}});assert.equal(c.requests.length,2);assert.ok(c.requests.every(request=>request.url==='/api/branches/reviewed/package'&&request.options.mode==='full'&&request.options.includeValues===true&&request.options.fileSelections.agent.selectedWorkingFiles[0]==='notes.txt'));assert.equal(c.downloads[0].name,'Reviewed_workflow.ponderosa.json');assert.equal(c.fullExport,undefined);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const ts = require('typescript');

// Exercise the shipped provider's queue and Snackbar contract. Elapsed-time
// behavior with real MUI/Chromium is covered by mentionPresentation.test.mjs.
function provider(notifier) {
  const cells = []; let cursor = 0;
  const state = initial => {
    const i = cursor++;
    if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial;
    return [cells[i], value => { cells[i] = typeof value === 'function' ? value(cells[i]) : value; }];
  };
  const react = { createContext: () => ({ Provider: 'Provider' }), useState: state,
    useRef: value => state(() => ({ current: value }))[0], useCallback: fn => fn,
    useMemo: fn => fn(), useEffect() {} };
  const exports = {};
  const source = readFileSync(new URL('../../apps/web/src/components/MutationNotifications.tsx', import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports, require: name => {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return require(name);
      if (name === '@mui/material') return Object.fromEntries(['Alert', 'Box', 'Button', 'LinearProgress', 'Portal', 'Snackbar'].map(name => [name, name]));
      if (name === '../downloads') return {};
      throw Error(name);
    },
  });
  const render = () => { cursor = 0; const tree = exports.MutationNotificationProvider({ children: null, notifier }); const portal = tree.props.children[1]; if(notifier){assert.equal(portal,false,'an embedded root must not create a second Portal');return {notify:tree.props.value};} assert.equal(portal.type, 'Portal', 'feedback must escape route stacking contexts to stay dismissible above dialogs'); return { notify: tree.props.value, snackbar: portal.props.children }; };
  return { render, notify: input => render().notify(input) };
}

test('ordinary acknowledgments use three seconds, repeat with a fresh identity, and do not reappear on rerender', () => {
  const p = provider();
  for (const message of ['Workflow Saved', 'Settings Saved', 'Copied']) {
    p.notify({ message, key: 'operation' });
    const first = p.render().snackbar;
    assert.equal(first.props.autoHideDuration, 3000);
    assert.equal(first.props.children.props.children[0], message);
    first.props.onClose(null, 'clickaway');
    assert.equal(p.render().snackbar.props.open, true, 'incidental clicks do not dismiss feedback');
    p.notify({ message, key: 'operation' });
    const repeated = p.render().snackbar;
    assert.notEqual(repeated.key, first.key, 'repeat remounts MUI Snackbar to restart its timer');
    assert.equal(p.render().snackbar.key, repeated.key, 'rerender alone does not restart feedback');
    repeated.props.onClose(null, 'timeout');
    assert.equal(p.render().snackbar.props.open, false);
    assert.equal(p.render().snackbar.props.open, false);
  }
});

test('errors and explicitly actionable warnings remain durable; dismissal advances only feedback', () => {
  const p = provider();
  for (const notice of [{ message: 'Save failed', severity: 'error' }, { message: 'Review required', severity: 'warning', persistent: true }]) {
    p.notify(notice); p.notify({ message: 'Copied', key: 'queued-copy' });
    const durable = p.render().snackbar;
    assert.equal(durable.props.autoHideDuration, null);
    durable.props.children.props.onClose();
    assert.equal(p.render().snackbar.props.children.props.children[0], 'Copied');
    p.render().snackbar.props.onClose(null, 'timeout');
    assert.equal(p.render().snackbar.props.open, false);
  }
});

test('active progress retains its presentation identity and cannot be dismissed before settlement', () => {
  const p = provider(), notice = { message: 'Preparing', key: 'download', severity: 'info', persistent: true, progress: { receivedBytes: 1 } };
  p.notify(notice); const first = p.render().snackbar;
  p.notify({ ...notice, progress: { receivedBytes: 2 } });
  const progress = p.render().snackbar;
  assert.equal(progress.key, first.key);
  assert.equal(progress.props.autoHideDuration, null);
  assert.equal(progress.props.children.props.onClose, undefined);
  progress.props.onClose(null, 'escapeKeyDown');
  assert.equal(p.render().snackbar.props.open, true);
  p.notify({ message: 'Download started', key: 'download' });
  assert.notEqual(p.render().snackbar.key, first.key);
  assert.equal(p.render().snackbar.props.autoHideDuration, 3000);
});


test('exact incidents remain dismissed across rerenders, resolution and older repeated transitions',()=>{
 const p=provider(),notice={key:'dev:chat-a:send-1',incident:'attempt-1:unknown',severity:'error',message:'Message Needs Review'};
 p.notify(notice);p.render().snackbar.props.children.props.onClose();
 for(let i=0;i<5;i++){p.notify(notice);assert.equal(p.render().snackbar.props.open,false);}
 p.notify({...notice,incident:'attempt-1:failed'});assert.equal(p.render().snackbar.props.open,true);
 p.render().snackbar.props.onClose(null,'escapeKeyDown');
 p.notify(notice);assert.equal(p.render().snackbar.props.open,false);
 p.notify({...notice,incident:'attempt-2:failed'});assert.equal(p.render().snackbar.props.open,true,'an explicit later attempt reports its own failure');
 p.notify({key:notice.key,message:'',dismiss:true});assert.equal(p.render().snackbar.props.open,false);
 p.notify({...notice,incident:'attempt-2:failed'});assert.equal(p.render().snackbar.props.open,false,'confirmed recovery does not forget a stale outcome');
});

test('equal messages for unrelated owners/operations stay distinct; resolving one leaves the other',()=>{
 const p=provider(),a={key:'dev:chat-a:upload-file-1',incident:'attempt',severity:'error',message:'Attachment Upload Failed'},b={...a,key:'branches:chat-b:upload-file-2'};
 p.notify(a);p.notify(b);p.notify({key:a.key,message:'',dismiss:true});
 assert.equal(p.render().snackbar.props.open,true);p.render().snackbar.props.children.props.onClose();assert.equal(p.render().snackbar.props.open,false);
 p.notify({message:'Equal Failure',severity:'error'});p.notify({message:'Equal Failure',severity:'error'});
 p.render().snackbar.props.children.props.onClose();assert.equal(p.render().snackbar.props.open,true,'missing identity must not collapse independent actions by prose');
});

test('embedded notifier forwards outcomes and dismissal into the host queue without a second snackbar',()=>{
 const host=provider(),embedded=provider(host.render().notify);
 host.notify({key:'core:operation',incident:'core-1',message:'Core Action Failed',severity:'error'});
 embedded.notify({key:'branches:assistant:send-1',incident:'assistant-1',message:'Message Needs Review',severity:'error'});
 assert.equal(host.render().snackbar.props.children.props.children[0],'Core Action Failed');
 host.render().snackbar.props.children.props.onClose();assert.equal(host.render().snackbar.props.children.props.children[0],'Message Needs Review');
 host.render().snackbar.props.children.props.onClose();embedded.notify({key:'branches:assistant:send-1',incident:'assistant-1',message:'Message Needs Review',severity:'error'});
 assert.equal(host.render().snackbar.props.open,false);
});

// Run the actual Branch action callbacks against the existing provider. No API
// request, retry authority or mutation cache is replaced in production code.
function branchComponent(file, name, props, imports) {
  const cells=[];let cursor=0,dirty=false;const effects=[];
  const react={useState(initial){const i=cursor++;if(!(i in cells))cells[i]=typeof initial==='function'?initial():initial;return[cells[i],value=>{const next=typeof value==='function'?value(cells[i]):value;if(!Object.is(next,cells[i])){cells[i]=next;dirty=true;}}];},useRef(initial){const i=cursor++;return cells[i]??=( {current:initial});},useEffect(fn,deps){const i=cursor++,old=cells[i];if(!old||deps.some((v,n)=>v!==old[n])){cells[i]=deps;effects.push(fn);}}};
  const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../apps/web/src/components/branches/'+file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,Error,Map,Set,JSON,require:specifier=>{
    if(specifier in imports)return imports[specifier];if(specifier==='react')return react;if(specifier==='react/jsx-runtime')return require(specifier);
    if(specifier==='@mui/material')return new Proxy({},{get:(_target,key)=>String(key)});throw Error(specifier);
  }});
  return()=>{let tree;for(let i=0;i<8;i++){cursor=0;dirty=false;tree=exports[name](props);while(effects.length)effects.shift()();if(!dirty)return tree;}throw Error('Branch fixture did not settle');};
}

test('actual Branch nested settings feedback survives sibling save and resolves only the failed leaf',async()=>{
 const {PreferenceSaveFeedback,preferenceSaveReporter}=await import('../../apps/web/src/preferenceSaveFeedback.ts');
 const p=provider(),jobs=[];let id=0;
 const preferences={notifications:{directResponses:false,broadcasts:false}};
 const render=branchComponent('BranchGlobalSettings.tsx','BranchGlobalSettings',{view:'notifications',preferences,engines:[],colorMode:'light',onToggleColorMode(){},onClose(){}},{
  '../../hooks/queries':{useWorkspacePreferencesWriter:()=>({enqueueAndWait:patch=>new Promise((resolve,reject)=>jobs.push({patch,resolve,reject}))})},
  '../../preferenceSaveFeedback':{PreferenceSaveFeedback,preferenceSaveReporter},'@tanstack/react-query':{useQuery:()=>({data:[]})},'../../api/real':{realApi:{}},'../../branchesRouting':{branchSettingsSection:()=> 'notifications'},'../WorkspaceSettingsView':{WorkspaceSettingsView:'Settings'},'../MutationNotifications':{useMutationNotification:()=>p.render().notify,MutationErrorDetails:'Details'},'../../clientId':{createClientId:()=>String(++id)},'../../api/productScope':{productApiPath:path=>'/branches'+path},
 });
 const save=patch=>{const tree=render();tree.props.children.at(-1).props.onPreferences(patch);return new Promise(resolve=>setImmediate(resolve));};
 const first=save({notifications:{directResponses:true,broadcasts:false}});jobs[0].reject(Error('Exact Settings Failure'));await first;
 assert.equal(p.render().snackbar.props.open,true);
 const sibling=save({notifications:{directResponses:false,broadcasts:true}});jobs[1].resolve();await sibling;
 assert.equal(p.render().snackbar.props.open,true,'a successful sibling never dismisses the failed leaf');
 const retry=save({notifications:{directResponses:true,broadcasts:true}});jobs[2].resolve();await retry;
 assert.equal(p.render().snackbar.props.open,false,'confirmed retry retires only satisfied leaf feedback');
 assert.deepEqual(jobs.map(job=>job.patch),[{notifications:{directResponses:true,broadcasts:false}},{notifications:{directResponses:false,broadcasts:true}},{notifications:{directResponses:true,broadcasts:true}}]);
});

for(const operation of ['save','allowance'])test(`actual Branch budget ${operation} definitive rejection then explicit retry retires the old feedback without reusing command authority`,async()=>{
 const p=provider();let mutations=[],id=0,fail=true;const requests=[];
 class RequestError extends Error{constructor(){super('Definitive budget rejection');this.status=409;}}
 const budget={revision:1,periodId:'exact-period',policy:{limit:100,period:'month'},allowance:0,heldCount:0};
 const render=branchComponent('BranchExecutionBudget.tsx','BranchExecutionBudget',{branchId:'exact-branch',settings:true},{
  '../WorkspaceQueryError':{WorkspaceQueryError:'QueryError'},'../../workspaceAvailability':{workspaceRead:()=>({})},'../../clientId':{createClientId:()=>String(++id)},
  '@tanstack/react-query':{useQuery:()=>({data:budget}),useQueryClient:()=>({invalidateQueries:async()=>{}}),useMutation:options=>{mutations.push(options);return{isPending:false,reset(){}};}},
  '../../api/real':{requestJson:async(url,request)=>{requests.push({url,body:JSON.parse(request.body)});if(fail)throw new RequestError();return budget;}},'../../api/types':{ApiRequestError:RequestError},'../MutationNotifications':{useMutationNotification:()=>p.render().notify,MutationErrorDetails:'Details'},'./BranchNavigation':{useBranchDraftGuard(){}},'./budgetPresentation':{budgetPresentation:()=>({message:'Budget'}),validBudgetNumber:value=>Number(value)>0},'../../api/productScope':{productApiPath:path=>path},
 });
 mutations=[];render();let options=mutations.at(operation==='save'?-2:-1);assert.ok(options);
 let refusal;try{await options.mutationFn();}catch(error){refusal=error;}assert.ok(refusal);options.onError(refusal);
 assert.equal(p.render().snackbar.props.open,true);
 fail=false;mutations=[];render();options=mutations.at(operation==='save'?-2:-1);
 const result=await options.mutationFn();options.onSuccess(result);
 assert.equal(requests.length,2);assert.notEqual(requests[0].body.commandKey,requests[1].body.commandKey,'definitive rejection retains the existing new-command retry policy');
 if(operation==='save'){assert.equal(p.render().snackbar.props.children.props.severity,'success','confirmed save replaces failure with its existing acknowledgment');p.render().snackbar.props.children.props.onClose();}
 assert.equal(p.render().snackbar.props.open,false,'confirmed explicit retry removes the obsolete failed presentation');
});

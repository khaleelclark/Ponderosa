import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import '../shared/web-typescript-loader.mjs';
import {deletionCleanupNotice} from '../../apps/web/src/components/deletionCleanupNotice.ts';
import {queryKeys} from '../../apps/web/src/queryKeys.ts';
import {realApi} from '../../apps/web/src/api/real.ts';

const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const ts = require('typescript'), React = require('react');
const widget = name => Object.assign(() => null, {displayName: name});
const mui = new Proxy({}, {get: (target, name) => target[name] ??= widget(name)});
function load(relative, imports) {
  const exports = {};
  const source = readFileSync(new URL('../../apps/web/src/' + relative, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  vm.runInNewContext(code, {exports, require: name => {
    if (name in imports) return imports[name];
    if (name === '@mui/material') return mui;
    if (name.startsWith('@mui/icons-material/')) return {__esModule:true, default:widget('Icon')};
    return require(name);
  }});
  return exports;
}
const client = {invalidateQueries:async()=>{}, removeQueries:()=>{}};
const stateReact = {...React, useMemo:fn=>fn(), useEffect(){}, useState:initial=>[typeof initial==='function'?initial():initial,()=>{}]};
const resource = {ResourceDeletionDialog:widget('ResourceDeletionDialog'), TextInputDialog:widget('TextInputDialog')};
const noticeModule = {deletionCleanupNotice};

test('Chat deletion API preserves pending and completed server outcomes without replay',async()=>{
  const previous=globalThis.fetch,calls=[];
  const outcomes=[
    {deleted:true,deletionReceiptId:'one',cleanupPending:true},
    {deleted:false,deletionReceiptId:'two',cleanupPending:true,deletionPending:true,retryable:true},
    {deleted:true,deletionReceiptId:'three',cleanupPending:false},
  ];
  globalThis.fetch=async(path,init)=>{
    calls.push({path,method:init.method});
    const body=outcomes[calls.length-1];
    return new Response(JSON.stringify(body),{status:body.deleted?200:202,headers:{'content-type':'application/json'}});
  };
  try{
    for(const [index,expected] of outcomes.entries())assert.deepEqual(await realApi.deleteConversation('chat-'+index,[]),expected);
    assert.deepEqual(calls.map(item=>item.method),['DELETE','DELETE','DELETE']);
  }finally{globalThis.fetch=previous;}
});

test('cleanup notice distinguishes removed, pending removal and completed cleanup',()=>{
  assert.match(deletionCleanupNotice('Chat',{deleted:true,cleanupPending:true}),/removed.*cleanup is still pending.*memory.*may remain/i);
  assert.match(deletionCleanupNotice('Chat',{deleted:false,cleanupPending:true}),/deletion is still pending/i);
  assert.equal(deletionCleanupNotice('Chat',{deleted:true,cleanupPending:false}),undefined);
  assert.match(deletionCleanupNotice('Agent',{deleted:true,cleanupPending:true}),/Agent removed/i);
});

test('sidebar deletion preserves navigation and warns only on pending cleanup',()=>{
  const mutations=[],notices=[],deleted=[],closed=[];
  const m=load('components/WorkspaceDialogs.tsx',{
    '@tanstack/react-query':{useMutation:options=>(mutations.push(options),{}),useQueryClient:()=>client},
    '../api':{api:{}},'../queryKeys':{queryKeys},'./ConfirmationDialogs':resource,
    './ChatDeletionDialog':{ChatDeletionDialog:widget('ChatDeletionDialog')},
    './MutationNotifications':{useMutationNotification:()=>notice=>notices.push(notice)},
    './deletionCleanupNotice':noticeModule,
  });
  const conversation={id:'chat-one',projectId:'project-one',title:'One'};
  m.SidebarConversationDialogs({action:{kind:'delete',conversation},onClose:()=>closed.push(true),onRenamed(){},onDeleted:c=>deleted.push(c.id)});
  const apply=result=>mutations[1].onSuccess(result,{conversation});
  apply({deleted:true,cleanupPending:true,deletionReceiptId:'receipt'});
  assert.deepEqual(deleted,['chat-one']);assert.equal(notices.length,1);assert.equal(notices[0].persistent,true);assert.match(notices[0].message,/memory.*may remain/i);
  apply({deleted:false,cleanupPending:true,deletionReceiptId:'receipt'});
  assert.deepEqual(deleted,['chat-one']);assert.equal(closed.length,1);assert.match(notices[1].message,/deletion is still pending/i);
  apply({deleted:true,cleanupPending:false,deletionReceiptId:'receipt'});
  assert.deepEqual(deleted,['chat-one','chat-one']);assert.equal(notices.length,2);
});

test('Agent deletion keeps logical removal and reports pending cleanup',()=>{
  const mutations=[],notices=[],deleted=[];
  const m=load('components/AgentDeletionDialog.tsx',{
    react:stateReact,'@mui/material':mui,
    '@tanstack/react-query':{useMutation:options=>(mutations.push(options),{}),useQueryClient:()=>client,useQuery:()=>({data:{affectedAgents:[],rootAgentIds:['agent'],previewHash:'hash'}})},
    '../api':{api:{}},'../queryKeys':{queryKeys},'./ConfirmationDialogs':resource,
    './MutationNotifications':{useMutationNotification:()=>notice=>notices.push(notice)},'./deletionCleanupNotice':noticeModule,
  });
  m.AgentDeletionDialog({open:true,projectId:'project',rootAgentIds:['agent'],onClose(){},onDeleted:ids=>deleted.push(...ids)});
  mutations[0].onSuccess({deleted:true,deletedAgentIds:['agent'],deletionReceiptId:'receipt',cleanupPending:true});
  assert.deepEqual(deleted,['agent']);assert.equal(notices.length,1);assert.equal(notices[0].persistent,true);assert.match(notices[0].message,/memory.*may remain/i);
  mutations[0].onSuccess({deleted:true,deletedAgentIds:[],deletionReceiptId:'receipt',cleanupPending:false});
  assert.equal(notices.length,1);
});

test('bulk Chat deletion reports pending removal separately from retained cleanup',async()=>{
  const mutations=[],notices=[],requests=[];
  const responses={one:{deleted:true,cleanupPending:true},two:{deleted:false,cleanupPending:true},three:{deleted:true,cleanupPending:false}};
  const m=load('components/ManageChatsWorkspace.tsx',{
    react:stateReact,'@mui/material':mui,
    '@tanstack/react-query':{useMutation:options=>(mutations.push(options),{}),useQueryClient:()=>client,useQuery:()=>({})},
    '../api':{api:{deleteConversation:async id=>(requests.push(id),responses[id])}},
    '../hooks/useManagedWorkspaceCollection':{useManagedWorkspaceCollection:()=>({rows:[],total:0,selected:new Map(),setSelected(){},visibleSelectedCount:0,allVisibleSelected:false,collectionComplete:true,toggleSelected(){},toggleSelectAll(){}})},
    '../hooks/useWorkspaceDirectory':{useWorkspaceDirectory:()=>({requestState:{}})},
    '../queryKeys':{queryKeys},'./CollectionPrimitives':{CollectionStateFeedback:widget('Feedback'),CollectionToolbar:widget('Toolbar'),CollectionWorkspace:widget('Workspace')},
    './ConfirmationDialogs':resource,'./MutationNotifications':{useMutationNotification:()=>notice=>notices.push(notice)},
  });
  m.ManageChatsWorkspace({onNavigate(){}});
  const previews=['one','two','three'].map(id=>({row:{conversation:{id},project:{id:'project'}},agents:[]}));
  const result=await mutations[0].mutationFn(previews);mutations[0].onSuccess(result);
  assert.deepEqual(requests,['one','two','three']);
  assert.deepEqual(Array.from(result.deleted,item=>item.row.conversation.id),['one','three']);
  assert.deepEqual(Array.from(result.pending,item=>item.row.conversation.id),['two']);
  assert.equal(notices.length,2);assert.match(notices[0].message,/deletion is still pending/i);assert.match(notices[1].message,/removed.*cleanup is pending/i);
  assert.ok(notices.every(notice=>notice.persistent));
});

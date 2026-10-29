import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url)),ts=require('typescript'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const source=readFileSync(new URL('../../apps/web/src/components/decisions/DecisionActions.tsx',import.meta.url),'utf8');
function fixture(mode='approval'){
 let open=false,response={},success,finish;const changes=[],buttons=[],dialogs=[],effects=[],calls=[];
 const decision={id:'exact-decision',mode,question:'Allow this action?',options:mode==='approval'?[{id:'allow',label:'Allow access'}]:[],allowOther:mode==='text',status:'pending'};
 const respond=async variables=>{calls.push(variables);response={...response,isPending:true,isError:false,isSuccess:false,variables};return new Promise((resolve,reject)=>{finish={resolve:value=>{response={...response,isPending:false,isSuccess:true,data:value};success();resolve(value)},reject:error=>{response={...response,isPending:false,isError:true,error};reject(error)}}})};
 response={isPending:false,isError:false,isSuccess:false,mutateAsync:respond};
 const primitive=({children})=>React.createElement('div',null,children),exports={};
 const scope={exports,Error,require:name=>name==='react'?{useState:()=>[open,value=>{open=value}],useEffect:fn=>effects.push(fn)}:name==='react/jsx-runtime'?require(name):name==='@mui/material'?{Alert:primitive,Stack:primitive,Button:props=>{buttons.push(props);return React.createElement('button',{disabled:props.disabled},props.children)}}:name==='../../hooks/useDecisionResponse'?{useDecisionResponse:callback=>{success=callback;return response}}:name==='../../decisions'?{decisionAcceptsText:value=>value.mode==='text'||value.allowOther,decisionTextActionLabel:()=> 'Answer'}:name==='./DecisionResponseDialog'?{DecisionResponseDialog:props=>{dialogs.push(props);return null}}:name==='./RuntimeElicitationActions'?{RuntimeElicitationActions:()=>null}:name==='./decisionResponse'?{settleDecisionResponse:async callback=>{try{return await callback()}catch{return undefined}}}:{} };
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,scope);
 const render=()=>{buttons.length=0;dialogs.length=0;return renderToStaticMarkup(React.createElement(exports.DecisionActions,{decision,onRetentionChange:(item,retain)=>changes.push({id:item.id,retain})}))};
 return{decision,changes,calls,render,flush:()=>effects.splice(0).forEach(fn=>fn()),button:label=>buttons.find(button=>button.children===label),dialog:()=>dialogs[0],finish:()=>finish,setResponse:value=>{response={...response,...value}}};
}

test('approval owner retains its exact pending/error retry after canonical resolution and releases only on confirmed success',async()=>{
 const f=fixture();f.render();const submitted=f.button('Allow access').onClick({stopPropagation(){}});assert.equal(f.changes.at(-1).retain,true,'Retention precedes the first response render');f.flush();assert.equal(f.changes.at(-1).retain,true,'An old idle effect cannot release a just-submitted response');
 f.render();f.flush();assert.equal(f.button('Allow access').disabled,true);f.finish().reject(Error('Approval recorded; applying access failed'));await submitted;
 f.decision.status='resolved';const failed=f.render();f.flush();assert.match(failed,/applying access failed/);assert.equal(f.changes.at(-1).retain,true);assert.equal(f.button('Allow access').disabled,false,'Existing exact approval retry remains visible');
 const retry=f.button('Allow access').onClick({stopPropagation(){}});assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1],f.calls[0]);f.finish().resolve({id:f.decision.id,status:'resolved'});await retry;f.render();f.flush();assert.equal(f.changes.at(-1).retain,false);
});

test('opening an unsent Answer retains its owner across pending-page changes and closing releases it',()=>{
 const f=fixture('text');f.render();f.button('Answer').onClick({stopPropagation(){}});assert.equal(f.changes.at(-1).retain,true);f.flush();assert.equal(f.changes.at(-1).retain,true);f.render();f.flush();assert.equal(f.dialog().open,true);assert.equal(f.changes.at(-1).retain,true);
 f.dialog().onClose();f.render();f.flush();assert.equal(f.changes.at(-1).retain,false);assert.equal(f.dialog().open,false);assert.equal(f.calls.length,0);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url)),ts=require('typescript');
const source=readFileSync(new URL('../../apps/web/src/components/ChatOverflowMenu.tsx',import.meta.url),'utf8');
function fixture({copy=async()=>{},transcript=()=>text}={}){
 const slots=[],effects=[],timers=new Map(),notices=[],copies=[],downloads=[];let index=0,dirty=false,tree,nextTimer=0;
 const react={useRef(value){const i=index++;return slots[i]??={current:value};},useState(value){const i=index++;if(!(i in slots))slots[i]=value;return[slots[i],next=>{slots[i]=typeof next==='function'?next(slots[i]):next;dirty=true;}];},useEffect(fn,deps){const i=index++,old=slots[i];if(!old||deps.some((v,j)=>!Object.is(v,old.deps[j]))){slots[i]={deps,cleanup:old?.cleanup};effects.push(()=>{slots[i].cleanup?.();slots[i].cleanup=fn();});}}};
 const exports={};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,Error,setTimeout(fn){const id=++nextTimer;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),require:name=>name==='react'?react:name==='react/jsx-runtime'?require(name):name==='@mui/material'?new Proxy({},{get:(_,name)=>String(name)}):name==='../clipboard'?{copyText:async value=>{copies.push(value);return copy(value);}}:name==='../chatTranscript'?{downloadMarkdownTranscript:(...args)=>downloads.push(args)}:name==='./MutationNotifications'?{useMutationNotification:()=>notice=>notices.push(notice)}:{__esModule:true,default:name}});
 const props={label:'Chat actions',actions:[],transcriptMarkdown:transcript,transcriptFileName:'owned.md'};
 function render(){do{dirty=false;index=0;tree=exports.ChatOverflowMenu(props);for(const fn of effects.splice(0))fn();}while(dirty);return tree;}
 function* walk(node){if(!node||typeof node!=='object')return;if(Array.isArray(node)){for(const child of node)yield* walk(child);}else if(node.props){yield node;yield* walk(node.props.children);}}
 const nodes=()=>[...walk(render())],find=predicate=>{const node=nodes().find(predicate);assert.ok(node,'Expected node');return node;};
 const button=()=>find(n=>n.type==='IconButton');
 const item=label=>find(n=>n.type==='MenuItem'&&[...walk(n)].some(c=>c.type==='ListItemText'&&c.props.children===label));
 const action=kind=>{button().props.onClick({currentTarget:{isConnected:true}});item(kind).props.onClick();find(n=>n.type==='Menu').props.TransitionProps.onExited();item('Chat Transcript').props.onClick();render();};
 return{nodes,button,action,notices,copies,downloads,timers,async flush(){await new Promise(setImmediate);render();},copied(){return find(n=>n.props.role==='status').props.children;},unmount(){for(const slot of slots)slot?.cleanup?.();},expire(){const rows=[...timers];for(const[id,fn]of rows){timers.delete(id);fn();}render();}};
}
const text='# Synthetic Team transcript\n\nExact λ😀 bytes\n';
test('transcript copy uses the actual submenu payload and reserved local success, including repeat-copy',async()=>{
 const f=fixture();assert.equal(f.button().props['aria-label'],'Chat actions');f.action('Copy');await f.flush();
 assert.deepEqual(f.copies,[text]);assert.equal(f.copied(),'Copied');assert.deepEqual(f.notices,[]);assert.equal(f.timers.size,1);
 assert.equal(f.button().props['aria-label'],'Chat actions');assert.equal(f.nodes().find(n=>n.type==='Tooltip').props.title,'Copied');
 const timer=[...f.timers.keys()][0];f.action('Copy');await f.flush();assert.deepEqual(f.copies,[text,text]);assert.equal(f.timers.size,1);assert.notEqual([...f.timers.keys()][0],timer);
 f.expire();assert.equal(f.copied(),'');f.action('Copy');await f.flush();assert.equal(f.timers.size,1);f.unmount();assert.equal(f.timers.size,0);
});
test('copy completion after unmount never creates local feedback or a global success notice',async()=>{
 let complete;const f=fixture({copy:()=>new Promise(resolve=>complete=resolve)});f.action('Copy');f.unmount();complete();await f.flush();
 assert.equal(f.copied(),'');assert.deepEqual(f.notices,[]);assert.equal(f.timers.size,0);
});
test('copy errors and lazy preparation failures retain their existing error notices; download is unchanged',async()=>{
 const f=fixture({copy:async()=>{throw Error('Clipboard refused');}});f.action('Copy');await f.flush();assert.equal(f.copied(),'');assert.equal(f.notices[0].severity,'error');assert.equal(f.notices[0].key,'copy-transcript');assert.equal(f.notices[0].message,'Clipboard refused');f.unmount();
 const broken=fixture({transcript:()=>{throw Error('Preparation refused');}});broken.action('Copy');assert.equal(broken.copies.length,0);assert.equal(broken.notices[0].message,'Preparation refused');assert.equal(broken.notices[0].severity,'error');broken.unmount();
 const download=fixture();download.action('Download');assert.deepEqual(download.downloads,[[text,'owned.md']]);assert.equal(download.copies.length,0);assert.deepEqual(download.notices,[]);download.unmount();
});

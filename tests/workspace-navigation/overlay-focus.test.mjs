import test from 'node:test';
import assert from 'node:assert/strict';
import {restoreOverlayFocus} from '../../apps/web/src/overlayFocus.ts';

test('overlay exit restores a usable trigger, otherwise visible navigation only after animation frame',()=>{
 const calls=[],frames=[];
 const element=(name,{connected=true,visible=true,hidden=false}={})=>({isConnected:connected,getClientRects:()=>visible?[{}]:[],closest:()=>hidden?{}:null,focus:()=>calls.push(name)});
 const priorWindow=globalThis.window,priorDocument=globalThis.document;
 globalThis.window={requestAnimationFrame:callback=>frames.push(callback)};
 const hidden=element('hidden',{hidden:true}),invisible=element('invisible',{visible:false}),fallback=element('navigation');
 globalThis.document={querySelectorAll:selector=>{assert.equal(selector,'test-navigation');return [hidden,invisible,fallback]}};
 try{
  restoreOverlayFocus(element('trigger'),'test-navigation');assert.deepEqual(calls,[]);frames.shift()();assert.deepEqual(calls,['trigger']);
  for(const options of [{connected:false},{visible:false},{hidden:true}]){restoreOverlayFocus(element('unusable',options),'test-navigation');frames.shift()();}
  restoreOverlayFocus(undefined,'test-navigation');frames.shift()();
  assert.deepEqual(calls,['trigger','navigation','navigation','navigation','navigation']);
  globalThis.document.querySelectorAll=()=>[hidden,invisible];restoreOverlayFocus(undefined,'test-navigation');frames.shift()();assert.equal(calls.length,5);
 }finally{globalThis.window=priorWindow;globalThis.document=priorDocument;}
});

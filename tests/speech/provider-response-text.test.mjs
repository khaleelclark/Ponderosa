import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexResponseText, projectAgentEvent, mapCodexAppServerNotification } from '../../packages/engines/dist/index.js';
const start = (map,id='turn') => map.map('turn/started',{threadId:'thread',turn:{id}});
const item = (id='item',phase='final_answer',text='')=>({type:'agentMessage',id,phase,text});
test('qualified ordered Unicode deltas reconcile with completed snapshot, never generic Work log',()=>{
 const map=new CodexResponseText('thread');start(map);
 const events=[...map.map('item/started',{threadId:'thread',turnId:'turn',item:item()}),
  ...['Café ', '你好. '].flatMap(delta=>map.map('item/agentMessage/delta',{threadId:'thread',turnId:'turn',itemId:'item',delta})),
  ...map.map('item/completed',{threadId:'thread',turnId:'turn',item:item('item','final_answer','Café 你好. Tail')})];
 assert.deepEqual(events.map(e=>e.kind),['start','delta','delta','complete']);
 assert.deepEqual(events.map(e=>projectAgentEvent(e)),events);
 assert.equal(events[3].text,'Café 你好. Tail');
 assert.deepEqual(map.map('item/agentMessage/delta',{threadId:'thread',turnId:'turn',itemId:'item',delta:'late'}),[]);
});
test('foreign threads/turns, unknown items, reasoning and tool outputs never qualify',()=>{
 const map=new CodexResponseText('thread');start(map);
 for(const patch of [{threadId:'foreign'},{turnId:'old'},{itemId:'other'}])assert.deepEqual(map.map('item/agentMessage/delta',{threadId:'thread',turnId:'turn',itemId:'item',delta:'secret',...patch}),[]);
 assert.deepEqual(map.map('item/started',{threadId:'thread',turnId:'turn',item:{type:'reasoning',id:'reason',text:'private'}}),[]);
 assert.deepEqual(map.map('item/commandExecution/outputDelta',{threadId:'thread',turnId:'turn',delta:'secret'}),[]);
});
test('missing phase stays unknown; completed phase can qualify only the complete snapshot',()=>{
 const map=new CodexResponseText('thread');start(map);
 assert.equal(map.map('item/started',{threadId:'thread',turnId:'turn',item:item('x',null)})[0].phase,'unknown');
 assert.equal(map.map('item/agentMessage/delta',{threadId:'thread',turnId:'turn',itemId:'x',delta:'hi'})[0].phase,'unknown');
 start(map,'next');assert.deepEqual(map.map('item/completed',{threadId:'thread',turnId:'turn',item:item('x','final_answer','late')}),[]);
});
test('new normalized candidate is closed and accessor-free',()=>{
 const good={type:'response_text',providerTurnId:'t',itemId:'i',phase:'unknown',kind:'delta',text:'hi'};
 for(const change of [{phase:'reasoning'},{kind:'raw'},{audience:'user'}])assert.throws(()=>projectAgentEvent({...good,...change}));
 assert.throws(()=>projectAgentEvent({...good,get text(){throw Error('getter')}}));
});

test('installed native start mapping fences work before output, retaining ordinary projections',()=>{
 for(const item of [{id:'cmd',type:'commandExecution',command:'inert',cwd:'/fixture'}, {id:'edit',type:'fileChange',changes:[]}, {id:'unknown-cmd',type:'commandExecution'}]){
  const start=mapCodexAppServerNotification({method:'item/started',params:{item}},'/fixture');
  assert.deepEqual(start[0],{type:'work_start',kind:item.type==='fileChange'?'file_change':'command',callId:item.id});
  assert.deepEqual(projectAgentEvent(start[0]),start[0]);
  if(item.command)assert.equal(start[1].type,'command');else assert.equal(start.length,1);
 }
 const completed=mapCodexAppServerNotification({method:'item/completed',params:{item:{id:'edit',type:'fileChange',changes:[{path:'file',kind:'edit',diff:'inert'}]}}},'/fixture');
 assert.deepEqual(completed,[{type:'work_start',kind:'file_change',callId:'edit'},{type:'file_change',path:'file',kind:'edit',diff:'inert',callId:'edit'}]);
 assert.throws(()=>projectAgentEvent({type:'work_start',kind:'foreign'}));
 assert.throws(()=>projectAgentEvent({type:'work_start',kind:'file_change',text:'secret'}));
 assert.throws(()=>projectAgentEvent({type:'work_start',kind:'file_change',get callId(){throw Error('getter')}}));
});

test('voice acknowledgement receipt normalizes in the engine, independent of JSON key order',()=>{
 const map=(item)=>mapCodexAppServerNotification({method:'item/completed',params:{item:{type:'dynamicToolCall',id:'auth',tool:'ponderosa_voice_reply',success:true,...item}}},'/fixture')[0];
 const contentItems=[{text:JSON.stringify({streamId:'exact-stream',authorized:true}),type:'inputText'}];
 const ack=map({contentItems});assert.equal(ack.voiceReplyStreamId,'exact-stream');assert.deepEqual(projectAgentEvent(ack),ack);
 for(const patch of [{tool:'foreign.ponderosa_voice_reply',contentItems},{success:false,contentItems},{contentItems:[{type:'inputText',text:'authorized prose'}]},{contentItems:[{type:'inputText',text:JSON.stringify({authorized:false,streamId:'exact-stream'})}]}])assert.equal(map(patch).voiceReplyStreamId,undefined);
 assert.throws(()=>projectAgentEvent({...ack,isError:true}));
 assert.throws(()=>projectAgentEvent({...ack,isError:undefined}));
});

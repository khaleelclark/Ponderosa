import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import {registerConversationDeliveryRoutes} from '../dist/routes/conversation-deliveries.js';
import {createServerReadModels} from '../dist/server-read-models.js';

function fixture(t,kind) {
  const app=Fastify();t.after(()=>app.close());
  const chat={id:'chat',projectId:'project',archived:false};
  const agent={id:'agent',projectId:'project',conversationId:'chat',title:'Arches',handle:'Arches',archived:false};
  let runtime,message,fail=false,records=0;
  const store={
    getConversation:()=>chat, listAgents:()=>[agent], getAgent:()=>agent,
    getConversationMessageByReceiptKey:()=>message,
    getProjectedConversationMessageById:()=>message,
    getCommunicationEvent:()=>runtime?.payload.communication,
  };
  const coordinationV3={
    runtimeCommunication:()=>runtime,
    runtimeArtifact:()=>undefined,
    activation:()=>({id:'activation',state:'pending'}),
    deliveryReceiptsForCommunications:()=>new Map(),
    requestSummariesForCommunications:()=>new Map(),
    recordRuntimeCommunication:input=>{
      records++;
      runtime={...input,activations:[{id:'activation',agentId:agent.id}],createdAt:input.now};
      runtime.payload.communication.identity={recipientLabels:{agent:'Arches'},recipientHandles:{agent:'Arches'}};
      return {replayed:false,activations:runtime.activations};
    },
  };
  const {withMessagePresentation}=createServerReadModels({store,coordinationV3});
  registerConversationDeliveryRoutes(app,{
    store,coordinationV3,assets:{removeRuntimeArtifactReservation:()=>false},
    withMessagePresentation:(project,messages)=>{if(fail)throw Error('Injected presentation failure');return withMessagePresentation(project,messages);},
    projectDeletionInProgress:()=>false,agentDeletionInProgress:()=>false,
    conversationDeliveryLeases:new Map(),agentDeliveryLeases:new Map(),
    prepareUserCommunicationText:async({text})=>({canonicalText:text,publishedText:text}),
    reconcileRuntimeCommunicationProjections:async()=>{
      message={id:runtime.id,conversationId:'chat',communicationEventId:runtime.id,role:'user',text:runtime.payload.communication.text,createdAt:runtime.createdAt};
      return 1;
    },
    appendWorkspace:()=>{},publishCoordinationV3Changed:()=>{},notifyScheduler:()=>{},
  });
  const binding={projectId:'project',agentId:'agent',handle:'Arches',currentHandle:'Arches',currentTitle:'Arches'};
  const payload={text:'#Arches hello',idempotencyKey:'same-send',...(kind==='direct'?{recipients:[{agentId:'agent'}]}:{recipientAgentMentions:[binding]})};
  const send=()=>app.inject({method:'POST',url:`/api/conversations/chat/${kind==='direct'?'direct-messages':'messages'}`,payload});
  return {send,agent,setFailure:value=>{fail=value;},records:()=>records,expected:()=>withMessagePresentation('project',[message])[0]};
}

for(const kind of ['direct','broadcast']) {
  test(`${kind} first send and replay have the same mention presentation as the read model`,async t=>{
    const f=fixture(t,kind);
    for(const replay of [false,true]) {
      if(replay){f.agent.handle='Renamed';f.agent.title='Renamed Agent';}
      const response=await f.send();assert.equal(response.statusCode,200,response.body);
      const message=kind==='direct'?response.json().message:response.json();
      assert.deepEqual(message,f.expected());
      assert.equal(message.agentMentions[0].agentId,'agent');
      assert.equal(message.agentMentions[0].handle,'Arches');
      assert.equal(message.agentMentions[0].currentHandle,replay?'Renamed':'Arches');
      assert.equal(f.records(),1,'Replay must not create a second intake');
    }
  });
  test(`${kind} presentation failure remains committed and can recover on replay`,async t=>{
    const f=fixture(t,kind);f.setFailure(true);
    for(let attempt=0;attempt<2;attempt++) {
      const response=await f.send();assert.equal(response.statusCode,202,response.body);
      assert.equal(response.json().committed,true);
      assert.equal(response.json().recovering,true);
      assert.equal(response.json().message,undefined);
    }
    f.setFailure(false);
    const response=await f.send();assert.equal(response.statusCode,200,response.body);
    const message=kind==='direct'?response.json().message:response.json();
    assert.deepEqual(message,f.expected());assert.equal(f.records(),1);
  });
}

test('opening presentation uses exact identity, not prose, and clears stale bindings for deleted or wrong-Project Agents', () => {
  const agent = { id: 'created', projectId: 'project', handle: 'Boston', title: 'Boston' };
  let current = agent;
  const communication = { schemaVersion: 2, projectId: 'project', eventId: 'agent-opening:created',
    intent: 'broadcast', sender: { kind: 'user', id: 'operator' }, audience: { kind: 'project' } };
  const store = { listAgents: () => current ? [current] : [], getAgent: id => id === agent.id ? current : undefined,
    getCommunicationEvent: () => communication };
  const coordinationV3 = { deliveryReceiptsForCommunications: () => new Map(), requestSummariesForCommunications: () => new Map() };
  const { withMessagePresentation } = createServerReadModels({ store, coordinationV3 });
  const message = { communicationEventId: communication.eventId, text: '#new-agent unchanged text' };
  const read = () => withMessagePresentation('project', [message])[0];
  assert.equal(read().agentMentions[0].agentId, 'created');
  message.agentMentions = read().agentMentions;
  current = undefined;
  assert.deepEqual(read().agentMentions, [], 'missing Agent cannot retain a clickable opening binding');
  current = { ...agent, projectId: 'another-project' };
  assert.deepEqual(read().agentMentions, [], 'same-looking cross-Project Agent cannot supply the binding');
  current = agent; communication.eventId = 'ordinary-communication';
  delete message.agentMentions;
  assert.equal(read().agentMentions, undefined, 'ordinary reserved prose is not an opening');
  communication.eventId = 'agent-opening:missing';
  assert.deepEqual(read().agentMentions, [], 'another existing Agent cannot substitute for the exact missing identity');
  assert.equal(read().text, message.text);
});

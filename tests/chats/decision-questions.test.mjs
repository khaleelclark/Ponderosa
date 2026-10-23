import { createRequire } from 'node:module';
import test from 'node:test';import assert from 'node:assert/strict';
const root=new URL('../../',import.meta.url);
const Fastify=createRequire(new URL('apps/server/package.json',root))('fastify');
const {registerAgentDecisionRoutes}=await import(new URL('apps/server/dist/routes/agent-decisions.js',root));
async function ask(body){const app=Fastify(),agent={id:'a',projectId:'p',title:'QA',conversationId:'c'},cap={agentId:'a',runId:'r',v3SchedulerRunId:'r',availableToolNames:['ponderosa_decision']};let created;
registerAgentDecisionRoutes(app,{store:{getAgent:()=>agent},workspace:{cursor:()=>0,createDecision:x=>(created={...x,id:'d',status:'pending'}),createNotification(){}},coordinationV3:{steeringInjectionIds:()=>[],outboundAwaitingQuestionRequestIdsAttachedToRun:()=>[],requiredReplyObligationsForRun:()=>[]},agentMessageCapabilities:new Map([['qa',cap]]),activeRuns:new Map([['a',{messageCapability:'qa',runId:'r',conversationId:'c'}]]),capabilityOwnsAuthoritativeRun:()=>true,publishWorkspaceSince(){}});
try{return {response:await app.inject({method:'POST',url:'/api/agent-decisions',headers:{authorization:'Bearer qa'},payload:{blocking:false,...body}}),created};}finally{await app.close();}}
test('UI019 full final sentence survives the creation boundary',async()=>{const question='x'.repeat(1000)+' Final sentence 😀';const {response}=await ask({question});assert.equal(response.statusCode,201);assert.equal(response.json().question,question);});
test('UI019 three stable structured questions share one Decision',async()=>{const questions=[1,2,3].map(i=>({id:'q'+i,question:'Question '+i,mode:'text'}));const {response}=await ask({questions});assert.equal(response.statusCode,201,response.body);assert.equal(response.json().questions.length,3);});

for(const symbol of ['x','😀']) for(const length of [10000,10001]) test(`UI019 ${length} Unicode code points (${symbol.length} code units)`,async()=>{
 const question=symbol.repeat(length),{response,created}=await ask({question});assert.equal(response.statusCode,length===10000?201:400,response.body);
 if(length===10000)assert.equal(response.json().question,question);else assert.equal(created,undefined,'Rejected before canonical creation');
});
for(const count of [0,1,2,3,4]) test(`UI019 structured question count ${count}`,async()=>{const questions=Array.from({length:count},(_,i)=>({id:'q'+i,question:'Question '+i}));const {response,created}=await ask({questions});assert.equal(response.statusCode,count>=1&&count<=3?201:400,response.body);if(response.statusCode===400)assert.equal(created,undefined);});
for(const body of [{questions:[{id:'q',question:'One'},{id:'q',question:'Two'}]},{questions:[{id:'q',question:'Approval',mode:'approval'}]},{question:'Mixed',questions:[{id:'q',question:'One'}]},{questions:[{id:'q',question:'x'.repeat(10001)}]}])test('UI019 rejects ambiguous/oversized/scoped approval groups before creation',async()=>{const {response,created}=await ask(body);assert.equal(response.statusCode,400,response.body);assert.equal(created,undefined);});

test('UI019 managed tool shares the Unicode prompt and question-count boundaries',async()=>{const {PONDEROSA_DECISION_TOOL,DECISION_QUESTION_MAX_CODE_POINTS,DECISION_MAX_QUESTIONS}=await import('@ponderosa/core');const schema=PONDEROSA_DECISION_TOOL.inputSchema;assert.equal(schema.properties.question.maxLength,10000);assert.equal(schema.properties.questions.items.properties.question.maxLength,DECISION_QUESTION_MAX_CODE_POINTS);assert.equal(schema.properties.questions.maxItems,DECISION_MAX_QUESTIONS);});

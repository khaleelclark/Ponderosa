import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { CoordinationIdempotencyConflictError } from "@ponderosa/agents";
import { registerProviderCommandRoutes } from "../dist/routes/provider-commands.js";

test("Stop maps idempotency reuse for a different Run to 409", async (t) => {
  const app = Fastify();
  registerProviderCommandRoutes(app, {
    coordinationV3: {
      cancelAgentRun() {
        throw new CoordinationIdempotencyConflictError();
      },
    },
    activeRuns: new Map(),
    serverContext: { store: {} },
  });
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/agents/agent-a/cancel",
    payload: { targetRunId: "run-two", idempotencyKey: "run-one-key" },
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.deepEqual(response.json(), {
    error: "the cancellation key belongs to a different Run",
    cancelled: false,
    replayed: false,
  });
});

test("cold Agent provider commands use Chat defaults and working directory",async(t)=>{
  const app=Fastify();t.after(()=>app.close());let observed;
  const chat={id:"project",defaultEngine:"codex",defaultModel:"chat-model",defaultEffort:"high",hostPath:"/chat"};
  const adapter={id:"codex",displayName:"Test",listModels:()=>[{id:"chat-model",label:"Chat"},{id:"project-model",label:"Legacy"}],listEfforts:()=>[{id:"high",label:"High"}],openSession:input=>{observed={model:input.model,effort:input.effort,cwd:input.cwd};throw new Error("probe: no provider execution");}};
  registerProviderCommandRoutes(app,{
    serverContext:{store:{}},
    store:{getAgent:()=>({id:"agent",projectId:"project",conversationId:"chat",activeEngine:"codex"}),getChatContext:()=>chat,getProject:()=>{throw Error("legacy context must not be used");},getRuns:()=>[],resumeSessionState:()=>undefined},
    workspace:{getPreferences:()=>({})},engines:new Map([["codex",{adapter}]]),activeRuns:new Map(),
    workingCopies:{beginUse:()=>()=>{},resolve:async(_agent,context)=>({id:"working",rootPath:context.hostPath}),assertRunAdmission:()=>{}},
    deletingProjectIds:new Set(),deletingAgentIds:new Set(),engineCapabilityDiscoveryAuthorities:new Set(),isClosed:()=>false,
    retireCompletedContextRolloverSession:async()=>{},reusableRuntime:()=>undefined,cachedModelOptions:()=>[],closeCapabilityDiscoveryAuthority:async()=>{},
  });
  const response=await app.inject({method:"POST",url:"/api/agents/agent/provider-commands",payload:{name:"status"}});
  assert.equal(response.statusCode,409);assert.deepEqual(observed,{model:"chat-model",effort:"high",cwd:"/chat"});
});

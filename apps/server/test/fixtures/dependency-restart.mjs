import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";
const [directory, phase, suppliedRoot] = process.argv.slice(2);
const root = suppliedRoot ?? fileURLToPath(new URL("../../../../", import.meta.url));
const load = path => import(pathToFileURL(resolve(root, path)));
const { AgentStore, CoordinationV3Store } = await load("packages/agents/dist/index.js");
const { createServer } = await load("apps/server/dist/app.js");
const store = new AgentStore(directory), c = new CoordinationV3Store(store.sqlite);
const app = createServer({ dataDir: directory, store, engines: [{ adapter: { id: "codex", displayName: "Synthetic", listModels: () => [], listEfforts: () => [] } }], logger: false, startDrained: true });
const acknowledge = lease => { const input = { injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken }; c.preparePromptInjection({ ...input, prompt: "Synthetic exact restart qualification" }); c.markPromptSubmitted(input); c.acknowledgePromptInjection(input); };
const authorization = lease => ({ runId: lease.runId, agentId: lease.agentId, fencingToken: lease.fencingToken });
try {
  await app.ready();
  if (phase === "before") {
    const p = store.createProject({ label: "Synthetic", hostPath: directory, defaultEngine: "codex" });
    const chat = store.createConversation(p.id, { title: "Synthetic" });
    const owner = store.createAgent(p.id, { title: "Owner", engine: "codex", conversationId: chat.id });
    const child = store.createAgent(p.id, { title: "Child", engine: "codex", conversationId: chat.id });
    c.coordinate({ projectId: p.id, conversationId: chat.id, actorScope: "user:local-operator", idempotencyKey: "parent", requests: [{ requestId: "parent", recipientAgentId: owner.id, lifetime: { kind: "indefinite" }, payload: {} }] });
    const run = c.leaseNextRun({ workerId: "owner" }); acknowledge(run);
    c.coordinate({ projectId: p.id, conversationId: chat.id, requesterAgentId: owner.id, actorScope: `agent:${owner.id}:run:${run.runId}`, runAuthorization: authorization(run), idempotencyKey: "child", requests: [{ requestId: "child", recipientAgentId: child.id, lifetime: { kind: "indefinite" }, payload: {} }], join: { id: "dependency", mode: "all", continuationRequestIds: ["parent"] } });
    const childRun = c.leaseNextRun({ workerId: "child" }); acknowledge(childRun);
    c.updateRequest({ requestId: "child", updateId: "child-result", kind: "completed", actor: { kind: "agent", id: child.id }, runAuthorization: authorization(childRun), payload: {} }); c.completeRun(childRun.runId, childRun.fencingToken);
    c.updateRequest({ requestId: "parent", updateId: "progress", kind: "progress", actor: { kind: "agent", id: owner.id }, runAuthorization: authorization(run), payload: {} }); c.completeRun(run.runId, run.fencingToken);
    console.log(JSON.stringify({ phase, pid: process.pid, parentState: c.getRequest("parent").state, ownerId: owner.id, openingActivationId: run.activationIds[0] }));
  } else {
    const ownerId = c.getRequest("parent").recipientAgentId;
    const wake = c.leaseNextRun({ workerId: "owner" }); acknowledge(wake);
    c.updateRequest({ requestId: "parent", updateId: "terminal", kind: "completed", actor: { kind: "agent", id: ownerId }, runAuthorization: authorization(wake), payload: { text: "one exact joined result" } }); c.completeRun(wake.runId, wake.fencingToken);
    console.log(JSON.stringify({ phase, pid: process.pid, parentState: c.getRequest("parent").state, ownerId, wakeKind: wake.activations[0].kind,
      parentCount: store.sqlite.prepare("SELECT COUNT(*) n FROM coordination_requests WHERE id='parent'").get().n,
      terminalCount: store.sqlite.prepare("SELECT COUNT(*) n FROM coordination_request_updates WHERE request_id='parent' AND kind='completed'").get().n,
      wakeCount: store.sqlite.prepare("SELECT COUNT(*) n FROM activation_sources WHERE source_kind='join' AND source_id='dependency'").get().n,
      remaining: Boolean(c.leaseNextRun({ workerId: "owner" })) }));
  }
} finally { app.prepareForShutdown(); await app.close(); store.close(); }

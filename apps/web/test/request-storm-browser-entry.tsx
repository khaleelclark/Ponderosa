import { useQuery, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { api } from "../src/api";
import { useAgentStream } from "../src/hooks/useAgentStream";
import { useWorkspaceStream } from "../src/hooks/useWorkspaceStream";
import { queryKeys } from "../src/queryKeys";

const counters = { roster: 0, health: 0, directory: 0, details: 0, task: 0, capabilities: 0, chat: 0, delivery: 0 };
const apiLatencies: number[] = [];
let terminal = false;
let chatReply = "waiting";
let deliveryState = "preparing";
let failNextPhaseFetch = false;
let agentCommandEnabled = false;
async function probeApi(): Promise<void> {
  const start = performance.now();
  const response = await fetch("/api/storm-probe");
  if (!response.ok) throw new Error(`probe returned ${response.status}`);
  apiLatencies.push(performance.now() - start);
}

api.subscribeWorkspace = (_cursor, handlers) => {
  let seq = 0;
  const status = setTimeout(() => handlers.onStatus?.({ instanceId: "storm", cursor: 0, reset: false }), 20);
  const emitCommand = () => handlers.onEvent({
    id: ++seq,
    ts: new Date().toISOString(),
    event: {
      type: "agent_event",
      projectId: "P1",
      agentId: `Agent ${seq % 12}`,
      conversationIds: [],
      seq,
      eventType: "command",
      category: "task",
    },
  });
  const emitCoordination = () => handlers.onEvent({
    id: ++seq,
    ts: new Date().toISOString(),
    event: {
      type: "coordination_changed",
      projectId: "P1",
      agentId: `Agent ${seq % 12}`,
      conversationIds: [],
    },
  });
  const emitCapabilities = () => handlers.onEvent({
    id: ++seq,
    ts: new Date().toISOString(),
    event: { type: "runtime_capabilities_changed", projectId: "P1", engineId: "codex" },
  });
  let command = setInterval(emitCommand, 20);
  Object.assign(window, {
    stormCounters: () => ({ ...counters }),
    stormApiLatencies: () => [...apiLatencies],
    stormFailNextPhaseFetch: () => { failNextPhaseFetch = true; },
    stopStorm: () => clearInterval(command),
    startAgentStorm: () => { agentCommandEnabled = true; },
    stopAgentStorm: () => { agentCommandEnabled = false; },
    startCapabilitiesStorm: () => {
      clearInterval(command);
      emitCapabilities();
      command = setInterval(emitCapabilities, 20);
    },
    startCoordinationStorm: () => {
      clearInterval(command);
      emitCoordination();
      command = setInterval(emitCoordination, 20);
    },
    startSparseStorm: () => {
      clearInterval(command);
      command = setInterval(emitCommand, 900);
    },
    terminalStorm: () => {
      terminal = true;
      handlers.onEvent({
        id: ++seq,
        ts: new Date().toISOString(),
        event: {
          type: "agent_event", projectId: "P1", agentId: "Agent 1",
          conversationIds: [], seq, eventType: "agent_lifecycle", category: "lifecycle",
        },
      });
    },
    replayCompletedChat: () => {
      chatReply = "Agent replied";
      deliveryState = "processed";
      handlers.onError?.(new Event("error"));
      handlers.onStatus?.({ instanceId: "storm", cursor: seq + 2, reset: false });
      for (const event of [
        { type: "conversation_changed", projectId: "P1", conversationId: "Chat 1", action: "message" },
        { type: "message_delivery_changed", projectId: "P1", agentId: "Agent 1", conversationIds: ["Chat 1"] },
      ]) handlers.onEvent({ id: ++seq, ts: new Date().toISOString(), replayed: true, event });
    },
    replayChatBurst: () => {
      chatReply = "Revised reply";
      for (let index = 0; index < 100; index += 1) {
        handlers.onEvent({
          id: ++seq,
          ts: new Date().toISOString(),
          replayed: true,
          event: { type: "conversation_changed", projectId: "P1", conversationId: "Chat 1", action: "message" },
        });
      }
    },
    emitLiveChat: () => {
      chatReply = "Latest live reply";
      deliveryState = "processed again";
      handlers.onEvent({
        id: ++seq,
        ts: new Date().toISOString(),
        event: { type: "conversation_changed", projectId: "P1", conversationId: "Chat 1", action: "message" },
      });
      handlers.onEvent({
        id: ++seq,
        ts: new Date().toISOString(),
        event: { type: "message_delivery_changed", projectId: "P1", agentId: "Agent 1", conversationIds: ["Chat 1"] },
      });
    },
  });
  return { close: () => { clearTimeout(status); clearInterval(command); } };
};

api.subscribeAgent = (agentId, _cursor, handlers) => {
  let seq = 0;
  const status = setTimeout(() => {
    handlers.onOpen?.();
    handlers.onStatus?.({ agentId, instanceId: "storm-agent", cursor: 0, reset: false });
  }, 20);
  const command = setInterval(() => {
    if (!agentCommandEnabled) return;
    handlers.onEvent({
      agentId, seq: ++seq, ts: new Date().toISOString(),
      event: { type: "command", command: "pwd", cwd: "/tmp" },
    });
  }, 20);
  return { close: () => { clearTimeout(status); clearInterval(command); } };
};

const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
function Probe() {
  const connection = useWorkspaceStream();
  useAgentStream("Active Agent", "P1");
  const roster = useQuery({
    queryKey: queryKeys.agents.project("P1"),
    queryFn: async () => { counters.roster += 1; await probeApi(); return terminal ? "terminal" : "working"; },
  });
  useQuery({
    queryKey: queryKeys.agents.health("P1"),
    queryFn: async () => {
      counters.health += 1;
      await probeApi();
      if (failNextPhaseFetch) {
        failNextPhaseFetch = false;
        throw new Error("injected transient phase read failure");
      }
      return terminal ? "terminal" : "working";
    },
  });
  useQuery({
    queryKey: queryKeys.workspaceDirectory.list("agent", "", undefined, undefined, undefined, undefined, true, undefined, undefined),
    queryFn: async () => { counters.directory += 1; await probeApi(); return terminal ? "terminal" : "working"; },
  });
  useQuery({
    queryKey: queryKeys.agents.project("P2"),
    queryFn: async () => { await probeApi(); return "unrelated"; },
  });
  useQuery({
    queryKey: queryKeys.workspaceStatus.agent("Agent 1"),
    queryFn: async () => { counters.task += 1; await probeApi(); return "task"; },
  });
  useQuery({
    queryKey: queryKeys.engines.capabilities("P1"),
    queryFn: async () => { counters.capabilities += 1; await probeApi(); return "capabilities"; },
  });
  const chat = useQuery({
    queryKey: queryKeys.conversations.detail("Chat 1"),
    queryFn: async () => { counters.chat += 1; await probeApi(); return chatReply; },
  });
  const delivery = useQuery({
    queryKey: queryKeys.conversations.activeDeliveryReceipts("Chat 1", "Message 1", ""),
    queryFn: async () => { counters.delivery += 1; await probeApi(); return deliveryState; },
  });
  return <><span id="roster">{roster.data}</span><span id="phase">{String(connection.phaseEvidenceFresh)}</span><span id="chat">{chat.data}</span><span id="delivery">{delivery.data}</span><AgentDetails /></>;
}
function AgentDetails() {
  return <>{Array.from({ length: 12 }, (_, index) => <AgentDetail key={index} index={index} />)}</>;
}
function AgentDetail({ index }: { index: number }) {
  useQuery({
    queryKey: queryKeys.agents.detailPrefix(`Agent ${index}`),
    queryFn: async () => { counters.details += 1; await probeApi(); return terminal ? "terminal" : "working"; },
  });
  return null;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>);

import { useQuery, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { api } from "../src/api";
import { useWorkspaceStream } from "../src/hooks/useWorkspaceStream";
import { queryKeys } from "../src/queryKeys";

const counters = { roster: 0, health: 0, directory: 0, details: 0, task: 0 };
const apiLatencies: number[] = [];
let terminal = false;
async function probeApi(): Promise<void> {
  const start = performance.now();
  const response = await fetch("/api/storm-probe");
  if (!response.ok) throw new Error(`probe returned ${response.status}`);
  apiLatencies.push(performance.now() - start);
}

api.subscribeWorkspace = (_cursor, handlers) => {
  let seq = 0;
  const status = setTimeout(() => handlers.onStatus?.({ instanceId: "storm", cursor: 0, reset: false }), 20);
  const command = setInterval(() => handlers.onEvent({
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
  }), 20);
  Object.assign(window, {
    stormCounters: () => ({ ...counters }),
    stormApiLatencies: () => [...apiLatencies],
    stopStorm: () => clearInterval(command),
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
  });
  return { close: () => { clearTimeout(status); clearInterval(command); } };
};

const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
function Probe() {
  const connection = useWorkspaceStream();
  const roster = useQuery({
    queryKey: queryKeys.agents.project("P1"),
    queryFn: async () => { counters.roster += 1; await probeApi(); return terminal ? "terminal" : "working"; },
  });
  useQuery({
    queryKey: queryKeys.agents.health("P1"),
    queryFn: async () => { counters.health += 1; await probeApi(); return terminal ? "terminal" : "working"; },
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
  return <><span id="roster">{roster.data}</span><span id="phase">{String(connection.phaseEvidenceFresh)}</span><AgentDetails /></>;
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

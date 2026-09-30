import type {
  AgentDetailDto,
  AgentDto,
  AgentTelemetryPageDto,
  AgentTelemetryStream,
  ConversationDto,
  HistoryWindowDto,
  MessageDto,
  ProjectEngineCapabilitiesDto,
  SendMessageRequest,
  SendMessageResponse,
} from "@ponderosa/core";
import { buildMarkdownTranscript } from "../chatTranscript";
import { downloadBlob } from "../downloads";
import { uniqueBy } from "../collections";
import type { AgentDetailView } from "../routing";
import { projectAgentChat } from "./chat/agentChatProjection";
import { resolveMessageMentionText } from "./chat/ChatMessages";
import { orderedAgentHeaderChats } from "./HeaderRelationshipLinks";

type AgentTab = Exclude<AgentDetailView, "activity">;

const telemetryTab = (stream: AgentTelemetryStream): AgentTab =>
  stream === "artifacts" || stream === "changedFiles"
    ? "artifacts"
    : stream === "runs" || stream === "workItems"
      ? "technical"
      : "chat";

type TelemetryPageState = {
  [K in AgentTelemetryStream]?: {
    items: AgentDetailDto[K extends "runOutput"
      ? "runOutput"
      : K extends "activity"
        ? "activity"
        : K extends "changedFiles"
          ? "changedFiles"
          : K extends "runs"
            ? "runs"
            : K extends "workItems"
              ? "workItems"
              : "artifacts"];
    history?: HistoryWindowDto;
  };
};

type MessagePageState = {
  messages: MessageDto[];
  history?: HistoryWindowDto;
};

function mergeMessagePage(
  current: MessagePageState | undefined,
  page: Pick<AgentDetailDto, "messages" | "history">,
  recentMessages: MessageDto[],
  preserveHistory = false,
  ordinaryHistory?: HistoryWindowDto,
): MessagePageState {
  const history = preserveHistory
    ? (current?.history ?? ordinaryHistory)
    : page.history;
  return {
    messages: uniqueBy(
      [...page.messages, ...(current?.messages ?? []), ...recentMessages],
      message => message.id,
      compareAgentChatMessages,
    ),
    ...(history ? { history } : {}),
  };
}

function mergeTelemetryPage(
  current: TelemetryPageState,
  page: AgentTelemetryPageDto,
  preserveHistory = false,
): TelemetryPageState {
  const next = { ...current };
  const history = preserveHistory
    ? current[page.stream]?.history
    : page.history;
  if (page.stream === "runOutput")
    next.runOutput = {
      items: uniqueBy(
        [...page.items, ...(current.runOutput?.items ?? [])],
        item => item.id,
      ),
      history,
    };
  else if (page.stream === "activity")
    next.activity = {
      items: uniqueBy(
        [...page.items, ...(current.activity?.items ?? [])],
        item => item.id,
      ),
      history,
    };
  else if (page.stream === "changedFiles")
    next.changedFiles = {
      items: uniqueBy(
        [...page.items, ...(current.changedFiles?.items ?? [])],
        item => item.path,
      ),
      history,
    };
  else if (page.stream === "runs")
    next.runs = {
      items: uniqueBy(
        [...page.items, ...(current.runs?.items ?? [])],
        item => item.id,
      ),
      history,
    };
  else if (page.stream === "workItems")
    next.workItems = {
      items: uniqueBy(
        [...page.items, ...(current.workItems?.items ?? [])],
        item => item.id,
      ),
      history,
    };
  else
    next.artifacts = {
      items: uniqueBy(
        [...page.items, ...(current.artifacts?.items ?? [])],
        item => item.id,
      ),
      history,
    };
  return next;
}

const telemetryStreamsForTab = (tab: AgentTab): AgentTelemetryStream[] =>
  tab === "chat"
    ? ["runOutput", "activity", "runs"]
    : tab === "artifacts"
      ? ["artifacts"]
      : [];

function directAgentDeliveryNotice(
  response: SendMessageResponse,
  activeRunDelivery: NonNullable<
    SendMessageRequest["activeRunDelivery"]
  > = "steer",
): string | undefined {
  if (response.queued) {
    if (activeRunDelivery === "steer") return undefined;
    if (response.position === undefined) {
      return "Queued successfully; delivery details are still being refreshed.";
    }
    return `Queued in position ${response.position}; it will start when the current response finishes.`;
  }
  return "steered" in response && response.steered
    ? "Steered into the active turn."
    : undefined;
}

function portablePackageFileName(
  title: string,
  organization: boolean,
  mode: "template" | "full",
): string {
  const safe = title
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLocaleLowerCase()
    .slice(0, 80);
  return `${safe || (organization ? "organization" : "agent")}-${mode === "template" ? "template" : "full"}.ponderosa.json`;
}

function downloadJson(value: unknown, fileName: string): void {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], {
    type: "application/json;charset=utf-8",
  });
  downloadBlob(blob, fileName);
}

function eligibleOrganizationParents(
  agent: AgentDto,
  agents: AgentDto[],
): AgentDto[] {
  const byId = new Map(agents.map(candidate => [candidate.id, candidate]));
  const isDescendant = (candidate: AgentDto): boolean => {
    const seen = new Set<string>();
    let parentId = candidate.managerAgentId;
    while (parentId && !seen.has(parentId)) {
      if (parentId === agent.id) return true;
      seen.add(parentId);
      parentId = byId.get(parentId)?.managerAgentId;
    }
    return false;
  };
  return agents
    .filter(
      candidate =>
        candidate.id !== agent.id &&
        candidate.projectId === agent.projectId &&
        !candidate.archived &&
        !isDescendant(candidate),
    )
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

function mergeAgentDetailProjection(
  current: AgentDetailDto | undefined,
  olderMessages: MessagePageState | undefined,
  olderTelemetry: TelemetryPageState,
): AgentDetailDto | undefined {
  if (!current) return undefined;
  const mergeBy = <T,>(
    recent: T[],
    older: T[] | undefined,
    id: (item: T) => string,
    compare: (a: T, b: T) => number,
  ): T[] => uniqueBy([...(older ?? []), ...recent], id, compare);
  return {
    ...current,
    messages: uniqueBy(
      [...(olderMessages?.messages ?? []), ...current.messages],
      message => message.id,
      compareAgentChatMessages,
    ),
    runOutput: mergeBy(
      current.runOutput,
      olderTelemetry.runOutput?.items,
      item => item.id,
      (a, b) => a.seq - b.seq,
    ),
    activity: mergeBy(
      current.activity,
      olderTelemetry.activity?.items,
      item => item.id,
      (a, b) => a.seq - b.seq,
    ),
    changedFiles: mergeBy(
      current.changedFiles,
      olderTelemetry.changedFiles?.items,
      item => item.path,
      (a, b) => a.lastSeq - b.lastSeq,
    ),
    runs: mergeBy(
      current.runs,
      olderTelemetry.runs?.items,
      item => item.id,
      (a, b) =>
        a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id),
    ),
    workItems: mergeBy(
      current.workItems,
      olderTelemetry.workItems?.items,
      item => item.id,
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    ),
    artifacts: mergeBy(
      current.artifacts,
      olderTelemetry.artifacts?.items,
      item => item.id,
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    ),
    telemetryHistory: Object.fromEntries(
      (
        [
          "runOutput",
          "activity",
          "changedFiles",
          "runs",
          "workItems",
          "artifacts",
        ] satisfies AgentTelemetryStream[]
      )
        .map(stream => [
          stream,
          olderTelemetry[stream]?.history ?? current.telemetryHistory?.[stream],
        ])
        .filter(entry => entry[1] !== undefined),
    ) as AgentDetailDto["telemetryHistory"],
    history: olderMessages?.history ?? current.history,
  };
}

function compareAgentChatMessages(left: MessageDto, right: MessageDto): number {
  return left.createdAt.localeCompare(right.createdAt) ||
    left.seq - right.seq ||
    left.id.localeCompare(right.id);
}

function mcpPresentation(
  mcpServers: ProjectEngineCapabilitiesDto["mcpServers"] | undefined,
) {
  const configured = mcpServers?.filter(server => server.configured) ?? [];
  const usable = configured.filter(server => server.usable);
  const inventoried = configured.filter(server => server.toolsDiscovered);
  const discoveredTools = inventoried.reduce(
    (total, server) => total + server.toolCount,
    0,
  );
  return {
    configuredCount: configured.length,
    usableCount: usable.length,
    toolCountLabel:
      inventoried.length === configured.length
        ? `${discoveredTools} tools`
        : `${discoveredTools} tools · inventory ${inventoried.length}/${configured.length}`,
    summary:
      configured
        .map(server =>
          [
            `${server.name}: ${server.initialization.replaceAll("_", " ")}`,
            server.usable ? "usable" : "not usable",
            server.toolsDiscovered
              ? `${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}`
              : "tools not discovered",
            `health ${server.health}`,
            server.detail,
          ]
            .filter(Boolean)
            .join(" · "),
        )
        .join("\n") || "No MCP servers are configured for this runtime.",
  };
}

function agentTranscriptMarkdown(
  detail: AgentDetailDto | undefined,
  agentNameForId: (agentId: string) => string | undefined,
): string {
  return detail
    ? buildMarkdownTranscript(
        `${detail.agent.title} — Agent chat`,
        projectAgentChat(detail.messages, detail.runs)
          .messages
          .map(message => ({
            author:
              message.role === "user"
                ? "You"
                : message.authorAgentId
                  ? (agentNameForId(message.authorAgentId) ?? "Agent")
                  : detail.agent.title,
            text: resolveMessageMentionText(
              message.text,
              message.agentMentions,
            ),
            createdAt: message.createdAt,
            attachments: message.attachments,
            document: message.document,
          })),
      )
    : "";
}

function agentRelationshipPresentation(
  agent: AgentDto,
  agents: AgentDto[],
  conversations: ConversationDto[],
) {
  const organizationalParent = agent.managerAgentId
    ? agents.find(candidate => candidate.id === agent.managerAgentId)
    : undefined;
  const spawningAgent = agent.spawnedByAgentId
    ? agents.find(candidate => candidate.id === agent.spawnedByAgentId)
    : undefined;
  const delegatedAgentIds = new Set<string>();
  const childrenByManager = new Map<string, AgentDto[]>();
  for (const candidate of agents) {
    if (!candidate.managerAgentId || candidate.archived) continue;
    childrenByManager.set(candidate.managerAgentId, [
      ...(childrenByManager.get(candidate.managerAgentId) ?? []),
      candidate,
    ]);
  }
  const collect = (managerAgentId: string) => {
    for (const candidate of childrenByManager.get(managerAgentId) ?? []) {
      if (delegatedAgentIds.has(candidate.id)) continue;
      delegatedAgentIds.add(candidate.id);
      collect(candidate.id);
    }
  };
  collect(agent.id);
  return {
    master: agent.conversationId
      ? conversations.find(candidate => candidate.id === agent.conversationId)
      : undefined,
    headerChats: orderedAgentHeaderChats([agent.conversationId], conversations, agent.conversationId),
    organizationalParent,
    lineageAgent: spawningAgent ?? organizationalParent,
    lineageAgentId: agent.spawnedByAgentId ?? agent.managerAgentId,
    lineageLabel: agent.spawnedByAgentId ? "Created by" : "Delegated under",
    delegatedAgentCount: delegatedAgentIds.size,
  };
}

export {
  agentRelationshipPresentation,
  agentTranscriptMarkdown,
  compareAgentChatMessages,
  directAgentDeliveryNotice,
  downloadJson,
  eligibleOrganizationParents,
  mcpPresentation,
  mergeAgentDetailProjection,
  mergeMessagePage,
  mergeTelemetryPage,
  portablePackageFileName,
  telemetryStreamsForTab,
  telemetryTab,
};
export type { AgentTab, MessagePageState, TelemetryPageState };

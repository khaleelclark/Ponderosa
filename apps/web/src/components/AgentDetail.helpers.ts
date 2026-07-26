import type {
  AgentDetailDto,
  AgentDto,
  AgentTelemetryPageDto,
  AgentTelemetryStream,
  HistoryWindowDto,
  SendMessageRequest,
  SendMessageResponse,
} from "@ponderosa/core";
import { uniqueBy } from "../collections";
import type { AgentDetailView } from "../routing";

type AgentTab = AgentDetailView;

const telemetryTab = (stream: AgentTelemetryStream): AgentTab =>
  stream === "artifacts" || stream === "changedFiles"
    ? "artifacts"
    : stream === "runs" || stream === "workItems"
      ? "technical"
      : "activity";

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
  tab === "activity"
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
    return `Queued in position ${response.position}; it will start when the current response finishes.`;
  }
  return response.steered ? "Steered into the active turn." : undefined;
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
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
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

export {
  directAgentDeliveryNotice,
  downloadJson,
  eligibleOrganizationParents,
  mergeTelemetryPage,
  portablePackageFileName,
  telemetryStreamsForTab,
  telemetryTab,
};
export type { AgentTab, TelemetryPageState };

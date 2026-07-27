import { Box, Button } from "@mui/material";
import type {
  AgentDetailDto,
  AgentDto,
  AgentHealthDto,
  ConversationDto,
  ResponseFileActivityDto,
  WorkspaceNotificationDto,
  WorkspacePreferencesDto,
} from "@ponderosa/core";
import type { ComponentProps } from "react";
import type { AgentStatus } from "../agents";
import { chatStateKey, readChatState } from "../chatState";
import type { AgentTelemetryFocus } from "../routing";
import { notificationTechnicalFocusId } from "../technicalFocus";
import { ActivityStreamPane } from "./activity/ActivityStreamPane";
import { AgentsTab } from "./AgentsTab";
import { AttentionSurface } from "./AttentionSurface";
import type { AgentTab } from "./AgentDetail.helpers";
import { AgentWorkInspector } from "./AgentWorkInspector";
import { ChatPane } from "./chat/ChatPane";
import { ArtifactsPane } from "./filePreview/ArtifactsPane";
import { TriggersPane } from "./TriggersPane";

interface AgentDetailPanelsProps {
  tab: AgentTab;
  detail: AgentDetailDto;
  agentId: string;
  agents: AgentDto[];
  conversations: ConversationDto[];
  engines: ComponentProps<typeof AgentsTab>["engines"];
  statusByAgentId: ReadonlyMap<string, AgentStatus>;
  healthByAgentId: ReadonlyMap<string, AgentHealthDto>;
  notifications: WorkspaceNotificationDto[];
  operatorProfile?: WorkspacePreferencesDto["profile"];
  agentNameForId: NonNullable<ComponentProps<typeof ChatPane>["agentNameForId"]>;
  agentIdForHandle: NonNullable<ComponentProps<typeof ChatPane>["agentIdForHandle"]>;
  completedWorkDurationLabel: NonNullable<
    ComponentProps<typeof ChatPane>["completedWorkDurationLabel"]
  >;
  chatPreviewScope: ComponentProps<typeof ChatPane>["previewScope"];
  mobileScrollObserver: NonNullable<
    ComponentProps<typeof ChatPane>["onScrollPositionChange"]
  >;
  loadingOlder: boolean;
  hasOlderTelemetry: boolean;
  connected: boolean;
  running: boolean;
  activeExecutionId?: string;
  focusTelemetry?: AgentTelemetryFocus;
  projectRoot?: string;
  timeline: ComponentProps<typeof ArtifactsPane>["timeline"];
  delegatedAgentCount: number;
  createTrigger?: boolean;
  agentWorkFocus?: string;
  settingsPane: JSX.Element;
  onOpenAgent(agentId: string): void;
  onOpenBroadcast: NonNullable<
    ComponentProps<typeof ChatPane>["onOpenBroadcast"]
  >;
  onMentionAgent(): void;
  onLoadOlderChat(): void;
  onLoadOlderTelemetry(): void;
  onOpenFile(file: ResponseFileActivityDto): void;
  onOpenFileInNewTab(file: ResponseFileActivityDto): void;
  onOpenReview(): void;
  onNewSubagent(managerAgentId: string): void;
  onOpenTechnical(focusId?: string): void;
  onOpenArtifact(artifactId: string): void;
  onOpenArtifactInNewTab(artifactId: string): void;
}

export function AgentDetailPanels({
  tab,
  detail,
  agentId,
  agents,
  conversations,
  engines,
  statusByAgentId,
  healthByAgentId,
  notifications,
  operatorProfile,
  agentNameForId,
  agentIdForHandle,
  completedWorkDurationLabel,
  chatPreviewScope,
  mobileScrollObserver,
  loadingOlder,
  hasOlderTelemetry,
  connected,
  running,
  activeExecutionId,
  focusTelemetry,
  projectRoot,
  timeline,
  delegatedAgentCount,
  createTrigger,
  agentWorkFocus,
  settingsPane,
  onOpenAgent,
  onOpenBroadcast,
  onMentionAgent,
  onLoadOlderChat,
  onLoadOlderTelemetry,
  onOpenFile,
  onOpenFileInNewTab,
  onOpenReview,
  onNewSubagent,
  onOpenTechnical,
  onOpenArtifact,
  onOpenArtifactInNewTab,
}: AgentDetailPanelsProps): JSX.Element {
  const panes: Record<AgentTab, JSX.Element> = {
    chat: (
      <Box
        sx={{ height: "100%", minHeight: 0, minWidth: 0, overflow: "hidden" }}
      >
        <ChatPane
          messages={detail.messages}
          agentName={detail.agent.title}
          agentNameForId={agentNameForId}
          agentIdForHandle={agentIdForHandle}
          onOpenAgent={onOpenAgent}
          onOpenBroadcast={onOpenBroadcast}
          operatorProfile={operatorProfile}
          projectId={detail.agent.projectId}
          completedWorkDurationLabel={completedWorkDurationLabel}
          previewScope={chatPreviewScope}
          scrollStorageKey={chatStateKey("scroll", `agent.${agentId}`)}
          onScrollPositionChange={mobileScrollObserver}
          onMentionAgent={onMentionAgent}
          hasOlder={detail.history?.hasMore}
          loadingOlder={loadingOlder}
          onLoadOlder={onLoadOlderChat}
        />
      </Box>
    ),
    activity: (
      <ActivityStreamPane
        agentId={agentId}
        activity={detail.activity}
        runOutput={detail.runOutput}
        runs={detail.runs}
        connected={connected}
        running={running}
        activeExecutionId={activeExecutionId}
        focusId={
          focusTelemetry?.stream === "activity" ||
          focusTelemetry?.stream === "runOutput"
            ? focusTelemetry.id
            : undefined
        }
        projectId={detail.agent.projectId}
        projectRoot={projectRoot}
        hasEarlier={hasOlderTelemetry}
        loadingEarlier={loadingOlder}
        onLoadEarlier={onLoadOlderTelemetry}
        onOpenFile={onOpenFile}
        onOpenFileInNewTab={onOpenFileInNewTab}
        onViewAll={onOpenReview}
      />
    ),
    subagents: (
      <AgentsTab
        agents={agents}
        projectId={detail.agent.projectId}
        engines={engines}
        conversations={conversations}
        statusByAgentId={statusByAgentId}
        healthByAgentId={healthByAgentId}
        onOpenAgent={onOpenAgent}
        onNewAgent={onNewSubagent}
        selectionAllowed={false}
        organizationRootAgentId={detail.agent.id}
        collection={{
          title: `${detail.agent.title} Agents`,
          detail: `${delegatedAgentCount} delegated ${
            delegatedAgentCount === 1 ? "Agent" : "Agents"
          }`,
          totalCount: delegatedAgentCount,
          variant: "embedded",
        }}
      />
    ),
    triggers: (
      <TriggersPane
        agent={detail.agent}
        initialCreateOpen={createTrigger}
        onOpenAgentWork={occurrenceId =>
          onOpenTechnical(`trigger:${occurrenceId}`)
        }
      />
    ),
    artifacts: (
      <ArtifactsPane
        artifacts={detail.artifacts}
        agentId={agentId}
        agentTitle={detail.agent.title}
        timeline={timeline}
        initialArtifactId={
          focusTelemetry?.stream === "artifacts"
            ? focusTelemetry.id
            : readChatState(chatStateKey("view", `agent.${agentId}.artifact`))
        }
        onSelectArtifact={onOpenArtifact}
        onOpenArtifactInNewTab={onOpenArtifactInNewTab}
        onOpenRun={runId => onOpenTechnical(`run:${runId}`)}
      />
    ),
    settings: <></>,
    technical: (
      <AgentWorkInspector
        open
        projectId={detail.agent.projectId}
        agentId={detail.agent.id}
        focus={agentWorkFocus ? { id: agentWorkFocus } : undefined}
        onClose={() => undefined}
      />
    ),
  };

  return (
    <Box
      sx={{
        position: "relative",
        height: "100%",
        maxHeight: "100%",
        minHeight: 0,
        minWidth: 0,
        overflow: "hidden",
      }}
    >
      <Box
        role="tabpanel"
        aria-label="Chat panel"
        tabIndex={tab === "chat" ? 0 : -1}
        hidden={tab !== "chat"}
        sx={{
          height: "100%",
          maxHeight: "100%",
          minHeight: 0,
          minWidth: 0,
          overflow: "hidden",
          outlineOffset: -2,
          display: tab === "chat" ? "grid" : "none",
          gridTemplateRows: "auto minmax(0, 1fr)",
        }}
      >
        <AttentionSurface
          notifications={notifications}
          projectId={detail.agent.projectId}
          agentId={agentId}
          onOpen={item => onOpenTechnical(notificationTechnicalFocusId(item))}
        />
        {panes.chat}
      </Box>
      {tab !== "chat" ? (
        <Box
          role="tabpanel"
          aria-label={`${tab === "technical" ? "Technical details" : tab[0]!.toUpperCase() + tab.slice(1)} panel`}
          tabIndex={0}
          sx={{
            height: "100%",
            maxHeight: "100%",
            minHeight: 0,
            minWidth: 0,
            overflow:
              tab === "activity" || tab === "technical" ? "hidden" : "auto",
            outlineOffset: -2,
            display: "grid",
            gridTemplateRows:
              hasOlderTelemetry && tab !== "activity"
                ? "auto minmax(0, 1fr)"
                : "minmax(0, 1fr)",
          }}
        >
          {hasOlderTelemetry && tab !== "activity" ? (
            <Button
              size="small"
              color="inherit"
              disabled={loadingOlder}
              onClick={onLoadOlderTelemetry}
              sx={{ justifySelf: "center", my: 0.5 }}
            >
              {loadingOlder ? "Loading…" : "Load Earlier Records"}
            </Button>
          ) : null}
          {tab === "settings" ? settingsPane : panes[tab]}
        </Box>
      ) : null}
    </Box>
  );
}

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
import { useEffect, useState, type ComponentProps } from "react";
import type { AgentStatus } from "../agents";
import { chatStateKey, readChatState } from "../chatState";
import type { AgentTelemetryFocus } from "../routing";
import { notificationTechnicalFocusId } from "../technicalFocus";
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
  chatMessages: AgentDetailDto["messages"];
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
  chatPreviewScope: ComponentProps<typeof ChatPane>["previewScope"];
  mobileScrollObserver: NonNullable<
    ComponentProps<typeof ChatPane>["onScrollPositionChange"]
  >;
  loadingOlder: boolean;
  hasOlderTelemetry: boolean;
  activeExecutionId?: string;
  focusTelemetry?: AgentTelemetryFocus;
  projectRoot?: string;
  timeline: ComponentProps<typeof ArtifactsPane>["timeline"];
  delegatedAgentCount: number;
  triggerSettingsId?: string;
  agentWorkFocus?: string;
  settingsPane: JSX.Element;
  onOpenAgent(agentId: string): void;
  onOpenAgentSettings(agentId: string): void;
  onOpenMessageSource: NonNullable<
    ComponentProps<typeof ChatPane>["onOpenMessageSource"]
  >;
  onMentionAgent(): void;
  onLoadOlderChat(): void;
  onLoadOlderTelemetry(): void;
  onOpenFile(file: ResponseFileActivityDto): void;
  onOpenFileInNewTab(file: ResponseFileActivityDto): void;
  onNewSubagent(managerAgentId: string): void;
  onAgentsDeleted(agentIds: string[]): void;
  onCreateTrigger(): void;
  onOpenTechnical(focusId?: string): void;
  onOpenArtifact(artifactId: string): void;
  onOpenArtifactInNewTab(artifactId: string): void;
  onCloseTriggerSettings(): void;
}

export function AgentDetailPanels({
  tab,
  detail,
  chatMessages,
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
  chatPreviewScope,
  mobileScrollObserver,
  loadingOlder,
  hasOlderTelemetry,
  activeExecutionId,
  focusTelemetry,
  projectRoot,
  timeline,
  delegatedAgentCount,
  triggerSettingsId,
  agentWorkFocus,
  settingsPane,
  onOpenAgent,
  onOpenAgentSettings,
  onOpenMessageSource,
  onMentionAgent,
  onLoadOlderChat,
  onLoadOlderTelemetry,
  onOpenFile,
  onOpenFileInNewTab,
  onNewSubagent,
  onAgentsDeleted,
  onCreateTrigger,
  onOpenTechnical,
  onOpenArtifact,
  onOpenArtifactInNewTab,
  onCloseTriggerSettings,
}: AgentDetailPanelsProps): JSX.Element {
  const [visibleSubagentCount, setVisibleSubagentCount] = useState(25);
  useEffect(() => setVisibleSubagentCount(25), [detail.agent.id]);
  const panes: Record<AgentTab, JSX.Element> = {
    chat: (
      <Box
        sx={{ height: "100%", minHeight: 0, minWidth: 0, overflow: "hidden" }}
      >
        <ChatPane
          messages={chatMessages}
          agentName={detail.agent.title}
          agentNameForId={agentNameForId}
          agentIdForHandle={agentIdForHandle}
          onOpenAgent={onOpenAgent}
          onOpenMessageSource={onOpenMessageSource}
          operatorProfile={operatorProfile}
          projectId={detail.agent.projectId}
          activity={detail.activity}
          runOutput={detail.runOutput}
          runs={detail.runs}
          activeExecutionId={activeExecutionId}
          projectRoot={projectRoot}
          onOpenFile={onOpenFile}
          onOpenFileInNewTab={onOpenFileInNewTab}
          focusId={
            focusTelemetry?.stream === "activity" ||
            focusTelemetry?.stream === "runOutput"
              ? focusTelemetry.id
              : undefined
          }
          previewScope={chatPreviewScope}
          scrollStorageKey={chatStateKey("scroll", `agent.${agentId}`)}
          onScrollPositionChange={mobileScrollObserver}
          onMentionAgent={onMentionAgent}
          hasOlder={Boolean(
            detail.history?.hasMore || hasOlderTelemetry,
          )}
          loadingOlder={loadingOlder}
          onLoadOlder={onLoadOlderChat}
        />
      </Box>
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
        onOpenAgentSettings={onOpenAgentSettings}
        onNewAgent={onNewSubagent}
        onAgentsDeleted={(_projectId, agentIds) =>
          onAgentsDeleted(agentIds)}
        selectionAllowed={false}
        organizationRootAgentId={detail.agent.id}
        visibleLimit={visibleSubagentCount}
        collectionFooter={delegatedAgentCount > visibleSubagentCount ? (
          <Button
            color="inherit"
            onClick={() => setVisibleSubagentCount(count => count + 25)}
          >
            Load older Agents
          </Button>
        ) : null}
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
        onCreateTrigger={onCreateTrigger}
        settingsTriggerId={triggerSettingsId}
        onCloseTriggerSettings={onCloseTriggerSettings}
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
            overflow: tab === "technical" ? "hidden" : "auto",
            outlineOffset: -2,
            display: "grid",
            gridTemplateRows:
              hasOlderTelemetry
                ? "auto minmax(0, 1fr)"
                : "minmax(0, 1fr)",
          }}
        >
          {hasOlderTelemetry ? (
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

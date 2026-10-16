import { Alert, Box, Button } from "@mui/material";
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
import { useQueryClient } from "@tanstack/react-query";
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
import { useConversationNotificationVisibility } from "./useConversationNotificationVisibility";

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
  loadingOlder: boolean;
  olderChatError?: string;
  olderTelemetryError?: string;
  hasOlderTelemetry: boolean;
  activeExecutionId?: string;
  focusTelemetry?: AgentTelemetryFocus;
  projectRoot?: string;
  delegatedAgentCount: number;
  agentWorkFocus?: string;
  settingsPane: JSX.Element;
  onOpenAgent(agentId: string): void;
  onOpenAgentSettings(agentId: string): void;
  onOpenMessageSource: NonNullable<
    ComponentProps<typeof ChatPane>["onOpenMessageSource"]
  >;
  onLoadOlderChat(): void;
  onLoadOlderTelemetry(): void;
  onOpenFile(file: ResponseFileActivityDto): void;
  onNewSubagent(managerAgentId: string): void;
  onAgentsDeleted(agentIds: string[]): void;
  onOpenTechnical(focusId?: string): void;
  onOpenArtifact(artifactId: string): void;
  onCloseTechnical(): void;
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
  loadingOlder,
  olderChatError,
  olderTelemetryError,
  hasOlderTelemetry,
  activeExecutionId,
  focusTelemetry,
  projectRoot,
  delegatedAgentCount,
  agentWorkFocus,
  settingsPane,
  onOpenAgent,
  onOpenAgentSettings,
  onOpenMessageSource,
  onLoadOlderChat,
  onLoadOlderTelemetry,
  onOpenFile,
  onNewSubagent,
  onAgentsDeleted,
  onOpenTechnical,
  onOpenArtifact,
  onCloseTechnical,
}: AgentDetailPanelsProps): JSX.Element {
  const queryClient = useQueryClient();
  const markCommunicationVisible = useConversationNotificationVisibility(
    queryClient,
  );
  const [visibleSubagentCount, setVisibleSubagentCount] = useState(25);
  useEffect(() => setVisibleSubagentCount(25), [detail.agent.id]);
  const panes: Record<AgentTab, JSX.Element> = {
    chat: (
      <Box
        sx={{ height: "100%", minHeight: 0, minWidth: 0, overflow: "hidden" }}
      >
          <ChatPane
            decisionEvents={detail.decisionEvents}
          messages={chatMessages}
          agentName={detail.agent.title}
          agentNameForId={agentNameForId}
          agentIdForHandle={agentIdForHandle}
          onOpenAgent={onOpenAgent}
          onOpenMessageSource={onOpenMessageSource}
          onCommunicationVisible={markCommunicationVisible}
          operatorProfile={operatorProfile}
          projectId={detail.agent.projectId}
          activity={detail.activity}
          runOutput={detail.runOutput}
          runs={detail.runs}
          activeExecutionId={activeExecutionId}
          projectRoot={projectRoot}
          onOpenFile={onOpenFile}
          focusId={
            focusTelemetry?.stream === "activity" ||
            focusTelemetry?.stream === "runOutput"
              ? focusTelemetry.id
              : undefined
          }
          fileOwnerAgentId={detail.agent.id}
          previewScope={chatPreviewScope}
          scrollStorageKey={chatStateKey("scroll", `agent.${agentId}`)}
          hasOlder={Boolean(
            detail.history?.hasMore || hasOlderTelemetry,
          )}
          loadingOlder={loadingOlder}
          onLoadOlder={onLoadOlderChat}
          historyError={olderChatError}
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
        collectionFooter={filteredCount =>
          filteredCount > visibleSubagentCount ? (
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
    artifacts: (
      <ArtifactsPane
        artifacts={detail.artifacts}
        agentId={agentId}
        agentTitle={detail.agent.title}
        projectId={detail.agent.projectId}
        projectRoot={projectRoot}
        initialArtifactId={
          focusTelemetry?.stream === "artifacts"
            ? focusTelemetry.id
            : readChatState(chatStateKey("view", `agent.${agentId}.artifact`))
        }
        onSelectArtifact={onOpenArtifact}
      />
    ),
    settings: <></>,
    technical: (
      <AgentWorkInspector
        open
        projectId={detail.agent.projectId}
        agentId={detail.agent.id}
        focus={agentWorkFocus ? { id: agentWorkFocus } : undefined}
        onClose={onCloseTechnical}
        backLabel="Back to Agent"
      />
    ),
  };
  const panelLabel = tab === "technical" ? "Technical details"
    : tab === "artifacts" ? "Files & Results"
      : tab[0]!.toUpperCase() + tab.slice(1);

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
          aria-label={`${panelLabel} panel`}
          tabIndex={0}
          sx={{
            height: "100%",
            maxHeight: "100%",
            minHeight: 0,
            minWidth: 0,
            overflow: tab === "technical" ? "hidden" : "auto",
            outlineOffset: -2,
            display: "grid",
            gridTemplateRows: `${hasOlderTelemetry ? "auto " : ""}${olderTelemetryError ? "auto " : ""}minmax(0, 1fr)`,
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
          {olderTelemetryError ? (
            <Alert
              severity="error"
              action={<Button color="inherit" size="small" onClick={onLoadOlderTelemetry}>Retry</Button>}
              sx={{ m: 1 }}
            >
              {olderTelemetryError}
            </Alert>
          ) : null}
          {tab === "settings" ? settingsPane : panes[tab]}
        </Box>
      ) : null}
    </Box>
  );
}

import type { AgentDto, ConversationDto, EngineDto } from "@ponderosa/core";
import { effortSelectionIsCompatible } from "../conversationEngine";
import { api } from "../api";
import type { ComponentProps } from "react";
import { useMutation } from "@tanstack/react-query";
import { AgentSettingsPane } from "./AgentDetail.settings";

interface AgentDetailSettingsControllerProps {
  agent: AgentDto;
  engines: EngineDto[];
  modelCatalogLoading?: boolean;
  settingsEngine: string;
  settingsModel: string;
  settingsEffort: string;
  settingsEngineRegistration?: EngineDto;
  settingsModels: ComponentProps<typeof AgentSettingsPane>["settingsModels"];
  settingsEfforts: ComponentProps<typeof AgentSettingsPane>["settingsEfforts"];
  runtimeSettingsDirty: boolean;
  runtimeSettingsPending: boolean;
  runtimeSettingsError: unknown;
  recheckPending: boolean;
  master?: ConversationDto;
  organizationalParent?: AgentDto;
  managementPermissionsPending: boolean;
  managementPermissionsError: unknown;
  mcpSummary: string;
  configuredMcpCount: number;
  usableMcpCount: number;
  mcpToolCountLabel: string;
  steering: ComponentProps<typeof AgentSettingsPane>["steering"];
  onSettingsEngine(value: string): void;
  onSettingsModel(value: string): void;
  onSettingsEffort(value: string): void;
  onSaveRuntimeSettings(): void;
  onRecheckEngine(): void;
  onOpenMaster(conversationId: string): void;
  onOpenAgent(agentId: string): void;
  onUpdateManagementPermissions(
    value: AgentDto["managementPermissions"],
  ): void;
  onChangeReportingLine(): void;
}

export function AgentDetailSettingsController({
  agent,
  engines,
  modelCatalogLoading,
  settingsEngine,
  settingsModel,
  settingsEffort,
  settingsEngineRegistration,
  settingsModels,
  settingsEfforts,
  runtimeSettingsDirty,
  runtimeSettingsPending,
  runtimeSettingsError,
  recheckPending,
  master,
  organizationalParent,
  managementPermissionsPending,
  managementPermissionsError,
  mcpSummary,
  configuredMcpCount,
  usableMcpCount,
  mcpToolCountLabel,
  steering,
  onSettingsEngine,
  onSettingsModel,
  onSettingsEffort,
  onSaveRuntimeSettings,
  onRecheckEngine,
  onOpenMaster,
  onOpenAgent,
  onUpdateManagementPermissions,
  onChangeReportingLine,
}: AgentDetailSettingsControllerProps): JSX.Element {
  const freshSession = useMutation({ mutationKey: ["fresh-provider-session", agent.id], mutationFn: () => api.compactSession(agent.id) });
  return (
    <AgentSettingsPane
      agent={agent}
      engines={engines}
      modelCatalogLoading={modelCatalogLoading}
      settingsEngine={settingsEngine}
      settingsModel={settingsModel}
      settingsEffort={settingsEffort}
      settingsEngineRegistration={settingsEngineRegistration}
      settingsModels={settingsModels}
      settingsEfforts={settingsEfforts}
      runtimeSettingsDirty={runtimeSettingsDirty}
      runtimeSettingsPending={runtimeSettingsPending}
      runtimeSettingsError={runtimeSettingsError}
      recheckPending={recheckPending}
      master={master}
      organizationalParent={organizationalParent}
      managementPermissionsPending={managementPermissionsPending}
      managementPermissionsError={managementPermissionsError}
      mcpSummary={mcpSummary}
      configuredMcpCount={configuredMcpCount}
      usableMcpCount={usableMcpCount}
      mcpToolCountLabel={mcpToolCountLabel}
      steering={steering}
      freshSessionPending={freshSession.isPending}
      freshSessionNotice={freshSession.isPending ? "Starting a fresh provider session for the next Run…" : freshSession.isSuccess ? "Fresh provider session scheduled for the next Run. Canonical history is unchanged." : undefined}
      freshSessionError={freshSession.isError ? freshSession.error instanceof Error ? freshSession.error.message : "Could not schedule a fresh provider session. Try again." : undefined}
      onSettingsEngineChange={value => {
        onSettingsEngine(value);
        onSettingsModel("");
        onSettingsEffort("");
      }}
      onSettingsModelChange={value => {
        onSettingsModel(value);
        if (
          !effortSelectionIsCompatible(
            settingsEngineRegistration,
            value,
            settingsEffort,
          )
        ) {
          onSettingsEffort("");
        }
      }}
      onSettingsEffortChange={onSettingsEffort}
      onSaveRuntimeSettings={onSaveRuntimeSettings}
      onRecheckEngine={onRecheckEngine}
      onStartFreshSession={() => {
        if (!freshSession.isPending) freshSession.mutate();
      }}
      onOpenMaster={onOpenMaster}
      onOpenAgent={onOpenAgent}
      onUpdateManagementPermissions={onUpdateManagementPermissions}
      onChangeReportingLine={onChangeReportingLine}
    />
  );
}

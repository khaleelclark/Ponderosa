import type { AgentDto, ConversationDto, EngineDto } from "@ponderosa/core";
import { effortSelectionIsCompatible } from "../conversationEngine";
import { api } from "../api";
import type { ComponentProps } from "react";
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
  runtimeSettingsNotice?: string;
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
  onNotice(value?: string): void;
  onFreshSessionNotice(value: string): void;
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
  runtimeSettingsNotice,
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
  onNotice,
  onFreshSessionNotice,
  onSaveRuntimeSettings,
  onRecheckEngine,
  onOpenMaster,
  onOpenAgent,
  onUpdateManagementPermissions,
  onChangeReportingLine,
}: AgentDetailSettingsControllerProps): JSX.Element {
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
      runtimeSettingsNotice={runtimeSettingsNotice}
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
      onSettingsEngineChange={value => {
        onSettingsEngine(value);
        onSettingsModel("");
        onSettingsEffort("");
        onNotice(undefined);
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
        onNotice(undefined);
      }}
      onSettingsEffortChange={value => {
        onSettingsEffort(value);
        onNotice(undefined);
      }}
      onSaveRuntimeSettings={onSaveRuntimeSettings}
      onRecheckEngine={onRecheckEngine}
      onStartFreshSession={() => {
        onFreshSessionNotice(
          "Starting this Agent with a fresh provider session next time…",
        );
        void api
          .compactSession(agent.id)
          .then(() =>
            onFreshSessionNotice(
              "Fresh provider session scheduled. Canonical history remains available.",
            ),
          )
          .catch((error: unknown) =>
            onFreshSessionNotice(
              error instanceof Error
                ? error.message
                : "Fresh provider session could not be scheduled.",
            ),
          );
      }}
      onOpenMaster={onOpenMaster}
      onOpenAgent={onOpenAgent}
      onUpdateManagementPermissions={onUpdateManagementPermissions}
      onChangeReportingLine={onChangeReportingLine}
    />
  );
}

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import {
  downloadJson,
  portablePackageFileName,
} from "./AgentDetail.helpers";

interface AgentPackageActionsInput {
  agentId: string;
  projectId?: string;
  conversationId?: string;
  title?: string;
  onNotice(value: string): void;
  onOpenAgent(agentId: string): void;
}

export function useAgentPackageActions({
  agentId,
  projectId,
  conversationId,
  title,
  onNotice,
  onOpenAgent,
}: AgentPackageActionsInput) {
  const queryClient = useQueryClient();
  const [elevatedCopyPackage, setElevatedCopyPackage] =
    useState<Awaited<ReturnType<typeof api.exportAgent>>>();

  const copyAgentPackage = async (
    mode: "template" | "full",
    organization = false,
  ) => {
    const portable = await api.exportAgent(agentId, mode, organization);
    await navigator.clipboard.writeText(JSON.stringify(portable, null, 2));
    onNotice(
      `${mode === "template" ? `${organization ? "Organization" : "Agent"} template` : `Full ${organization ? "organization" : "Agent"}`} copied.`,
    );
  };
  const downloadAgentPackage = async (
    mode: "template" | "full",
    organization = false,
  ) => {
    const portable = await api.exportAgent(agentId, mode, organization);
    downloadJson(
      portable,
      portablePackageFileName(
        title ?? "agent",
        organization,
        mode,
      ),
    );
    onNotice(
      `${mode === "template" ? `${organization ? "Organization" : "Agent"} template` : `Full ${organization ? "organization" : "Agent"}`} downloaded.`,
    );
  };
  const importQuickCopy = async (
    portable: Awaited<ReturnType<typeof api.exportAgent>>,
    elevated: boolean,
  ) => {
    if (!conversationId || !projectId) return;
    const engineMapping = Object.fromEntries(
      [...new Set(portable.agents.map(node => node.engine))].map(engineId => [
        engineId,
        engineId,
      ]),
    );
    const imported = await api.importAgents(projectId, {
      package: portable,
      conversationId,
      engineMapping,
      ...(elevated ? { acknowledgeElevatedManagementPermissions: true } : {}),
    });
    await queryClient.invalidateQueries({
      queryKey: queryKeys.agents.project(projectId),
    });
    setElevatedCopyPackage(undefined);
    onOpenAgent(imported.rootAgentId);
  };
  const quickCopyIntoProjectChat = async () => {
    if (!conversationId) return;
    const portable = await api.exportAgent(agentId, "full", false);
    const elevated = portable.agents.some(
      node =>
        node.managementPermissions.allowAutomaticDescendantDeletion ||
        node.managementPermissions.allowAutomaticDescendantReorganization,
    );
    if (elevated) {
      setElevatedCopyPackage(portable);
      return;
    }
    await importQuickCopy(portable, false);
  };

  return {
    copyAgentPackage,
    downloadAgentPackage,
    elevatedCopyPackage,
    importQuickCopy,
    quickCopyIntoProjectChat,
    setElevatedCopyPackage,
  };
}


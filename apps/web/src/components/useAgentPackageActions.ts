import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { ApiRequestError } from "../api/types";
import { queryKeys } from "../queryKeys";
import {
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
    useState(false);

  const copyAgentPackage = async (
    mode: "template" | "full",
    organization = false,
  ) => {
    const portableJson = await api.exportAgentText(agentId, mode, organization);
    await navigator.clipboard.writeText(portableJson);
    onNotice(
      `${mode === "template" ? `${organization ? "Organization" : "Agent"} template` : `Full ${organization ? "organization" : "Agent"}`} copied.`,
    );
  };
  const downloadAgentPackage = async (
    mode: "template" | "full",
    organization = false,
  ) => {
    const anchor = document.createElement("a");
    anchor.href = api.agentExportDownloadUrl(agentId, mode, organization);
    anchor.download = portablePackageFileName(
      title ?? "agent",
      organization,
      mode,
    );
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    onNotice(
      `${mode === "template" ? `${organization ? "Organization" : "Agent"} template` : `Full ${organization ? "organization" : "Agent"}`} downloaded.`,
    );
  };
  const importQuickCopy = async (elevated: boolean) => {
    if (!conversationId || !projectId) return;
    const imported = await api.copyAgent(projectId, {
      sourceAgentId: agentId,
      conversationId,
      ...(elevated ? { acknowledgeElevatedManagementPermissions: true } : {}),
    });
    await queryClient.invalidateQueries({
      queryKey: queryKeys.agents.project(projectId),
    });
    setElevatedCopyPackage(false);
    onOpenAgent(imported.rootAgentId);
  };
  const quickCopyIntoProjectChat = async () => {
    if (!conversationId) return;
    try {
      await importQuickCopy(false);
    } catch (error) {
      if (
        error instanceof ApiRequestError
        && error.status === 409
        && error.message.includes("explicit acknowledgement")
      ) {
        setElevatedCopyPackage(true);
        return;
      }
      throw error;
    }
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

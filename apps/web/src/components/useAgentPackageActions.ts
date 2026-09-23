import { api } from "../api";
import { copyDeferredText } from "../clipboard";
import {
  portablePackageFileName,
} from "./AgentDetail.helpers";

interface AgentPackageActionsInput {
  agentId: string;
  title?: string;
  onNotice(value: string): void;
}

export function useAgentPackageActions({
  agentId,
  title,
  onNotice,
}: AgentPackageActionsInput) {

  const copyAgentPackage = async (
    mode: "template" | "full",
    organization = false,
  ) => {
    try {
      await copyDeferredText(
        api.exportAgentText(agentId, mode, organization),
      );
      onNotice("Agent package JSON copied. To import it, choose Add Agents → Import Agent package.");
    } catch (error) {
      onNotice(
        error instanceof Error
          ? `Agent package JSON could not be copied: ${error.message}`
          : "Agent package JSON could not be copied.",
      );
    }
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
    onNotice("Agent package download started.");
  };
  return {
    copyAgentPackage,
    downloadAgentPackage,
  };
}

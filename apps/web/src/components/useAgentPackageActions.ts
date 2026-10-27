import { api } from "../api";
import { copyDeferredText } from "../clipboard";
import { useMutationNotification } from "./MutationNotifications";
import {
  portablePackageFileName,
} from "./AgentDetail.helpers";

interface AgentPackageActionsInput {
  agentId: string;
  title?: string;
}

export function useAgentPackageActions({
  agentId,
  title,
}: AgentPackageActionsInput) {
  const notify = useMutationNotification();

  const copyAgentPackage = async (
    mode: "template" | "full",
    organization = false,
  ) => {
    try {
      await copyDeferredText(
        api.exportAgentText(agentId, mode, organization),
      );
      notify({ key: "copy-agent-package", message: "Copied" });
    } catch (error) {
      notify({ key: "copy-agent-package", severity: "error", message: error instanceof Error
        ? `Agent package JSON could not be copied: ${error.message}`
        : "Agent package JSON could not be copied." });
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
    anchor.dataset.ponderosaDownloadFeedback = "handled";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    notify({ key: "agent-package-download", message: "Download started" });
  };
  return {
    copyAgentPackage,
    downloadAgentPackage,
  };
}

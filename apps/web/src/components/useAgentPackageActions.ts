import {AgentPackageDownloadRequired} from "../agent-package-clipboard";
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
    workingFiles: string[] = [],
    wholeWorkingFolder = false,
    organizationWorkingFolders = false,
    reviewedUserData?: import("@ponderosa/core").ReviewedUserDataSelection,
    gitStorageBindings?:import("@ponderosa/core").GitStorageSelection[],
  ) => {
    try {
      await copyDeferredText(
        api.exportAgentText(agentId, mode, organization, workingFiles, wholeWorkingFolder, organizationWorkingFolders, reviewedUserData,gitStorageBindings),
      );
      notify({ key: "copy-agent-package", message: "Copied" });
    } catch (error) {
      if(error instanceof AgentPackageDownloadRequired){
        const started=await downloadAgentPackage(mode,organization,workingFiles,wholeWorkingFolder,organizationWorkingFolders,reviewedUserData,gitStorageBindings);
        if(started)notify({key:'copy-agent-package',message:'Complete package download started. Import the downloaded file; nothing was truncated for the clipboard.'});
        return;
      }

      notify({ key: "copy-agent-package", severity: "error", message: error instanceof Error
        ? `Agent package JSON could not be copied: ${error.message}`
        : "Agent package JSON could not be copied." });
    }
  };
  const downloadAgentPackage = async (
    mode: "template" | "full",
    organization = false,
    workingFiles: string[] = [],
    wholeWorkingFolder = false,
    organizationWorkingFolders = false,
    reviewedUserData?: import("@ponderosa/core").ReviewedUserDataSelection,
    gitStorageBindings?:import("@ponderosa/core").GitStorageSelection[],
  ) => {
    try{
      await api.downloadAgentPackage(agentId,portablePackageFileName(title??'agent',organization,mode),mode,organization,workingFiles,wholeWorkingFolder,organizationWorkingFolders,reviewedUserData,gitStorageBindings);
      notify({key:'agent-package-download',message:'Download started'});
      return true;
    }catch(error){
      notify({key:'agent-package-download',severity:'error',message:error instanceof Error?error.message:'Agent package download could not start.'});
      return false;
    }
  };
  return {
    copyAgentPackage,
    downloadAgentPackage,
  };
}

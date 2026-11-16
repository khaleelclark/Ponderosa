import { createContext, useContext } from "react";
import type { PhaseResource, WorkspaceConnectionState } from "../hooks/useWorkspaceStream";

const WorkspaceConnectionContext = createContext<WorkspaceConnectionState>({
  status: "connecting",
  phaseEvidenceFresh: false,
  prolongedDisconnect: false,
});

export const WorkspaceConnectionProvider = WorkspaceConnectionContext.Provider;

export function useWorkspaceConnection(): WorkspaceConnectionState {
  return useContext(WorkspaceConnectionContext);
}

/** One resource's evidence: fresh once its own refresh boundary completed, whatever other resources are doing. */
export function phaseResourceFresh(connection: WorkspaceConnectionState, resource: PhaseResource): boolean {
  return connection.status === "live" && (connection.phaseEvidenceFresh || (connection.stalePhaseResources !== undefined && !connection.stalePhaseResources.includes(resource)));
}

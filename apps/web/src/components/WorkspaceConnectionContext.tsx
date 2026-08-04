import { createContext, useContext } from "react";
import type { WorkspaceConnectionState } from "../hooks/useWorkspaceStream";

const WorkspaceConnectionContext = createContext<WorkspaceConnectionState>({
  status: "connecting",
  prolongedDisconnect: false,
});

export const WorkspaceConnectionProvider = WorkspaceConnectionContext.Provider;

export function useWorkspaceConnection(): WorkspaceConnectionState {
  return useContext(WorkspaceConnectionContext);
}

import type {
  ConversationDto,
  ProjectDto,
} from "@ponderosa/core";
import { api } from "../api";
import {
  type WorkspaceProjectSnapshot,
} from "../workspaceNavigation";
import { ponderosaLayoutTokens } from "../theme";

const SIDEBAR_RAIL_WIDTH = ponderosaLayoutTokens.sidebarRailWidth;
const SIDEBAR_PANEL_WIDTH = ponderosaLayoutTokens.sidebarPanelWidth;

function projectSnapshots(
  projects: ProjectDto[],
  conversations: Array<ConversationDto[] | undefined>,
  agents: Array<Awaited<ReturnType<typeof api.listAgents>> | undefined>,
  health: Array<Awaited<ReturnType<typeof api.getAgentHealth>> | undefined>,
): WorkspaceProjectSnapshot[] {
  return projects.map((project, index) => ({
    project,
    conversations: conversations[index] ?? [],
    agents: agents[index] ?? [],
    health: health[index]?.agents ?? [],
  }));
}

const sidebarSurface = "var(--ponderosa-sidebar)";
const railSurface = "var(--ponderosa-rail)";
const starColor = "var(--ponderosa-star)";

export {
  SIDEBAR_PANEL_WIDTH,
  SIDEBAR_RAIL_WIDTH,
  projectSnapshots,
  railSurface,
  sidebarSurface,
  starColor,
};

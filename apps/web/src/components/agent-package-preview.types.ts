export interface PortableAgentPreview {
  sourceLabel: string;
  hasOutputRoles: boolean;
  workingRoots?: Array<{ref:string;agents:string[]}>;
  sourceProjectInstructions?: string;
  mode: "template" | "full";
  kind: "agent" | "organization";
  agentCount: number;
  artifactCount: number;
  historyMessageCount: number;
  agentTitles: string[];
  sourceEngines: string[];
  elevatedAgentRefs: string[];
  invalidPermissionShape: boolean;
}

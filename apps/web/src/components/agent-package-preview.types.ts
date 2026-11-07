export interface PortableAgentPreview {
  nativeData?: import('./nativeDataPreview').NativeDataPreview;
  sourceLabel: string;
  hasOutputRoles: boolean;
  hasWorkingFiles: boolean;
  workingRoots?: Array<{ref:string;agents:string[]}>;
  sourceProjectInstructions?: string;
  mode: "template" | "full";
  kind: "agent" | "organization";
  agentCount: number;
  artifactCount: number;
  historyMessageCount: number;
  agentTitles: string[];
  agentIdentities?: Array<{ref:string;title:string}>;
  sourceEngines: string[];
  elevatedAgentRefs: string[];
  invalidPermissionShape: boolean;
}

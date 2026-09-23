interface PreviewRequest {
  id: number;
  blob: Blob;
}

interface PortableAgentPreview {
  sourceLabel: string;
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

type PreviewResponse =
  | { id: number; phase: "Reading import" | "Validating" | "Preparing summary" }
  | { id: number; preview: PortableAgentPreview }
  | { id: number; error: string };

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<PreviewRequest>) => void) | null;
  postMessage(message: PreviewResponse): void;
};

worker.onmessage = async (event: MessageEvent<PreviewRequest>) => {
  const { id, blob } = event.data;
  try {
    worker.postMessage({ id, phase: "Reading import" });
    const source = await blob.text();
    worker.postMessage({ id, phase: "Validating" });
    const value = JSON.parse(source) as Record<string, unknown>;
    if (
      value?.schema !== "ponderosa.agent-package.v1"
      || (value.mode !== "template" && value.mode !== "full")
      || (value.kind !== "agent" && value.kind !== "organization")
      || typeof value.sourceLabel !== "string"
      || !Array.isArray(value.agents)
      || value.agents.length < 1
      || value.agents.length > 100
    ) {
      throw new Error("Choose or paste a ponderosa.agent-package.v1 document.");
    }
    worker.postMessage({ id, phase: "Preparing summary" });
    const sourceEngines = new Set<string>();
    const agentTitles: string[] = [];
    const elevatedAgentRefs: string[] = [];
    let invalidPermissionShape = false;
    let artifactCount = 0;
    let historyMessageCount = 0;
    for (const candidate of value.agents) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error("The Agent package contains an invalid Agent entry.");
      }
      const node = candidate as Record<string, unknown>;
      if (typeof node.title !== "string") {
        throw new Error("Every Agent in the package needs a name.");
      }
      agentTitles.push(node.title.trim().slice(0, 80) || "Imported Agent");
      if (typeof node.engine === "string" && node.engine.trim()) {
        sourceEngines.add(node.engine);
      }
      if (Array.isArray(node.artifacts)) artifactCount += node.artifacts.length;
      if (Array.isArray(node.history)) historyMessageCount += node.history.length;
      const permissions = node.managementPermissions;
      if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
        invalidPermissionShape = true;
        continue;
      }
      const permissionRecord = permissions as Record<string, unknown>;
      if (
        typeof permissionRecord.allowAutomaticDescendantDeletion !== "boolean"
        || typeof permissionRecord.allowAutomaticDescendantReorganization !== "boolean"
      ) {
        invalidPermissionShape = true;
        continue;
      }
      if (
        permissionRecord.allowAutomaticDescendantDeletion
        || permissionRecord.allowAutomaticDescendantReorganization
      ) {
        elevatedAgentRefs.push(
          typeof node.ref === "string" ? node.ref : `Agent ${elevatedAgentRefs.length + 1}`,
        );
      }
    }
    const response: PreviewResponse = {
      id,
      preview: {
        sourceLabel: value.sourceLabel.slice(0, 240),
        mode: value.mode,
        kind: value.kind,
        agentCount: value.agents.length,
        artifactCount,
        historyMessageCount,
        agentTitles,
        sourceEngines: [...sourceEngines],
        elevatedAgentRefs,
        invalidPermissionShape,
      },
    };
    worker.postMessage(response);
  } catch (error) {
    const response: PreviewResponse = {
      id,
      error: error instanceof Error
        ? error.message
        : "Ponderosa could not inspect that package.",
    };
    worker.postMessage(response);
  }
};

export {};

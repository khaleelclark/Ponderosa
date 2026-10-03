import { PONDEROSA_IMPORT_FILE_TOOL, type RuntimeDynamicToolSpec, type RuntimeEnvironmentFactsDto } from "@ponderosa/core";
import { environmentFactsPrompt } from "./runtime-environment-facts.js";
import { communicationV3SessionPrompt, legacyCommunicationV3SessionPrompt } from "./runtime-selection.js";

// Exact deployed contracts (682909ae and 18c914d0). These are frozen provider
// policy, not import permission: the current host authorizes every tool call.
const PREVIOUS_IMPORT_DESCRIPTION = "Import one regular host file into this Run's Project files, making it available to the operator, ponderosa_message, and ponderosa_browser_upload when its format is supported. Pass a path relative to the Project workspace, or an absolute path inside an operator-configured import root. The server securely copies exact stable bytes into immutable Project-managed storage and returns the artifact ID. Symlinks, empty files, changing files, files outside authorized roots, and files larger than 64 MiB fail closed.";
const PREVIOUS_NO_REPORT_ROOT = "No external report-output root is authorized. A read-only reviewer can return its report through a canonical reply, or ask the operator to configure an import root. Do not write a report into the writer's checkout, silently grant a root, or copy a rejected file automatically.";
const APPROVAL_IMPORT_DESCRIPTION = "Import one regular host file into managed downloadable storage, making it available to the operator, ponderosa_message, and ponderosa_browser_upload when its format is supported. Workspace files and server-wide operator-configured import roots retain their existing permissions. An external file stays rejected while a single-file publication Decision is pending. End the Run without copying it into the workspace; after approval resumes you, retry this exact path. Approval binds this Agent, owning Chat, one publication operation, and server-verified bytes; it does not grant a directory or future imports. The server returns the immutable artifact ID and reuses its receipt on retry. Symlinks, empty, changed, or oversized files fail closed; the existing 64 MiB limit remains.";
const APPROVAL_NO_REPORT_ROOT = "No external report-output root is authorized. Use ponderosa_import_file on the exact external deliverable to request a single-file publication Decision, or return a report through a canonical reply. Approval publishes only the verified file, not a directory or future imports. End the Run while approval is pending; retry the same path after its exact Decision continuation resumes. Do not write a report into the writer's checkout, silently grant a root, or copy a rejected file automatically.";
const PREVIOUS_REPORT_ROOT = "The reportOutputRoot is an Agent-owned publication location under an existing operator-authorized import root, outside this checkout. It is not automatically created. A read-only reviewer may write its report there and use ponderosa_import_file; do not write into the writer's checkout or broaden import roots. File APIs still enforce symlink containment.";
const PREVIOUS_IMPORT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["path"],
  properties: { path: { type: "string", minLength: 1, maxLength: 4096 } },
};

/** Reconstruct only explicitly known publication contracts. The caller
 * must additionally verify its full hash against the exact accepted session,
 * and may use it only for that session's scheduler-owned rollover handoff. */
export function previousPublicationSessionContracts(input: {
  currentSystemPrompt: string;
  frozenSystemPrompt: string;
  currentTools: readonly RuntimeDynamicToolSpec[];
  environmentFacts: RuntimeEnvironmentFactsDto;
}): Array<{ tools: RuntimeDynamicToolSpec[]; communicationPrompt: string[] }> {
  const imports = input.currentTools.filter(tool => tool.name === "ponderosa_import_file");
  if (imports.length !== 1 || imports[0]!.description !== PONDEROSA_IMPORT_FILE_TOOL.description ||
      JSON.stringify(imports[0]!.inputSchema) !== JSON.stringify(PREVIOUS_IMPORT_SCHEMA)) return [];
  const environment = environmentFactsPrompt(input.environmentFacts);
  const currentBlock = environment.join("\n");
  // Never normalize identity, operator policy, PATH observations, output roots,
  // or arbitrary surrounding text. Only the exact known guidance is replaced.
  if (input.currentSystemPrompt.split(currentBlock).length !== 2) return [];
  return [
    { description: APPROVAL_IMPORT_DESCRIPTION, noRoot: APPROVAL_NO_REPORT_ROOT },
    { description: PREVIOUS_IMPORT_DESCRIPTION, noRoot: PREVIOUS_NO_REPORT_ROOT },
  ].flatMap(previous => {
    const previousEnvironment = [...environment.slice(0, -1),
      input.environmentFacts.reportOutputRoot ? PREVIOUS_REPORT_ROOT : previous.noRoot];
    const previousSystemPrompt = input.currentSystemPrompt.replace(currentBlock, previousEnvironment.join("\n"));
    const communicationPrompt = input.frozenSystemPrompt === previousSystemPrompt
      ? communicationV3SessionPrompt()
      : legacyCommunicationV3SessionPrompt(previousSystemPrompt, input.frozenSystemPrompt);
    if (!communicationPrompt) return [];
    return [{
      tools: input.currentTools.map(tool => tool.name === "ponderosa_import_file"
        ? { ...tool, description: previous.description } : tool),
      communicationPrompt,
    }];
  });
}

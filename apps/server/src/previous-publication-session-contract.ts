import { PONDEROSA_IMPORT_FILE_TOOL, type RuntimeDynamicToolSpec, type RuntimeEnvironmentFactsDto } from "@ponderosa/core";
import { environmentFactsPrompt } from "./runtime-environment-facts.js";
import { communicationV3SessionPrompt, legacyCommunicationV3SessionPrompt } from "./runtime-selection.js";

// Exact pre-publication contract (682909ae). This is frozen provider policy,
// not import permission: the current host still authorizes every tool call.
const PREVIOUS_IMPORT_DESCRIPTION = "Import one regular host file into this Run's Project files, making it available to the operator, ponderosa_message, and ponderosa_browser_upload when its format is supported. Pass a path relative to the Project workspace, or an absolute path inside an operator-configured import root. The server securely copies exact stable bytes into immutable Project-managed storage and returns the artifact ID. Symlinks, empty files, changing files, files outside authorized roots, and files larger than 64 MiB fail closed.";
const PREVIOUS_NO_REPORT_ROOT = "No external report-output root is authorized. A read-only reviewer can return its report through a canonical reply, or ask the operator to configure an import root. Do not write a report into the writer's checkout, silently grant a root, or copy a rejected file automatically.";
const PREVIOUS_IMPORT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["path"],
  properties: { path: { type: "string", minLength: 1, maxLength: 4096 } },
};

/** Reconstruct only the immediately preceding publication contract. The caller
 * must additionally verify its full hash against the exact accepted session,
 * and may use it only for that session's scheduler-owned rollover handoff. */
export function previousPublicationSessionContract(input: {
  currentSystemPrompt: string;
  frozenSystemPrompt: string;
  currentTools: readonly RuntimeDynamicToolSpec[];
  environmentFacts: RuntimeEnvironmentFactsDto;
}): { tools: RuntimeDynamicToolSpec[]; communicationPrompt: string[] } | undefined {
  const imports = input.currentTools.filter(tool => tool.name === "ponderosa_import_file");
  if (imports.length !== 1 || imports[0]!.description !== PONDEROSA_IMPORT_FILE_TOOL.description ||
      JSON.stringify(imports[0]!.inputSchema) !== JSON.stringify(PREVIOUS_IMPORT_SCHEMA)) return undefined;
  const environment = environmentFactsPrompt(input.environmentFacts);
  const currentBlock = environment.join("\n");
  // Never normalize identity, operator policy, PATH observations, import roots,
  // or arbitrary surrounding text. Authorized report-root guidance is unchanged.
  if (input.currentSystemPrompt.split(currentBlock).length !== 2) return undefined;
  const previousEnvironment = input.environmentFacts.reportOutputRoot
    ? environment : [...environment.slice(0, -1), PREVIOUS_NO_REPORT_ROOT];
  const previousSystemPrompt = input.currentSystemPrompt.replace(currentBlock, previousEnvironment.join("\n"));
  const communicationPrompt = input.frozenSystemPrompt === previousSystemPrompt
    ? communicationV3SessionPrompt()
    : legacyCommunicationV3SessionPrompt(previousSystemPrompt, input.frozenSystemPrompt);
  if (!communicationPrompt) return undefined;
  return {
    tools: input.currentTools.map(tool => tool.name === "ponderosa_import_file"
      ? { ...tool, description: PREVIOUS_IMPORT_DESCRIPTION } : tool),
    communicationPrompt,
  };
}

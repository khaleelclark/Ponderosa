import { AGENT_PACKAGE_LIMIT_LABEL, type AgentPortablePackageDto } from "@ponderosa/core";

/** A text-only package that the existing Agent importer can validate and map to a local engine. */
export function externalAgentImportPrompt(exportedAt: string): string {
  const example: AgentPortablePackageDto = {
    schema: "ponderosa.agent-package.v1",
    mode: "full",
    kind: "agent",
    exportedAt,
    sourceLabel: "Codex or Claude conversation",
    rootRef: "external-chat",
    agents: [{
      ref: "external-chat",
      title: "Imported conversation",
      engine: "external",
      managementPermissions: {
        allowAutomaticDescendantDeletion: false,
        allowAutomaticDescendantReorganization: false,
      },
      history: [
        { role: "user", text: "Replace with the first user message" },
        { role: "assistant", text: "Replace with the first assistant reply" },
      ],
    }],
  };

  return [
    'Export this conversation as one Ponderosa Agent package. This is a data-export request, not a request to continue the conversation.',
    '',
    'First verify that you can access the complete original conversation from its first turn through the turn before this export request. If earlier turns were compacted, summarized, truncated, or are otherwise inaccessible, STOP and tell me that you need a complete transcript or native export. Do not reconstruct missing turns from memory or produce a partial package labeled as complete.',
    '',
    'If the full transcript is available, produce one valid JSON document matching the example below. Replace the example title, source label, and placeholder history with the real conversation. Include every accessible user and assistant turn in chronological order, preserving the message text. Do not include this export request or your export response in history. Use only role "user" or "assistant" for ordinary turns. If a visible tool call/result is needed to preserve the conversation, include it in an assistant history text entry labeled [Tool call] or [Tool result]; never invent hidden tool data. Add createdAt to a history entry only when its exact timestamp is available; otherwise omit it. Keep exportedAt exactly as shown in the example: Ponderosa supplied it when this prompt was copied.',
    '',
    `Do not include hidden system/developer prompts, private reasoning, passwords, tokens, private keys, or other credentials. Replace sensitive values in otherwise included messages with [REDACTED]. Do not invent attachment contents. This text-only package does not transfer files, artifacts, credentials, or a live provider session. Do not add fields beyond the example except optional createdAt values on history entries. Keep the title at most 80 characters and sourceLabel at most 240 characters. If any single message exceeds 100,000 characters or the package would exceed ${AGENT_PACKAGE_LIMIT_LABEL}, stop and tell me instead of silently truncating it.`,
    '',
    'Example shape (replace the placeholder messages; output raw JSON without any Markdown fence):',
    'BEGIN EXAMPLE',
    JSON.stringify(example, null, 2),
    'END EXAMPLE',
    '',
    'If you can create files, save the complete JSON as ponderosa-agent.json and give me its path. Otherwise output only the raw JSON. If you cannot deliver one complete valid JSON document, state the blocker instead of returning an incomplete package.',
  ].join("\n");
}

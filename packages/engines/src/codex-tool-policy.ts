/** Enabled connector tools are selected before a Ponderosa Run starts and run
 * unattended. This fallback does not enable disabled apps/tools or override
 * explicit per-app/per-tool policies or managed provider requirements.
 * Keep command escalation policy separate: never prompt is not tool approval. */
export const CODEX_APP_TOOL_POLICY_ARGS = [
  '-c', 'apps._default.default_tools_approval_mode="approve"',
] as const;

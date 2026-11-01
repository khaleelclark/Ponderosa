const HOST_ONLY_ENVIRONMENT_KEYS = [
  "PONDEROSA_LAUNCHER_CONTROL_TOKEN",
  "PONDEROSA_AUTH_TOKEN",
  "PONDEROSA_VAPID_PRIVATE_KEY",
  "PONDEROSA_AGENT_SCOPE_MODE",
  "PONDEROSA_AGENT_PARENT_UNIT",
  "PONDEROSA_AGENT_WORKLOAD_SLICE",
  "PONDEROSA_AGENT_MEMORY_MAX_MIB",
] as const;

/**
 * Provider CLIs and their tool descendants must not inherit launcher or other
 * host-only credentials. Keep this boundary in the shared engine layer so a
 * new adapter cannot accidentally clone the complete server environment.
 */
export function runtimeEnvironment(
  overrides?: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  for (const key of HOST_ONLY_ENVIRONMENT_KEYS) delete environment[key];
  return environment;
}

/** Snapshot existing native environment without selecting a different credential
 * on the user's behalf. The returned object is process-local and never persisted. */
export function claudeBillingEnvironment(
  overrides: Readonly<Record<string, string | undefined>> | undefined,
  expected?: "subscription" | "api",
): Record<string, string> {
  const environment = runtimeEnvironment(overrides);
  const snapshot = () => Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined));
  if (!expected) return snapshot();
  const key = Boolean(environment.ANTHROPIC_API_KEY?.trim());
  const conflicting = [environment.ANTHROPIC_AUTH_TOKEN, environment.CLAUDE_CODE_OAUTH_TOKEN]
    .some(value => Boolean(value?.trim()));
  if ((expected === "api" && (!key || conflicting)) || (expected === "subscription" && (key || Boolean(environment.ANTHROPIC_AUTH_TOKEN?.trim())))) {
    throw new Error("Claude native credential selectors differ from the human billing-mode selection; no provider input sent");
  }
  return snapshot();
}

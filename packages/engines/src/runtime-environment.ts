const HOST_ONLY_ENVIRONMENT_KEYS = [
  "PONDEROSA_LAUNCHER_CONTROL_TOKEN",
  "PONDEROSA_AUTH_TOKEN",
  "PONDEROSA_VAPID_PRIVATE_KEY",
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

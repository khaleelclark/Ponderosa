export type ReleaseChannel = "beta" | "stable" | "development" | string;

export interface BuildManifest {
  schemaVersion: 1;
  product: "Ponderosa";
  version: string;
  commit: string;
  communicationProtocolVersion: string;
  databaseSchemaVersion: string;
  databaseSchemaSha256: string;
  target: {
    platform: NodeJS.Platform | string;
    arch: NodeJS.Architecture | string;
  };
  nodeVersion: string;
  nodeExecutableBytes: number;
  nodeExecutableSha256: string;
  nodeSource: {
    url: string;
    archiveSha256: string;
    executableSha256: string;
  };
  nativeAbi: {
    modules: string;
    napi: string;
  };
  nativeHost: {
    bytes: number;
    sha256: string;
  };
  buildTime: string;
  channel: ReleaseChannel;
}

export interface ProviderConfiguration {
  executable?: string;
}

export interface LauncherConfiguration {
  port?: number;
  providers?: {
    codex?: ProviderConfiguration;
    claude?: ProviderConfiguration;
  };
}

export interface LauncherState {
  schemaVersion: 1;
  controlToken: string;
  /** Windows supervisor that owns the server Job Object until it drains. */
  supervisorPid?: number;
  /** Correlates the persisted supervisor status with this launcher instance. */
  supervisorGeneration?: string;
  pid: number;
  port: number;
  host: "127.0.0.1";
  startedAt: string;
  /** Application data directory passed to the server, nested below the launcher data root. */
  dataDir: string;
  installRoot: string;
  version: string;
  commit: string;
  channel: ReleaseChannel;
}

export interface PublicLauncherState extends Omit<LauncherState, "controlToken"> {
  healthy: boolean;
  detail: string;
}

export type DoctorCheckStatus = "pass" | "warning" | "fail";

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorCheckStatus;
  detail: string;
  repair?: string;
}

export interface DoctorReport {
  generatedAt: string;
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  version: string;
  commit: string;
  dataDir: string;
  checks: DoctorCheck[];
  ready: boolean;
}

export interface LauncherPaths {
  installRoot: string;
  /** Launcher-owned root containing state, logs, configuration, and application data. */
  dataDir: string;
  /** Application data directory passed to the server and persisted in LauncherState. */
  applicationDataDir: string;
  runtimeDir: string;
  logsDir: string;
  diagnosticsDir: string;
  configDir: string;
  stateDir: string;
  nodeExecutable: string;
  serverEntry: string;
  webDist: string;
  manifestPath: string;
  configPath: string;
  statePath: string;
  operationLockPath: string;
  stdoutLogPath: string;
  stderrLogPath: string;
}

export interface ProviderDiscovery {
  id: "codex" | "claude";
  installed: boolean;
  executable?: string;
  version?: string;
  authenticated?: boolean;
  authenticationDetail?: string;
  detail: string;
}

export interface PlatformAdapter {
  readonly platform: NodeJS.Platform;
  defaultDataDir(env?: NodeJS.ProcessEnv, homeDir?: string): string;
  nodeExecutableName(): string;
  executableCandidates(provider: "codex" | "claude", env?: NodeJS.ProcessEnv, homeDir?: string): string[];
  openBrowser(url: string): Promise<void>;
}

export interface LauncherOutput {
  write(message: string): void;
  error(message: string): void;
}

export interface LauncherDependencies {
  platform?: PlatformAdapter;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  output?: LauncherOutput;
  fetch?: typeof globalThis.fetch;
  spawnServer?: (paths: LauncherPaths, state: LauncherState, env: NodeJS.ProcessEnv) => Promise<number>;
}

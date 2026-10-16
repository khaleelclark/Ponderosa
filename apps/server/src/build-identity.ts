import { readFileSync } from "@ponderosa/native-host/fs";

interface InstalledBuildManifest {
  schemaVersion?: unknown;
  product?: unknown;
  version?: unknown;
  commit?: unknown;
  channel?: unknown;
  target?: { platform?: unknown; arch?: unknown };
}

export function assertProductionBuildIdentity(input: {
  releaseChannel?: string;
  buildRevision?: string;
  buildVersion?: string;
  manifestPath: string;
  platform?: NodeJS.Platform;
  arch?: string;
}): void {
  if (input.releaseChannel !== "production") return;
  const revision = input.buildRevision?.trim();
  const version = input.buildVersion?.trim();
  if (!revision || !/^[a-f0-9]{40}$/u.test(revision) || !version) {
    throw new Error("production startup requires exact PONDEROSA_BUILD_SHA and PONDEROSA_BUILD_VERSION");
  }
  let manifest: InstalledBuildManifest;
  try {
    const bytes = readFileSync(input.manifestPath);
    if (bytes.length > 64 * 1_024) throw new Error("manifest exceeds 64 KiB");
    manifest = JSON.parse(bytes.toString("utf8")) as InstalledBuildManifest;
  } catch (error) {
    throw new Error("production startup requires a readable installed build manifest", { cause: error });
  }
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  if (manifest.schemaVersion !== 1 || manifest.product !== "Ponderosa" ||
      manifest.channel !== "production" || manifest.commit !== revision ||
      manifest.version !== version || manifest.target?.platform !== platform ||
      manifest.target?.arch !== arch) {
    throw new Error("production build identity does not match the installed bundle manifest");
  }
}

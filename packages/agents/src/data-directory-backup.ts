import { fsyncDirectory } from "./store-filesystem.js";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "@ponderosa/native-host/fs";
import path from "node:path";
import { inspectCurrentState, STATE_SCHEMA_CONTRACT } from "./state-admission.js";

const MANIFEST = "ponderosa-backup-manifest.json";
const OMITTED_ROOT_ENTRIES = new Set([
  ".ponderosa-daemon.lock",
]);

export interface DataDirectoryBackupEntry {
  path: string;
  type: "file" | "directory" | "symlink";
  size?: number;
  sha256?: string;
  target?: string;
}

export interface DataDirectoryBackupManifest {
  schemaVersion: 3;
  stateEpoch: 2;
  generationId: string;
  schemaContract: string;
  createdAt: string;
  externalProjects: {
    policy: "excluded" | "included";
    projects: Array<{
      projectId: string;
      originalPath: string;
      snapshotPath: string;
      entries: DataDirectoryBackupEntry[];
    }>;
  };
  entries: DataDirectoryBackupEntry[];
}

export interface DataDirectoryBackupOptions {
  externalProjects?: "exclude" | "copy";
}

export interface DataDirectoryRestoreOptions {
  restoreExternalProjects?: boolean;
  /** Rehearsal-only remap. Each external root is restored below this directory
   * using its stable Project ID instead of its live original path. */
  externalRootParent?: string;
}

type RestoreJournal = {
  schemaVersion: 3;
  stateEpoch: 2;
  generationId: string;
  schemaContract: string;
  manifestSha256: string;
  backup: string;
  dataDir: string;
  stage: string;
  stageIdentity?: string;
  externalStages: Array<{ originalPath: string; stage: string; identity?: string }>;
  publishedExternal: string[];
  primaryPublished: boolean;
  committed: boolean;
};

function directoryIdentity(directory: string): string {
  const stat = lstatSync(directory, { bigint: true });
  if (!stat.isDirectory()) throw new Error(`restore root is not a directory: ${directory}`);
  return `${stat.dev}:${stat.ino}`;
}

function removePublishedRoot(root: string, identity: string): void {
  if (!existsSync(root)) return;
  if (directoryIdentity(root) !== identity) {
    throw new Error(`restore root identity changed; refusing unsafe recovery: ${root}`);
  }
  rmSync(root, { recursive: true, force: true });
  fsyncDirectory(path.dirname(root));
}

function safeRelative(relative: string): string {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || relative.split(path.sep).some(part => !part || part === "." || part === "..")) {
    throw new Error(`unsafe backup path: ${relative}`);
  }
  return relative;
}

function checksum(file: string): string {
  const hash = createHash("sha256");
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const buffer = Buffer.allocUnsafe(256 * 1024);
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function readRegularJson(pathname: string): unknown {
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("state control record is not a regular file");
    return JSON.parse(readFileSync(descriptor, "utf8"));
  } finally { closeSync(descriptor); }
}

function copyTree(source: string, destination: string): DataDirectoryBackupEntry[] {
  const entries: DataDirectoryBackupEntry[] = [];
  const visit = (relative: string): void => {
    const sourcePath = path.join(source, relative);
    const destinationPath = path.join(destination, relative);
    const stat = lstatSync(sourcePath);
    if (stat.isDirectory()) {
      mkdirSync(destinationPath, { mode: stat.mode & 0o777 });
      entries.push({ path: relative, type: "directory" });
      for (const child of readdirSync(sourcePath).sort()) {
        if (!relative && OMITTED_ROOT_ENTRIES.has(child)) continue;
        visit(path.join(relative, child));
      }
      fsyncDirectory(destinationPath);
      return;
    }
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(sourcePath);
      if (path.isAbsolute(target)) throw new Error(`backup refuses absolute symlink: ${relative}`);
      const resolved = path.resolve(path.dirname(sourcePath), target);
      if (resolved !== source && !resolved.startsWith(`${source}${path.sep}`)) {
        throw new Error(`backup refuses escaping symlink: ${relative}`);
      }
      symlinkSync(target, destinationPath);
      entries.push({ path: relative, type: "symlink", target });
      return;
    }
    if (!stat.isFile()) throw new Error(`backup refuses special filesystem entry: ${relative}`);
    copyFileSync(sourcePath, destinationPath);
    // Windows FlushFileBuffers requires write access; never truncate the copied bytes.
    const descriptor = openSync(destinationPath, process.platform === "win32" ? "r+" : "r");
    try { fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
    entries.push({ path: relative, type: "file", size: stat.size, sha256: checksum(destinationPath) });
  };
  for (const child of readdirSync(source).sort()) {
    if (OMITTED_ROOT_ENTRIES.has(child)) continue;
    visit(child);
  }
  return entries;
}

function externalProjectRoots(dataDir: string): Array<{ projectId: string; hostPath: string }> {
  const root = path.join(dataDir, "projects");
  if (!existsSync(root)) return [];
  const projects: Array<{ projectId: string; hostPath: string }> = [];
  for (const projectId of readdirSync(root).sort()) {
    const record = path.join(root, projectId, "project.json");
    if (!existsSync(record)) continue;
    const value = JSON.parse(readFileSync(record, "utf8")) as { id?: unknown; hostPath?: unknown };
    if (value.id !== projectId || typeof value.hostPath !== "string" || !path.isAbsolute(value.hostPath)) {
      throw new Error(`Project ${projectId} does not contain a valid absolute host path`);
    }
    projects.push({ projectId, hostPath: path.resolve(value.hostPath) });
  }
  return projects;
}

function verifyTree(
  root: string,
  entries: DataDirectoryBackupEntry[],
): void {
  for (const entry of entries) {
    const relative = safeRelative(entry.path);
    const source = path.join(root, relative);
    if (entry.type === "directory") {
      if (!lstatSync(source).isDirectory()) throw new Error(`backup directory changed: ${relative}`);
    } else if (entry.type === "file") {
      const stat = lstatSync(source);
      if (!stat.isFile() || stat.size !== entry.size || checksum(source) !== entry.sha256) {
        throw new Error(`backup checksum mismatch: ${relative}`);
      }
    } else if (entry.type === "symlink") {
      if (typeof entry.target !== "string" || path.isAbsolute(entry.target) ||
          readlinkSync(source) !== entry.target) {
        throw new Error(`backup symlink mismatch: ${relative}`);
      }
      const resolved = path.resolve(path.dirname(source), entry.target);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        throw new Error(`backup contains escaping symlink: ${relative}`);
      }
    } else {
      throw new Error(`unsupported backup entry: ${relative}`);
    }
  }
}

function verifyCompleteTree(root: string, entries: DataDirectoryBackupEntry[], skipped: ReadonlySet<string> = new Set(), containers: ReadonlySet<string> = new Set()): void {
  verifyTree(root, entries);
  const declared = entries.map(entry => safeRelative(entry.path)).sort();
  if (new Set(declared).size !== declared.length) throw new Error("backup has duplicate paths");
  const actual: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory)) {
      const relative = prefix ? path.join(prefix, name) : name;
      if (skipped.has(relative)) continue;
      if (!containers.has(relative)) actual.push(relative);
      const child = path.join(directory, name);
      if (lstatSync(child).isDirectory()) visit(child, relative);
    }
  };
  visit(root, "");
  if (JSON.stringify(actual.sort()) !== JSON.stringify(declared)) throw new Error("backup tree is incomplete or contains unlisted bytes");
}

function restoreTree(
  sourceRoot: string,
  destinationRoot: string,
  entries: DataDirectoryBackupEntry[],
): void {
  verifyTree(sourceRoot, entries);
  for (const entry of entries) {
    const relative = safeRelative(entry.path);
    const source = path.join(sourceRoot, relative);
    const destination = path.join(destinationRoot, relative);
    if (entry.type === "directory") {
      mkdirSync(destination, { recursive: true, mode: 0o700 });
    } else if (entry.type === "file") {
      mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      copyFileSync(source, destination);
      const descriptor = openSync(destination, process.platform === "win32" ? "r+" : "r");
      try { fsyncSync(descriptor); }
      finally { closeSync(descriptor); }
    } else {
      const target = entry.target!;
      const resolved = path.resolve(path.dirname(destination), target);
      if (resolved !== destinationRoot && !resolved.startsWith(`${destinationRoot}${path.sep}`)) {
        throw new Error(`backup contains escaping symlink: ${relative}`);
      }
      mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      symlinkSync(target, destination);
    }
  }
  fsyncDirectory(destinationRoot);
}

function writeManifest(directory: string, manifest: DataDirectoryBackupManifest): void {
  const target = path.join(directory, MANIFEST);
  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const descriptor = openSync(target, process.platform === "win32" ? "r+" : "r");
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  fsyncDirectory(directory);
}

function writeRestoreJournal(pathname: string, journal: RestoreJournal): void {
  const temporary = `${pathname}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(journal)}\n`, { flag: "wx", mode: 0o600 });
  const descriptor = openSync(temporary, process.platform === "win32" ? "r+" : "r");
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  renameSync(temporary, pathname);
  fsyncDirectory(path.dirname(pathname));
}

function recoverRestoreJournal(
  pathname: string,
  backup: string,
  dataDir: string,
  externalBindings: ReadonlyMap<string, DataDirectoryBackupManifest["externalProjects"]["projects"][number]>,
  manifest: DataDirectoryBackupManifest,
  manifestSha256: string,
): boolean {
  if (!existsSync(pathname)) return false;
  const journal = readRegularJson(pathname) as RestoreJournal;
  const valid = journal.schemaVersion === 3 && journal.stateEpoch === 2 &&
    journal.generationId === manifest.generationId && journal.schemaContract === STATE_SCHEMA_CONTRACT &&
    journal.manifestSha256 === manifestSha256 &&
    journal.backup === backup &&
    journal.dataDir === dataDir && typeof journal.stage === "string" &&
    journal.stage.startsWith(`${dataDir}.restore-`) && path.dirname(journal.stage) === path.dirname(dataDir) &&
    /^[0-9a-f-]{36}$/u.test(journal.stage.slice(`${dataDir}.restore-`.length)) &&
    Array.isArray(journal.externalStages) && Array.isArray(journal.publishedExternal) &&
    typeof journal.primaryPublished === "boolean" && typeof journal.committed === "boolean" &&
    journal.externalStages.every(entry => entry &&
      externalBindings.has(entry.originalPath) &&
      entry.stage.startsWith(`${entry.originalPath}.restore-`) && path.dirname(entry.stage) === path.dirname(entry.originalPath) &&
      /^[0-9a-f-]{36}$/u.test(entry.stage.slice(`${entry.originalPath}.restore-`.length)) &&
      typeof entry.identity === "string") &&
    (typeof journal.stageIdentity === "string" &&
        journal.publishedExternal.length === journal.externalStages.length &&
        journal.externalStages.every(entry => journal.publishedExternal.includes(entry.originalPath))) &&
    journal.publishedExternal.every(root => externalBindings.has(root));
  if (!valid) throw new Error("restore journal is invalid; refusing unsafe recovery");
  const proofs: Array<ReturnType<typeof inspectCurrentState>> = [];
  try {
  // Every root about to be deleted or considered committed must still be the
  // exact complete same-generation copy. Changed/unprovable bytes are retained.
  for (const root of [journal.stage, dataDir]) {
    if (!existsSync(root)) continue;
    if (directoryIdentity(root) !== journal.stageIdentity) throw new Error("restore root identity changed");
    const proof = inspectCurrentState(root);
    proofs.push(proof);
    if (proof.generationId !== manifest.generationId) throw new Error("restore generation changed");
    verifyCompleteTree(proof.dataDir, manifest.entries);
  }
  for (const entry of journal.externalStages) {
    const project = externalBindings.get(entry.originalPath);
    if (!project) throw new Error("restore external root is unbound");
    for (const root of [entry.stage, entry.originalPath]) {
      if (!existsSync(root)) continue;
      if (directoryIdentity(root) !== entry.identity) throw new Error("restore external root identity changed");
      verifyCompleteTree(root, project.entries);
    }
  }
  // Verification leases pin directories on Windows. Release them only after
  // every bound root has been verified, before journal recovery mutates names.
  for (const proof of proofs) proof.close();
  proofs.length = 0;
  if (journal.committed) {
    if (!existsSync(dataDir) || journal.publishedExternal.some(root => !existsSync(root))) {
      throw new Error("committed restore journal does not match its published roots");
    }
    if ((directoryIdentity(dataDir) !== journal.stageIdentity ||
          journal.externalStages.some(entry =>
            directoryIdentity(entry.originalPath) !== entry.identity))) {
      throw new Error("committed restore journal root identity changed");
    }
    rmSync(pathname, { force: true });
    fsyncDirectory(path.dirname(pathname));
    return true;
  }
  removePublishedRoot(dataDir, journal.stageIdentity!);
  for (const entry of journal.externalStages) removePublishedRoot(entry.originalPath, entry.identity!);
  rmSync(journal.stage, { recursive: true, force: true });
  for (const entry of journal.externalStages) {
    rmSync(entry.stage, { recursive: true, force: true });
  }
  rmSync(pathname, { force: true });
  fsyncDirectory(path.dirname(pathname));
  return false;
  } finally { for (const proof of proofs) proof.close(); }
}

export function createOfflineDataDirectoryBackup(
  dataDir: string,
  output: string,
  options: DataDirectoryBackupOptions = {},
): DataDirectoryBackupManifest {
  const absoluteDataDir = path.resolve(dataDir);
  const absoluteOutput = path.resolve(output);
  if (absoluteOutput === absoluteDataDir || absoluteOutput.startsWith(`${absoluteDataDir}${path.sep}`)) {
    throw new Error("backup output must be outside the Ponderosa data directory");
  }
  if (existsSync(absoluteOutput)) throw new Error("backup output already exists");
  const stage = `${absoluteOutput}.partial-${randomUUID()}`;
  let ownership: ReturnType<typeof inspectCurrentState> | undefined;
  try {
    ownership = inspectCurrentState(absoluteDataDir);
    const externalRoots = externalProjectRoots(ownership.dataDir);
    if (options.externalProjects === "copy") {
      for (const project of externalRoots) {
        if (!existsSync(project.hostPath) || !lstatSync(project.hostPath).isDirectory()) {
          throw new Error(`external Project root is unavailable: ${project.hostPath}`);
        }
        if (absoluteOutput === project.hostPath || absoluteOutput.startsWith(`${project.hostPath}${path.sep}`)) {
          throw new Error(`backup output must be outside external Project ${project.projectId}`);
        }
      }
    }
    mkdirSync(path.dirname(absoluteOutput), { recursive: true, mode: 0o700 });
    mkdirSync(stage, { mode: 0o700 });
    const externalProjects: DataDirectoryBackupManifest["externalProjects"] = {
      policy: options.externalProjects === "copy" ? "included" : "excluded",
      projects: [],
    };
    if (options.externalProjects === "copy") {
      for (const [index, project] of externalRoots.entries()) {
        const snapshotPath = path.posix.join("_external-projects", `${index}-${project.projectId}`);
        const destination = path.join(stage, snapshotPath);
        mkdirSync(destination, { recursive: true, mode: 0o700 });
        externalProjects.projects.push({
          projectId: project.projectId,
          originalPath: project.hostPath,
          snapshotPath,
          entries: copyTree(project.hostPath, destination),
        });
      }
    }
    const manifest: DataDirectoryBackupManifest = {
      schemaVersion: 3, stateEpoch: 2, generationId: ownership.generationId, schemaContract: STATE_SCHEMA_CONTRACT,
      createdAt: new Date().toISOString(),
      externalProjects,
      entries: copyTree(ownership.dataDir, stage),
    };
    verifyCompleteTree(ownership.dataDir, manifest.entries, OMITTED_ROOT_ENTRIES);
    const copiedExternal = new Set(manifest.externalProjects.projects.map(project => path.normalize(project.snapshotPath)));
    verifyCompleteTree(stage, manifest.entries, copiedExternal, new Set(copiedExternal.size ? ["_external-projects"] : []));
    for (const project of manifest.externalProjects.projects) {
      verifyCompleteTree(path.join(stage, project.snapshotPath), project.entries);
      verifyCompleteTree(project.originalPath, project.entries);
    }
    writeManifest(stage, manifest);
    renameSync(stage, absoluteOutput);
    fsyncDirectory(path.dirname(absoluteOutput));
    return manifest;
  } catch (error) {
    throw new Error(`backup refused; any partial stage is preserved at ${stage}`, { cause: error });
  } finally {
    ownership?.close();
  }
}

export function restoreOfflineDataDirectoryBackup(
  backup: string,
  dataDir: string,
  options: DataDirectoryRestoreOptions = {},
): DataDirectoryBackupManifest {
  const absoluteBackup = path.resolve(backup);
  const absoluteDataDir = path.resolve(dataDir);
  if (absoluteDataDir === absoluteBackup || absoluteDataDir.startsWith(`${absoluteBackup}${path.sep}`)) {
    throw new Error("restore destination must be outside the backup directory");
  }
  const sourceProof = inspectCurrentState(absoluteBackup);
  try {
  const manifest = readRegularJson(path.join(sourceProof.dataDir, MANIFEST)) as DataDirectoryBackupManifest;
  if (manifest.schemaVersion !== 3 || manifest.stateEpoch !== 2 || manifest.generationId !== sourceProof.generationId ||
      manifest.schemaContract !== STATE_SCHEMA_CONTRACT || !manifest.externalProjects ||
      !["excluded", "included"].includes(manifest.externalProjects.policy) ||
      !Array.isArray(manifest.externalProjects.projects) || !Array.isArray(manifest.entries)) {
    throw new Error("unsupported Ponderosa backup manifest");
  }
  const externalRootParent = options.externalRootParent
    ? path.resolve(options.externalRootParent)
    : undefined;
  const externalRestoreDestination = (project: { projectId: string; originalPath: string }): string => {
    if (!externalRootParent) return path.resolve(project.originalPath);
    if (!/^[A-Za-z0-9_-]{1,200}$/u.test(project.projectId)) {
      throw new Error(`invalid external Project identity: ${project.projectId}`);
    }
    const destination = path.resolve(externalRootParent, project.projectId);
    if (!destination.startsWith(`${externalRootParent}${path.sep}`)) {
      throw new Error(`unsafe external Project rehearsal destination: ${project.projectId}`);
    }
    return destination;
  };
  const externalBindings = new Map<string, DataDirectoryBackupManifest["externalProjects"]["projects"][number]>();
  const snapshots = new Set<string>();
  const projectIds = new Set<string>();
  for (const project of manifest.externalProjects.projects) {
    if (!project || typeof project.projectId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/u.test(project.projectId) ||
        typeof project.originalPath !== "string" || !path.isAbsolute(project.originalPath) ||
        typeof project.snapshotPath !== "string" || !Array.isArray(project.entries) ||
        !/^_external-projects\/[0-9]+-[A-Za-z0-9_-]{1,200}$/u.test(project.snapshotPath) ||
        snapshots.has(project.snapshotPath) || projectIds.has(project.projectId)) {
      throw new Error("invalid or duplicate external Project backup binding");
    }
    snapshots.add(project.snapshotPath); projectIds.add(project.projectId);
    if (options.restoreExternalProjects) {
      const destination = externalRestoreDestination(project);
      if (externalBindings.has(destination)) throw new Error("duplicate external destination binding");
      externalBindings.set(destination, project);
    }
  }
  const sourceRoot = sourceProof.dataDir;
  const externalContainers = new Set(manifest.externalProjects.projects.length ? ["_external-projects"] : []);
  const skipped = new Set([MANIFEST, ...manifest.externalProjects.projects.map(project => path.normalize(safeRelative(project.snapshotPath)))]);
  verifyCompleteTree(sourceRoot, manifest.entries, skipped, externalContainers);
  for (const project of manifest.externalProjects.projects) verifyCompleteTree(path.join(sourceRoot, safeRelative(project.snapshotPath)), project.entries);
  const manifestSha256 = checksum(path.join(sourceRoot, MANIFEST));
  const journalPath = `${absoluteDataDir}.restore-journal.json`;
  if (recoverRestoreJournal(
    journalPath,
    absoluteBackup,
    absoluteDataDir,
    externalBindings, manifest, manifestSha256,
  )) return manifest;
  if (existsSync(absoluteDataDir)) throw new Error("restore destination already exists");
  const stage = `${absoluteDataDir}.restore-${randomUUID()}`;
  if (existsSync(stage)) throw new Error("restore stage already exists");
  mkdirSync(path.dirname(absoluteDataDir), { recursive: true, mode: 0o700 });
  mkdirSync(stage, { mode: 0o700 });
  const externalStages = new Map<string, string>();
  let primaryPublished = false;
  let journalWritten = false;
  let stagedProof: ReturnType<typeof inspectCurrentState> | undefined;
  try {
    restoreTree(sourceRoot, stage, manifest.entries);
    stagedProof = inspectCurrentState(stage);
    if (stagedProof.generationId !== manifest.generationId) throw new Error("staged restore generation changed");
    verifyCompleteTree(stagedProof.dataDir, manifest.entries);
    if (!existsSync(path.join(stage, ".ponderosa-layout-version"))) {
      throw new Error("backup does not contain a Ponderosa layout marker");
    }
    for (const project of manifest.externalProjects.projects) {
      if (!project || typeof project.projectId !== "string" || !project.projectId ||
          typeof project.originalPath !== "string" ||
          typeof project.snapshotPath !== "string" ||
          !Array.isArray(project.entries)) {
        throw new Error("invalid external Project backup entry");
      }
      const snapshotRoot = path.resolve(sourceRoot, safeRelative(project.snapshotPath));
      if (snapshotRoot !== sourceRoot && !snapshotRoot.startsWith(`${sourceRoot}${path.sep}`)) {
        throw new Error(`unsafe external Project snapshot path: ${project.snapshotPath}`);
      }
      verifyTree(snapshotRoot, project.entries);
      if (!options.restoreExternalProjects) continue;
      const originalPath = externalRestoreDestination(project);
      if (!path.isAbsolute(project.originalPath) || existsSync(originalPath)) {
        throw new Error(`external Project restore destination must be an absent absolute path: ${project.originalPath}`);
      }
      if (externalStages.has(originalPath)) {
        throw new Error(`duplicate external Project restore destination: ${project.originalPath}`);
      }
      const externalStage = `${originalPath}.restore-${randomUUID()}`;
      if (existsSync(externalStage)) throw new Error("external restore stage already exists");
      mkdirSync(externalStage, { recursive: true, mode: 0o700 });
      try {
        restoreTree(snapshotRoot, externalStage, project.entries);
        verifyCompleteTree(externalStage, project.entries);
        externalStages.set(originalPath, externalStage);
      } catch (error) {
        throw new Error(`external restore staging is preserved at ${externalStage}`, { cause: error });
      }
    }
    // Every checksum, path, destination and staged tree is valid before the
    // first authoritative rename. Cross-filesystem roots cannot share one
    // atomic transaction. The durable journal makes every published root
    // rollback-safe across both late failures and process interruption.
    const stageIdentity = directoryIdentity(stage);
    const externalStageEntries = [...externalStages].map(([originalPath, staged]) => ({
      originalPath,
      stage: staged,
      identity: directoryIdentity(staged),
    }));
    const journal = (): RestoreJournal => ({
      schemaVersion: 3, stateEpoch: 2, generationId: manifest.generationId, schemaContract: STATE_SCHEMA_CONTRACT, manifestSha256,
      backup: absoluteBackup,
      dataDir: absoluteDataDir,
      stage,
      stageIdentity,
      externalStages: externalStageEntries,
      // Durable intent for *all* destinations precedes the first rename.
      publishedExternal: [...externalStages.keys()],
      primaryPublished,
      committed: primaryPublished,
    });
    writeRestoreJournal(journalPath, journal());
    journalWritten = true;
    for (const [originalPath, externalStage] of externalStages) {
      renameSync(externalStage, originalPath);
      fsyncDirectory(path.dirname(originalPath));
    }
    fsyncDirectory(stage);
    // All bytes and the durable publication intent are verified above. The
    // Windows directory lease must close before publishing the staged root.
    stagedProof.close(); stagedProof = undefined;
    renameSync(stage, absoluteDataDir);
    primaryPublished = true;
    fsyncDirectory(path.dirname(absoluteDataDir));
    writeRestoreJournal(journalPath, journal());
    rmSync(journalPath, { force: true });
    fsyncDirectory(path.dirname(journalPath));
    return manifest;
  } catch (error) {
    if (journalWritten) {
      stagedProof?.close(); stagedProof = undefined;
      try {
        if (recoverRestoreJournal(journalPath, absoluteBackup, absoluteDataDir, externalBindings, manifest, manifestSha256)) {
          return manifest;
        }
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "restore failed and rollback was incomplete");
      }
      throw error;
    }
    // No durable bound journal exists. Preserve all partial staging, including
    // uncertain journal writes; filenames alone never authorize deletion.
    throw new Error(`restore staging is preserved at ${stage}`, { cause: error });
  }
  finally { stagedProof?.close(); }
  } finally { sourceProof.close(); }

}

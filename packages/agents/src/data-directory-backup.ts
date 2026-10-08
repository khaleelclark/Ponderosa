import { fsyncDirectory } from "./store-filesystem.js";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
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
} from "node:fs";
import path from "node:path";
import {
  acquireDataDirectoryOwnership,
  ensureCurrentDataLayout,
  releaseDataDirectoryOwnership,
} from "./store-data-directory.js";

const MANIFEST = "ponderosa-backup-manifest.json";
const OMITTED_ROOT_ENTRIES = new Set([
  ".ponderosa-daemon.lock",
  ".projection-clean-shutdown.json",
  "browser-sessions",
]);

export interface DataDirectoryBackupEntry {
  path: string;
  type: "file" | "directory" | "symlink";
  size?: number;
  sha256?: string;
  target?: string;
}

export interface DataDirectoryBackupManifest {
  schemaVersion: 2;
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
  schemaVersion: 1 | 2;
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
  if (!relative || path.isAbsolute(relative) || relative.split(path.sep).includes("..")) {
    throw new Error(`unsafe backup path: ${relative}`);
  }
  return relative;
}

function checksum(file: string): string {
  const hash = createHash("sha256");
  const descriptor = openSync(file, "r");
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
    const descriptor = openSync(destinationPath, "r");
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
      const descriptor = openSync(destination, "r");
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
  const descriptor = openSync(target, "r");
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  fsyncDirectory(directory);
}

function writeRestoreJournal(pathname: string, journal: RestoreJournal): void {
  const temporary = `${pathname}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(journal)}\n`, { flag: "wx", mode: 0o600 });
  const descriptor = openSync(temporary, "r");
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  renameSync(temporary, pathname);
  fsyncDirectory(path.dirname(pathname));
}

function recoverRestoreJournal(
  pathname: string,
  backup: string,
  dataDir: string,
  allowedExternalRoots: ReadonlySet<string>,
): boolean {
  if (!existsSync(pathname)) return false;
  const journal = JSON.parse(readFileSync(pathname, "utf8")) as RestoreJournal;
  const valid = (journal.schemaVersion === 1 || journal.schemaVersion === 2) &&
    journal.backup === backup &&
    journal.dataDir === dataDir && typeof journal.stage === "string" &&
    journal.stage.startsWith(`${dataDir}.restore-`) &&
    Array.isArray(journal.externalStages) && Array.isArray(journal.publishedExternal) &&
    typeof journal.primaryPublished === "boolean" && typeof journal.committed === "boolean" &&
    journal.externalStages.every(entry => entry &&
      allowedExternalRoots.has(entry.originalPath) &&
      entry.stage.startsWith(`${entry.originalPath}.restore-`) &&
      (journal.schemaVersion === 1 || typeof entry.identity === "string")) &&
    (journal.schemaVersion === 1 ||
      (typeof journal.stageIdentity === "string" &&
        journal.publishedExternal.length === journal.externalStages.length &&
        journal.externalStages.every(entry => journal.publishedExternal.includes(entry.originalPath)))) &&
    journal.publishedExternal.every(root => allowedExternalRoots.has(root));
  if (!valid) throw new Error("restore journal is invalid; refusing unsafe recovery");
  if (journal.schemaVersion === 1 && journal.externalStages.some(entry =>
    !journal.publishedExternal.includes(entry.originalPath) &&
    !existsSync(entry.stage) && existsSync(entry.originalPath))) {
    // Old journals recorded external publication only after rename. Their
    // crash gap has no durable ownership identity; keep the journal and root
    // intact for explicit recovery instead of losing the last evidence.
    throw new Error("legacy restore journal has an unrecorded external root; manual recovery is required");
  }
  if (journal.committed) {
    if (!existsSync(dataDir) || journal.publishedExternal.some(root => !existsSync(root))) {
      throw new Error("committed restore journal does not match its published roots");
    }
    if (journal.schemaVersion === 2 &&
        (directoryIdentity(dataDir) !== journal.stageIdentity ||
          journal.externalStages.some(entry =>
            directoryIdentity(entry.originalPath) !== entry.identity))) {
      throw new Error("committed restore journal root identity changed");
    }
    rmSync(pathname, { force: true });
    fsyncDirectory(path.dirname(pathname));
    return true;
  }
  if (journal.schemaVersion === 2) {
    // The intent and each staged directory's inode were durable before any
    // publication. A crash between rename and the next journal write is safe:
    // remove only the exact directory that was staged, never a foreign root.
    removePublishedRoot(dataDir, journal.stageIdentity!);
    for (const entry of journal.externalStages) {
      removePublishedRoot(entry.originalPath, entry.identity!);
    }
  } else {
    if (journal.primaryPublished || existsSync(dataDir)) {
      rmSync(dataDir, { recursive: true, force: true });
    }
    for (const root of journal.publishedExternal) {
      rmSync(root, { recursive: true, force: true });
      fsyncDirectory(path.dirname(root));
    }
  }
  rmSync(journal.stage, { recursive: true, force: true });
  for (const entry of journal.externalStages) {
    rmSync(entry.stage, { recursive: true, force: true });
  }
  rmSync(pathname, { force: true });
  fsyncDirectory(path.dirname(pathname));
  return false;
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
  mkdirSync(path.dirname(absoluteOutput), { recursive: true, mode: 0o700 });
  const stage = `${absoluteOutput}.partial-${process.pid}`;
  if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  let ownership: ReturnType<typeof acquireDataDirectoryOwnership> | undefined;
  try {
    ownership = acquireDataDirectoryOwnership(absoluteDataDir);
    ensureCurrentDataLayout(ownership.dataDir);
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
    mkdirSync(stage, { mode: 0o700 });
    const externalProjects: DataDirectoryBackupManifest["externalProjects"] = {
      policy: options.externalProjects === "copy" ? "included" : "excluded",
      projects: [],
    };
    if (options.externalProjects === "copy") {
      for (const [index, project] of externalRoots.entries()) {
        const snapshotPath = path.join("_external-projects", `${index}-${project.projectId}`);
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
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
      externalProjects,
      entries: copyTree(ownership.dataDir, stage),
    };
    writeManifest(stage, manifest);
    renameSync(stage, absoluteOutput);
    fsyncDirectory(path.dirname(absoluteOutput));
    return manifest;
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  } finally {
    releaseDataDirectoryOwnership(ownership);
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
  const manifest = JSON.parse(readFileSync(path.join(absoluteBackup, MANIFEST), "utf8")) as DataDirectoryBackupManifest;
  if (manifest.schemaVersion !== 2 || !manifest.externalProjects ||
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
  const allowedExternalRoots = new Set(
    manifest.externalProjects.projects
      .filter(project => project && typeof project.originalPath === "string" &&
        typeof project.projectId === "string")
      .map(project => externalRestoreDestination(project as {
        projectId: string;
        originalPath: string;
      })),
  );
  const journalPath = `${absoluteDataDir}.restore-journal.json`;
  if (recoverRestoreJournal(
    journalPath,
    absoluteBackup,
    absoluteDataDir,
    allowedExternalRoots,
  )) return manifest;
  if (existsSync(absoluteDataDir)) throw new Error("restore destination already exists");
  const stage = `${absoluteDataDir}.restore-${process.pid}`;
  if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  mkdirSync(path.dirname(absoluteDataDir), { recursive: true, mode: 0o700 });
  mkdirSync(stage, { mode: 0o700 });
  const externalStages = new Map<string, string>();
  const publishedExternal: string[] = [];
  let primaryPublished = false;
  let journalWritten = false;
  try {
    restoreTree(absoluteBackup, stage, manifest.entries);
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
      const snapshotRoot = path.resolve(absoluteBackup, safeRelative(project.snapshotPath));
      if (snapshotRoot !== absoluteBackup && !snapshotRoot.startsWith(`${absoluteBackup}${path.sep}`)) {
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
      const externalStage = `${originalPath}.restore-${process.pid}`;
      if (existsSync(externalStage)) rmSync(externalStage, { recursive: true, force: true });
      mkdirSync(externalStage, { recursive: true, mode: 0o700 });
      try {
        restoreTree(snapshotRoot, externalStage, project.entries);
        externalStages.set(originalPath, externalStage);
      } catch (error) {
        rmSync(externalStage, { recursive: true, force: true });
        throw error;
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
      schemaVersion: 2,
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
      publishedExternal.push(originalPath);
    }
    fsyncDirectory(stage);
    renameSync(stage, absoluteDataDir);
    primaryPublished = true;
    fsyncDirectory(path.dirname(absoluteDataDir));
    writeRestoreJournal(journalPath, journal());
    rmSync(journalPath, { force: true });
    fsyncDirectory(path.dirname(journalPath));
    return manifest;
  } catch (error) {
    if (journalWritten) {
      try {
        if (recoverRestoreJournal(journalPath, absoluteBackup, absoluteDataDir, allowedExternalRoots)) {
          return manifest;
        }
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "restore failed and rollback was incomplete");
      }
      throw error;
    }
    const cleanupErrors: unknown[] = [];
    try { if (primaryPublished) rmSync(absoluteDataDir, { recursive: true, force: true }); }
    catch (cleanupError) { cleanupErrors.push(cleanupError); }
    for (const originalPath of publishedExternal) {
      try { rmSync(originalPath, { recursive: true, force: true }); }
      catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    try { rmSync(stage, { recursive: true, force: true }); }
    catch (cleanupError) { cleanupErrors.push(cleanupError); }
    for (const externalStage of externalStages.values()) {
      try { rmSync(externalStage, { recursive: true, force: true }); }
      catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (journalWritten && cleanupErrors.length === 0) {
      rmSync(journalPath, { force: true });
      fsyncDirectory(path.dirname(journalPath));
    }
    if (cleanupErrors.length) {
      throw new AggregateError([error, ...cleanupErrors], "restore failed and rollback was incomplete");
    }
    throw error;
  }
}

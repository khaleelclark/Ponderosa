import { fsyncDirectory } from "./store-filesystem.js";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { storageDatabaseFilename } from "@ponderosa/native-host/sqlite-storage";
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
  realpathSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "@ponderosa/native-host/fs";
import path from "node:path";
import { inspectCurrentState, STATE_SCHEMA_CONTRACT } from "./state-admission.js";
import { managedWorkspacePath } from "./managed-workspaces.js";
import { creationId } from "./store-workspace-catalog-authority.js";

const MANIFEST = "ponderosa-backup-manifest.json";
const WEB_DEPLOYMENT_MANIFEST = "ponderosa-web-deployment-backup.json";
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

function backupDestination(dataDir: string, output: string): string {
  let parent = path.resolve(output);
  const missing: string[] = [];
  while (!lstatSync(parent, { throwIfNoEntry: false })) {
    const next = path.dirname(parent);
    if (next === parent) throw new Error("backup destination has no accessible parent");
    missing.unshift(path.basename(parent)); parent = next;
  }
  const physicalParent = realpathSync(parent);
  if (!lstatSync(physicalParent).isDirectory()) throw new Error("backup parent is not a directory");
  const destination = path.join(physicalParent, ...missing), root = realpathSync(dataDir);
  if (destination === root || destination.startsWith(`${root}${path.sep}`)) throw new Error("backup output must be outside the Ponderosa data directory");
  if (lstatSync(destination, { throwIfNoEntry: false })) throw new Error("backup output already exists");
  return destination;
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

function copyTree(source: string, destination: string, omitted = OMITTED_ROOT_ENTRIES): DataDirectoryBackupEntry[] {
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
    if (omitted.has(child)) continue;
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

function writeManifest(directory: string, manifest: DataDirectoryBackupManifest, filename = MANIFEST): void {
  const target = path.join(directory, filename);
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

export interface WebDeploymentCompatibility {
  currentCommit: string;
  candidateCommit: string;
  currentManifestSha256: string;
  candidateManifestSha256: string;
  installedPayloadSha256: string;
}

/** ponytail: only an unchanged installed engine qualifies. Backend/storage changes
 * keep the full backup path until a separately qualified format contract exists. */
export function assertWebOnlyDeploymentCompatibility(currentRoot: string, candidateRoot: string): WebDeploymentCompatibility {
  const identity = (directory: string) => {
    if (!lstatSync(directory).isDirectory()) throw new Error("installed artifact root must be a physical directory");
    const root = realpathSync(directory);
    const manifestFile = path.join(root, "build-manifest.json");
    if (!existsSync(manifestFile)) throw new Error("web-only deployment requires a qualified standard build manifest; private or unknown artifacts require the full backup path");
    const parsed = readRegularJson(manifestFile);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("installed build manifest must be an object");
    const value = parsed as Record<string, any>;
    const string = (input: unknown): input is string => typeof input === "string" && input.length > 0;
    const hash = (input: unknown): input is string => string(input) && /^[a-f0-9]{64}$/u.test(input);
    if (value.schemaVersion !== 1 || value.product !== "Ponderosa" || !string(value.commit) ||
        !/^[a-f0-9]{40}$/u.test(value.commit) || !string(value.version) || !string(value.channel) ||
        !string(value.communicationProtocolVersion) || !string(value.databaseSchemaVersion) ||
        path.basename(value.databaseSchemaVersion) !== value.databaseSchemaVersion ||
        !hash(value.databaseSchemaSha256) || !hash(value.nodeExecutableSha256) ||
        !string(value.nodeVersion) || !string(value.target?.platform) || !string(value.target?.arch) ||
        !string(value.nativeAbi?.modules) || !string(value.nativeAbi?.napi) || !hash(value.nativeHost?.sha256) ||
        !Number.isSafeInteger(value.nodeExecutableBytes) || value.nodeExecutableBytes < 1 ||
        !Number.isSafeInteger(value.nativeHost.bytes) || value.nativeHost.bytes < 1) {
      throw new Error("web-only deployment requires a complete installed build manifest");
    }
    const app = path.join(root, "app");
    if (!lstatSync(app).isDirectory() || !lstatSync(path.join(app, "web")).isDirectory()) {
      throw new Error("installed application owners must be physical directories");
    }
    const owners = readdirSync(app).sort();
    if (!["server", "launcher", "web"].every(name => owners.includes(name)) ||
        owners.some(name => !["server", "launcher", "engine-desktop", "web"].includes(name))) {
      throw new Error("unknown installed application owner; use the full backup path");
    }
    const payloads = [...owners.filter(name => name !== "web").map(name => `app/${name}`), "runtime", "schema",
      "package.json", "ponderosa", "ponderosa.cmd"];
    const contained = (pathname: string) => payloads.some(owner => {
      const boundary = path.join(root, owner);
      return pathname === boundary || pathname.startsWith(`${boundary}${path.sep}`);
    });
    const records: unknown[] = [];
    const visit = (relative: string): void => {
      const pathname = path.join(root, relative), stat = lstatSync(pathname);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(pathname);
        if (path.isAbsolute(target) || !contained(realpathSync(pathname))) {
          throw new Error("installed payload link escapes verified engine bytes");
        }
        records.push([relative, "symlink", target]);
      } else if (stat.isDirectory()) {
        records.push([relative, "directory", stat.mode & 0o777]);
        for (const child of readdirSync(pathname).sort()) visit(path.join(relative, child));
      } else if (stat.isFile()) {
        records.push([relative, "file", stat.mode & 0o777, stat.size, checksum(pathname)]);
      } else throw new Error("installed payload contains a special filesystem entry");
    };
    for (const owner of payloads) visit(owner);
    const verify = (pathname: string, expected: string, bytes?: number): void => {
      if (!contained(realpathSync(pathname)) || !lstatSync(pathname).isFile() ||
          (bytes !== undefined && lstatSync(pathname).size !== bytes) || checksum(pathname) !== expected) {
        throw new Error("installed payload differs from its build manifest");
      }
    };
    verify(path.join(root, "runtime", value.target.platform === "win32" ? "node.exe" : "node"),
      value.nodeExecutableSha256, value.nodeExecutableBytes);
    verify(path.join(root, "schema", value.databaseSchemaVersion), value.databaseSchemaSha256);
    for (const application of ["server", "launcher"]) {
      const entry = createRequire(path.join(app, application, "package.json")).resolve("@ponderosa/native-host");
      verify(path.resolve(path.dirname(entry), "../build/Release/ponderosa_native.node"), value.nativeHost.sha256, value.nativeHost.bytes);
    }
    return {
      commit: value.commit as string,
      manifest: checksum(manifestFile),
      payload: createHash("sha256").update(JSON.stringify(records)).digest("hex"),
      contract: JSON.stringify([value.communicationProtocolVersion, value.databaseSchemaVersion, value.databaseSchemaSha256,
        value.target.platform, value.target.arch, value.nodeVersion, value.nodeExecutableSha256,
        value.nativeAbi.modules, value.nativeAbi.napi, value.nativeHost.bytes, value.nativeHost.sha256]),
    };
  };
  const current = identity(currentRoot), candidate = identity(candidateRoot);
  if (current.contract !== candidate.contract || current.payload !== candidate.payload) {
    throw new Error("engine, runtime or storage identity changed; use the full backup and restore-rehearsal path");
  }
  return { currentCommit: current.commit, candidateCommit: candidate.commit,
    currentManifestSha256: current.manifest, candidateManifestSha256: candidate.manifest,
    installedPayloadSha256: current.payload };
}

export interface WebDeploymentBackupManifest extends DataDirectoryBackupManifest {
  scope: "web-deployment-only-not-disaster-recovery";
  source: { path: string; physicalIdentity: string };
  compatibility: WebDeploymentCompatibility;
  preservedWorkingFolders: Array<{ projectId: string; path: string; physicalIdentity: string }>;
}

/** This snapshot cannot undo canonical writes. Compatible rollback changes code
 * and configuration while retaining the current data and working folders. */
export function createOfflineWebDeploymentBackup(
  dataDir: string, output: string, artifacts: { currentRoot: string; candidateRoot: string },
): WebDeploymentBackupManifest {
  const compatibility = assertWebOnlyDeploymentCompatibility(artifacts.currentRoot, artifacts.candidateRoot);
  const absoluteDataDir = path.resolve(dataDir), absoluteOutput = backupDestination(dataDir, output);
  const stage = `${absoluteOutput}.partial-${randomUUID()}`;
  const ownership = inspectCurrentState(absoluteDataDir);
  try {
    // Inspection already holds the offline lease and verified this disposable
    // SQLite cohort. Never open the retained original for backup metadata.
    const catalog = new Database(storageDatabaseFilename(path.join(ownership.snapshotRoot, "ponderosa.db")), { readonly: true, fileMustExist: true });
    try {
      const bindings = (): WebDeploymentBackupManifest["preservedWorkingFolders"] => {
        const projects = externalProjectRoots(ownership.dataDir);
        const workspaces = path.join(ownership.dataDir, "workspaces");
        if (existsSync(workspaces) && (!lstatSync(workspaces).isDirectory() || lstatSync(workspaces).isSymbolicLink())) {
          throw new Error("managed working-folder root is not physical retained storage");
        }
        const names = existsSync(workspaces) ? readdirSync(workspaces).sort() : [];
        const bound = new Set<string>();
        const retained = projects.map(project => {
          const canonical = catalog.prepare("SELECT host_path FROM projects WHERE id = ?").get(project.projectId) as { host_path: string } | undefined;
          if (canonical?.host_path !== project.hostPath) throw new Error("working-folder Project ownership is not canonical");
          const record = readRegularJson(path.join(ownership.dataDir, "projects", project.projectId, "project.json")) as {
            managedWorkspaceName?: string; ownerConversationId?: string; creationIdempotencyKey?: string;
          };
          if (record.managedWorkspaceName) {
            const expected = managedWorkspacePath(ownership.dataDir, record.managedWorkspaceName);
            if (!record.creationIdempotencyKey || project.projectId !== creationId("project", "workspace", record.creationIdempotencyKey) ||
                project.hostPath !== expected || !record.ownerConversationId || path.basename(record.ownerConversationId) !== record.ownerConversationId ||
                bound.has(record.managedWorkspaceName) || !names.includes(record.managedWorkspaceName)) {
              throw new Error("managed working-folder ownership is unknown or inconsistent");
            }
            const owner = catalog.prepare("SELECT project_id FROM conversations WHERE id = ?").get(record.ownerConversationId) as { project_id: string } | undefined;
            if (owner?.project_id !== project.projectId) throw new Error("managed working-folder Chat ownership is not canonical");
            const chat = readRegularJson(path.join(ownership.dataDir, "projects", project.projectId, "conversations", record.ownerConversationId, "conversation.json")) as {
              id: string; projectId: string; workingDirectory: string; managedWorkspaceName: string;
            };
            if (chat.id !== record.ownerConversationId || chat.projectId !== project.projectId ||
                chat.workingDirectory !== expected || chat.managedWorkspaceName !== record.managedWorkspaceName) {
              throw new Error("managed working-folder Chat ownership is inconsistent");
            }
            bound.add(record.managedWorkspaceName);
          } else if (project.hostPath === workspaces || project.hostPath.startsWith(`${workspaces}${path.sep}`)) {
            throw new Error("managed working-folder ownership is unknown");
          }
          const physicalFolder = realpathSync(project.hostPath);
          if (absoluteOutput === physicalFolder || absoluteOutput.startsWith(`${physicalFolder}${path.sep}`)) {
            throw new Error("backup output overlaps a preserved working folder");
          }
          return { projectId: project.projectId, path: project.hostPath, physicalIdentity: directoryIdentity(project.hostPath) };
        });
        if (names.some(name => !bound.has(name))) throw new Error("unowned managed working folder; use the full backup path");
        return retained;
      };
      const source = { path: absoluteDataDir, physicalIdentity: directoryIdentity(absoluteDataDir) };
      const preservedWorkingFolders = bindings();
      mkdirSync(path.dirname(absoluteOutput), { recursive: true, mode: 0o700 });
      mkdirSync(stage, { mode: 0o700 });
      if (realpathSync(stage) !== stage) throw new Error("backup output parent changed physical location");
      const omitted = new Set([...OMITTED_ROOT_ENTRIES, "workspaces"]);
      const manifest: WebDeploymentBackupManifest = {
        schemaVersion: 3, stateEpoch: 2, generationId: ownership.generationId, schemaContract: STATE_SCHEMA_CONTRACT,
        createdAt: new Date().toISOString(), scope: "web-deployment-only-not-disaster-recovery", source, compatibility,
        preservedWorkingFolders, externalProjects: { policy: "excluded", projects: [] },
        entries: copyTree(ownership.dataDir, stage, omitted),
      };
      verifyCompleteTree(ownership.dataDir, manifest.entries, omitted);
      verifyCompleteTree(stage, manifest.entries);
      if (source.physicalIdentity !== directoryIdentity(absoluteDataDir) ||
          JSON.stringify(preservedWorkingFolders) !== JSON.stringify(bindings()) ||
          JSON.stringify(compatibility) !== JSON.stringify(assertWebOnlyDeploymentCompatibility(artifacts.currentRoot, artifacts.candidateRoot))) {
        throw new Error("web-deployment ownership or installed artifact changed during backup");
      }
      writeManifest(stage, manifest, WEB_DEPLOYMENT_MANIFEST);
      renameSync(stage, absoluteOutput); fsyncDirectory(path.dirname(absoluteOutput));
      return manifest;
    } finally { catalog.close(); }
  } catch (error) {
    throw new Error(`web-deployment backup refused; any partial stage is preserved at ${stage}`, { cause: error });
  } finally { ownership.close(); }
}

export function createOfflineDataDirectoryBackup(
  dataDir: string,
  output: string,
  options: DataDirectoryBackupOptions = {},
): DataDirectoryBackupManifest {
  const absoluteDataDir = path.resolve(dataDir);
  const absoluteOutput = backupDestination(dataDir, output);
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
        const physicalFolder = realpathSync(project.hostPath);
        if (absoluteOutput === physicalFolder || absoluteOutput.startsWith(`${physicalFolder}${path.sep}`)) {
          throw new Error(`backup output must be outside external Project ${project.projectId}`);
        }
      }
    }
    mkdirSync(path.dirname(absoluteOutput), { recursive: true, mode: 0o700 });
    mkdirSync(stage, { mode: 0o700 });
    if (realpathSync(stage) !== stage) throw new Error("backup output parent changed physical location");
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
  if (existsSync(path.join(absoluteBackup, WEB_DEPLOYMENT_MANIFEST))) {
    throw new Error("web-deployment snapshots preserve working folders in place and cannot restore state; roll back code against current compatible data");
  }
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

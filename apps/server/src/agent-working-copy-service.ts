import {snapshotImportedNativeGit,finalizeImportedNativeSnapshot,importedNativeGitStorage,type ImportedNativeGitStorage,type ImportedNativeExternalProof,type ImportedNativeGitCustody,type LocalGeneratedHooksProof} from './portable-native-git-snapshot.js';
import {compileReviewedGitConfiguration} from './portable-git-configuration.js';
import {applyReviewedRecoveryRoots,planReviewedRecoveryRoots} from './portable-git-recreation.js';
import {assertReviewedProviderDestination,applyReviewedProviderData,createReviewedNativeGit,parseReviewedUserData,planReviewedUserDataActivation,REVIEWED_USER_DATA_PATH,type NativeReviewedGitConfiguration} from './portable-reviewed-user-data.js';
import {planFilesystemMetadata} from './portable-filesystem-metadata.js';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {importWorkingFiles,finalizeWorkingFolderMetadata,assertWorkingRootIdentity,createWorkingNativeMetadataEvidence,type WorkingNativeMetadata,type WorkingRootIdentity} from './portable-working-files.js';
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rmdir, readdir, open } from "@ponderosa/native-host/fs/promises";
import { realpathSync } from "@ponderosa/native-host/fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  AgentWorkingCopyUnavailableError,
  safeWorkingCopyFailure,
  safeWorkingCopyFailureCode,
  resolveAgentWorkingCopy,
  sharedWorkingCopy,
  type AgentStore,
  type ResolvedAgentWorkingCopy,
} from "@ponderosa/agents";
import type {
  AgentDto,
  AgentWorkingCopyDto,
  AgentWorkingCopyMode,
  ProjectDto,
} from "@ponderosa/core";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const CREATION_OWNERSHIP_REF = /^refs\/ponderosa\/working-copy-creation\/[0-9a-f]{32}$/u;
const CLEANUP_OWNERSHIP_REF = /^refs\/ponderosa\/working-copy-cleanup\/[0-9a-f]{32}$/u;

export interface ImportedContainedRootReservation {
  id:string;
  rootPath:string;
  parent:NonNullable<AgentWorkingCopyDto['importedParent']>;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ]) delete environment[name];
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    cwd,
    encoding: "utf8",
    env: gitEnvironment(),
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}

/** Ownership permits cleanup, but never grants permission to discard work. */
async function assertCopyHasNoUnpreservedWork(projectRoot: string, root: string, branch: string, rootExists: boolean): Promise<void> {
  if (rootExists && await runGit(root, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored"])) {
    throw new Error("Separate Git copy contains changed, untracked or ignored files and was preserved. Save them in Shared before retrying removal.");
  }
  const uniqueCommits = await runGit(projectRoot, ["rev-list", "--count", `refs/heads/${branch}`, "--not", "HEAD"]);
  if (uniqueCommits !== "0") {
    throw new Error("Separate Git copy contains commits absent from Shared and was preserved. Merge or save them in Shared before retrying removal.");
  }
}

function samePath(left: string, right: string): boolean {
  return path.relative(left, right) === "";
}

function inside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !path.isAbsolute(relative) && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`);
}

function separateBranch(agent: Pick<AgentDto, "id" | "title">): string {
  const label = agent.title.toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32) || "agent";
  return `ponderosa/${label}-${agent.id.replaceAll("-", "").slice(0, 10)}`;
}

function creationOwnershipRef(): string {
  return `refs/ponderosa/working-copy-creation/${randomUUID().replaceAll("-", "")}`;
}

function cleanupOwnershipRef(): string {
  return `refs/ponderosa/working-copy-cleanup/${randomUUID().replaceAll("-", "")}`;
}

function deleteOwnedBranchReferences(
  projectRoot: string,
  branch: string,
  ownershipRef: string,
  branchHead: string,
): void {
  execFileSync("git", ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "update-ref", "--stdin"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: gitEnvironment(),
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    input: [
      "start",
      `delete refs/heads/${branch} ${branchHead}`,
      `delete ${ownershipRef} ${branchHead}`,
      "prepare",
      "commit",
      "",
    ].join("\n"),
  });
}

function safeFailure(error: unknown): string {
  return safeWorkingCopyFailure(error);
}

function missingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function exitedWithStatus(error: unknown, status: number): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    error.code === status;
}

async function gitBranchExists(projectRoot: string, branch: string): Promise<boolean> {
  try {
    await runGit(projectRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch (error) {
    if (exitedWithStatus(error, 1)) return false;
    throw error;
  }
}

async function gitBranchHead(projectRoot: string, branch: string): Promise<string> {
  return runGit(projectRoot, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
}

async function gitReferenceHead(projectRoot: string, reference: string): Promise<string | undefined> {
  try {
    return await runGit(projectRoot, ["rev-parse", "--verify", `${reference}^{commit}`]);
  } catch (error) {
    if (exitedWithStatus(error, 128)) return undefined;
    throw error;
  }
}

function createOwnedBranchReferences(
  projectRoot: string,
  branch: string,
  ownershipRef: string,
  branchHead: string,
): void {
  execFileSync("git", ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "update-ref", "--stdin"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: gitEnvironment(),
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    input: [
      "start",
      `create refs/heads/${branch} ${branchHead}`,
      `create ${ownershipRef} ${branchHead}`,
      "prepare",
      "commit",
      "",
    ].join("\n"),
  });
}

async function gitWorktreeBranchRoots(
  projectRoot: string,
  branch: string,
): Promise<string[]> {
  const output = await runGit(projectRoot, ["worktree", "list", "--porcelain", "-z"]);
  const expectedBranch = `refs/heads/${branch}`;
  return output.split("\0\0").flatMap((record) => {
    let root: string | undefined;
    let registeredBranch: string | undefined;
    for (const field of record.split("\0")) {
      if (field.startsWith("worktree ")) root = field.slice("worktree ".length);
      if (field.startsWith("branch ")) registeredBranch = field.slice("branch ".length);
    }
    return root !== undefined && registeredBranch === expectedBranch
      ? [path.resolve(root)]
      : [];
  });
}

async function gitWorktreeRegistrationExact(
  projectRoot: string,
  expectedRoot: string,
  branch: string,
): Promise<boolean> {
  const roots = await gitWorktreeBranchRoots(projectRoot, branch);
  return roots.length === 1 && samePath(roots[0]!, expectedRoot);
}

async function gitWorktreeRootRegistered(
  projectRoot: string,
  expectedRoot: string,
): Promise<boolean> {
  const output = await runGit(projectRoot, ["worktree", "list", "--porcelain", "-z"]);
  return output.split("\0\0").some((record) =>
    record.split("\0").some((field) =>
      field.startsWith("worktree ") &&
      samePath(path.resolve(field.slice("worktree ".length)), expectedRoot)));
}

export class AgentWorkingCopyService {
  private readonly importedGitRoots=new Map<string,{sha256:string;snapshot:string;allowedRoots:string[];storage:ImportedNativeGitStorage;external:ImportedNativeExternalProof;custody:ImportedNativeGitCustody;generatedHooks?:LocalGeneratedHooksProof}>();
  private readonly importedNativeMetadata=new Map<string,WorkingNativeMetadata>();
  private readonly importedRootCustody=new Map<string,{device:bigint;inode:bigint;agentId:string;identity?:WorkingRootIdentity}>();
  private readonly containedReservations=new Map<string,ImportedContainedRootReservation>();
  private readonly containedParentDirectories=new Map<string,{device:bigint;inode:bigint}>();
  private readonly stagedImportedGitRoots=new Map<string,{device:bigint;inode:bigint;phase:'allocated'|'populating'|'populated'|'adopting';agentId?:string;identity?:WorkingRootIdentity}>();
  private readonly managedRoot: string;
  private readonly modeChanges = new Map<string, {
    completion: Promise<void>;
    complete: () => void;
  }>();
  private readonly activeUses = new Map<string, {
    count: number;
    completion: Promise<void>;
    complete: () => void;
  }>();

  constructor(
    dataDir: string,
    private readonly store: Pick<
      AgentStore,
      "getAgent" | "listProjectWorkingCopies" | "updateAgentWorkingCopy" |
      "updateDeletedAgentWorkingCopy" | "isManagedProjectImportDestination" | "listAgents" | "getProject" | "bindStagedImportedProjectRoot" | "bindPreparingImportedProjectRoot" | "recordGeneratedHookNamespace"
    >,
  ) {
    this.managedRoot = path.join(realpathSync(dataDir), "working-copies");
  }

  async resolve(
    agent: Pick<AgentDto, "id" | "projectId" | "workingCopy">,
    project: Pick<ProjectDto, "id" | "hostPath">,
  ): Promise<ResolvedAgentWorkingCopy> {
    const resolved = resolveAgentWorkingCopy(agent, project);
    try {
      const metadata = await lstat(resolved.rootPath);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("the configured root is not a retained directory");
      }
      const canonical = await realpath(resolved.rootPath);
      if (!samePath(canonical, path.resolve(resolved.rootPath))) {
        throw new Error("the configured root resolves somewhere else");
      }
      if(agent.workingCopy.importedParent&&await this.containedRootPath(agent.workingCopy.importedParent)!==canonical)throw new Error('Contained working root custody changed');
      if (resolved.mode === "separate_git") {
        if (!inside(this.managedRoot, canonical)&&!agent.workingCopy.importedParent) {
          throw new Error("the configured Separate Git copy is outside managed storage");
        }
        const projectRoot = await this.repositoryRoot(agent.id, agent.workingCopy, project);
        const projectTopLevel = await realpath(await runGit(projectRoot, ["rev-parse", "--show-toplevel"]));
        if (!samePath(projectRoot, projectTopLevel)) {
          throw new Error("the Project Shared folder is not the root of its Git repository");
        }
        if (!resolved.branch || !await gitWorktreeRegistrationExact(projectRoot, canonical, resolved.branch)) {
          throw new Error("the configured Separate Git copy is not registered by its Project repository");
        }
        const [topLevel, branch] = await Promise.all([
          runGit(canonical, ["rev-parse", "--show-toplevel"]),
          runGit(canonical, ["rev-parse", "--abbrev-ref", "HEAD"]),
        ]);
        if (!samePath(await realpath(topLevel), canonical) || branch !== resolved.branch) {
          throw new Error("the configured Separate Git copy no longer matches its branch");
        }
      }
      return { ...resolved, rootPath: canonical };
    } catch (error) {
      if (error instanceof AgentWorkingCopyUnavailableError) throw error;
      throw new AgentWorkingCopyUnavailableError(
        agent.workingCopy,
        safeFailure(error),
      );
    }
  }

  /** Only called after the importer validates a freshly created, unused managed Project. */
  async initializeImportProject(project:ProjectDto,original?:{data:Buffer;sha256:string;activation:import('@ponderosa/core').ReviewedUserDataActivation;configuration?:NativeReviewedGitConfiguration}):Promise<void> {
    if(await realpath(project.hostPath)!==project.hostPath||(await readdir(project.hostPath)).length)throw new Error('Live Shared import requires the empty NEW managed Chat folder');
    if(original){
      if(!this.store.isManagedProjectImportDestination(project.id)||this.store.listAgents(project.id).length)throw new Error('Native Git requires the unused NEW managed Project');
      const issued=await lstat(project.hostPath,{bigint:true});if(!issued.isDirectory()||issued.isSymbolicLink())throw new Error('Fresh native Project root changed before initialization');
      const configuration=original.configuration??compileReviewedGitConfiguration(parseReviewedUserData(original.data),original.activation,{common:path.join(project.hostPath,'.git'),private:path.join(project.hostPath,'.git')},new Map());
      configuration.directoryProofs??=new Map();const metadata=createWorkingNativeMetadataEvidence();configuration.nativeMetadata=metadata;configuration.nativeMetadataScope={};configuration.deferNativeMetadata=true;
      await createReviewedNativeGit(project.hostPath,original.data,original.sha256,original.activation,configuration);
      await configuration.prepareNativeMetadata?.();
      const custody:ImportedNativeGitCustody={roots:{[project.hostPath]:{device:issued.dev.toString(),inode:issued.ino.toString()}},directories:configuration.directoryProofs,metadataPending:true};
      const storage=importedNativeGitStorage(project.hostPath,configuration),observed=await snapshotImportedNativeGit(project.hostPath,[project.hostPath],storage,configuration,undefined,custody);
      await configuration.finalizeNativeMetadata?.();metadata.deferredMetadata.clear();
      this.importedGitRoots.set(project.hostPath,{sha256:original.sha256,...finalizeImportedNativeSnapshot(observed,metadata),storage,custody:{...custody,metadataPending:false},allowedRoots:[project.hostPath]});return;
    }
    await runGit(project.hostPath,['init','--template=','--initial-branch=main']);
    await runGit(project.hostPath,['-c','core.hooksPath=/dev/null','-c','user.name=Ponderosa Import','-c','user.email=import@localhost','commit','--allow-empty','--no-gpg-sign','-m','Initialize imported working roots']);
  }

  /** Fresh local ownership is checked before any imported file enters a live root. */
  async populateImportedRoot(agent:AgentDto,project:ProjectDto,files:Parameters<typeof importWorkingFiles>[1],directories:Parameters<typeof importWorkingFiles>[2],metadata:Parameters<typeof importWorkingFiles>[3],backupRoot:string,links:Parameters<typeof importWorkingFiles>[5]=[],cyclicLinks:Parameters<typeof importWorkingFiles>[6]='refuse',activation?:import('@ponderosa/core').ReviewedUserDataActivation,metadataActivation?:import('@ponderosa/core').ReviewedMetadataActivation,rootDestinations?:Readonly<Record<string,string>>,deferFinalMetadata=false,deferLinks=false):Promise<WorkingRootIdentity> {
    if(!this.modeChanges.has(agent.id))throw new Error('Live import was not fenced');
    const prepared=await this.inspectPreparedImportedRoot(agent,project),staged=prepared&&this.stagedImportedGitRoots.get(prepared.rootPath);
    if(staged){const stat=await lstat(agent.workingCopy.rootPath,{bigint:true});if(staged.phase!=='allocated'||stat.dev!==staged.device||stat.ino!==staged.inode||staged.agentId&&staged.agentId!==agent.id)throw new Error('Staged Git root changed or population was already attempted');staged.phase='populating';}
    const resolved=staged?{id:agent.workingCopy.id,mode:agent.workingCopy.mode,rootPath:agent.workingCopy.repositoryRoot?await this.repositoryRoot(agent.id,agent.workingCopy,project):agent.workingCopy.rootPath}:await this.resolve(agent,project);
    const locallyContained=agent.workingCopy.importedParent!==undefined&&await this.containedRootPath(agent.workingCopy.importedParent)===resolved.rootPath;
    const rootIdentity=await lstat(resolved.rootPath,{bigint:true});
    if(staged&&(rootIdentity.dev!==staged.device||rootIdentity.ino!==staged.inode))throw new Error('Staged Git root changed before byte-phase identity handoff');
    this.importedRootCustody.set(resolved.rootPath,{device:rootIdentity.dev,inode:rootIdentity.ino,agentId:agent.id});
    const activationRoot=activation?rootIdentity:undefined;
    const original=activation||metadataActivation?files.find(file=>file.path===REVIEWED_USER_DATA_PATH):undefined;
    const metadataPlan=metadataActivation&&original?parseReviewedUserData(original.data):undefined;
    if(metadataActivation){
      if((resolved.mode!=='separate_git'&&!locallyContained&&!this.store.isManagedProjectImportDestination(project.id))||!original||!metadataPlan?.filesystemMetadata||createHash('sha256').update(original.data).digest('hex')!==original.sha256)throw new Error('Native metadata requires the original and a NEW managed destination');
      planFilesystemMetadata(metadataPlan.filesystemMetadata,metadataPlan.selection,metadataActivation);
    }
    if(activation){
      if(!original&&!staged||original&&createHash('sha256').update(original.data).digest('hex')!==original.sha256)throw new Error('Native activation original is unavailable or changed');
      const plan=original?(staged?parseReviewedUserData(original.data):planReviewedUserDataActivation(original.data,original.sha256,activation)):undefined;
      if(activation.harness&&plan)await assertReviewedProviderDestination(resolved.rootPath,plan);
      if(activation.git&&!staged)await this.verifyImportedGitRoot(project,original!.sha256,resolved.rootPath);
      if(resolved.mode!=='separate_git'&&!locallyContained&&!this.store.isManagedProjectImportDestination(project.id))throw new Error('Native Shared activation requires the NEW managed import destination');
    }
    const issuedIdentity=await importWorkingFiles(resolved.rootPath,files,directories,activation||metadataActivation?undefined:metadata,{backupRoot,identity:{device:rootIdentity.dev.toString(),inode:rootIdentity.ino.toString()}},links,cyclicLinks,metadataActivation,deferFinalMetadata||!!activation||!!metadataActivation,rootDestinations,deferLinks);
    await assertWorkingRootIdentity(resolved.rootPath,issuedIdentity);
    if(activation&&original){
      const current=staged?resolved:await this.resolve(agent,project);
      if(current.rootPath!==resolved.rootPath||!this.modeChanges.has(agent.id))throw new Error('Native activation root membership changed');
      if(activation.git&&!staged)await this.verifyImportedGitRoot(project,original.sha256,current.rootPath);
      if(activation.harness)await applyReviewedProviderData(resolved.rootPath,original.data,original.sha256,staged?{git:false,harness:true}:activation);
      if(metadata&&!metadataActivation&&!staged&&!deferFinalMetadata){
        const root=await open(current.rootPath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_DIRECTORY);
        let finalizationError:Error|undefined;
        try{
          const before=await root.stat({bigint:true});
          if(!before.isDirectory()||before.dev!==activationRoot!.dev||before.ino!==activationRoot!.ino||await realpath(current.rootPath)!==current.rootPath)throw new Error('Imported root changed before metadata');
          await root.chmod(metadata.mode&0o777);await root.utimes(new Date(metadata.mtime),new Date(metadata.mtime));
        }catch(error){
          const observed=await root.stat({bigint:true}).then(stat=>({device:stat.dev,inode:stat.ino,mode:stat.mode,mtimeNs:stat.mtimeNs}),()=>null);
          finalizationError=Object.assign(new Error('Imported root metadata finalization incomplete; preserve destination and originals',{cause:error}),{code:(error as {code?:string}).code??'ERR_IMPORTED_ROOT_METADATA_PARTIAL',partialStatePossible:true,observed});
        }finally{
          try{await root.close();}catch(cleanupError){
            if(finalizationError)Object.assign(finalizationError,{cleanupErrors:[cleanupError]});
            else finalizationError=Object.assign(new Error('Imported root metadata completed but descriptor cleanup failed; preserve destination and originals',{cause:cleanupError}),{code:'ERR_IMPORTED_ROOT_CLEANUP_PARTIAL',partialStatePossible:true,observed:null,cleanupErrors:[cleanupError]});
          }
        }
        if(finalizationError)throw finalizationError;
      }
    }
    if(metadataActivation&&!deferFinalMetadata&&!staged&&metadataPlan?.filesystemMetadata){
      const current=await this.resolve(agent,project);
      if(current.rootPath!==resolved.rootPath||!this.modeChanges.has(agent.id))throw new Error('Metadata root membership changed');
      await finalizeWorkingFolderMetadata(current.rootPath,files,directories,metadata,links,metadataActivation,undefined,issuedIdentity);
    }
    await assertWorkingRootIdentity(resolved.rootPath,issuedIdentity);
    this.importedRootCustody.set(resolved.rootPath,{device:rootIdentity.dev,inode:rootIdentity.ino,agentId:agent.id,identity:issuedIdentity});
    if(staged){staged.phase='populated';staged.identity=issuedIdentity;}
    return issuedIdentity;
  }

  async finalizeImportedRootMetadata(agent:AgentDto,project:ProjectDto,files:Parameters<typeof importWorkingFiles>[1],directories:Parameters<typeof importWorkingFiles>[2],metadata:Parameters<typeof importWorkingFiles>[3],links:Parameters<typeof importWorkingFiles>[5],activation?:import('@ponderosa/core').ReviewedMetadataActivation,counts?:ReadonlyMap<string,bigint>,nativeMetadata?:WorkingNativeMetadata):Promise<void>{
    if(!this.modeChanges.has(agent.id))throw new Error('Final live metadata requires its fenced imported destination');
    const prepared=await this.inspectPreparedImportedRoot(agent,project),root=prepared??await this.resolve(agent,project),proof=this.importedRootCustody.get(root.rootPath),stat=await lstat(root.rootPath,{bigint:true});
    if(!proof||proof.agentId!==agent.id||proof.device!==stat.dev||proof.inode!==stat.ino||await realpath(root.rootPath)!==root.rootPath)throw new Error('Final metadata root lost its fresh local custody');
    await finalizeWorkingFolderMetadata(root.rootPath,files,directories,metadata,links,activation,counts,proof.identity??{device:proof.device.toString(),inode:proof.inode.toString()},nativeMetadata??this.importedNativeMetadata.get(root.rootPath));
  }

  /** Local storage authority; a source package never supplies this path. */
  private async repositoryRoot(agentId:string,workingCopy:AgentWorkingCopyDto,project:Pick<ProjectDto,'id'|'hostPath'>):Promise<string> {
    if(workingCopy.repositoryRoot===undefined)return realpath(project.hostPath);
    const expected=workingCopy.importedParent?await this.containedRootPath(workingCopy.importedParent):path.join(this.managedRoot,project.id,agentId,'root');
    if(workingCopy.repositoryRoot!==expected||workingCopy.rootPath!==expected||!workingCopy.importedParent&&!inside(this.managedRoot,expected))throw new Error('Independent imported Git repository has no local managed ownership');
    const stat=await lstat(expected);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(expected)!==expected)throw new Error('Independent imported Git root changed; preserve its data');
    return expected;
  }

  private async containedRootPath(parent:NonNullable<AgentWorkingCopyDto['importedParent']>):Promise<string> {
    const parts=parent.relativePath.split('/');
    if(!parent.relativePath||parent.relativePath.length>4096||parts.some(part=>!part||part==='.'||part==='..')||parent.relativePath.includes('\\')||path.isAbsolute(parent.relativePath)||/[\x00-\x1f\x7f]/.test(parent.relativePath))throw new Error('Invalid contained-root relation');
    const expected=path.join(parent.parentPath,...parts);
    if(!inside(parent.parentPath,expected)||await realpath(parent.parentPath)!==parent.parentPath)throw new Error('Contained root escaped its issued parent');
    const source=await lstat(parent.parentPath,{bigint:true}),child=await lstat(expected,{bigint:true});
    if(!source.isDirectory()||source.dev.toString()!==parent.parentDevice||source.ino.toString()!==parent.parentInode||!child.isDirectory()||child.dev.toString()!==parent.device||child.ino.toString()!==parent.inode||await realpath(expected)!==expected)throw new Error('Contained root lost its locally issued parent/child inode custody');
    return expected;
  }

  /** The carrier supplies only a typed relative relation. Parent authority is
   * this process's fresh allocation and canonical Agent, never a source path. */
  async reserveImportedContainedRoot(parentAgent:AgentDto,parentProject:ProjectDto,relativePath:string):Promise<ImportedContainedRootReservation> {
    if(!this.modeChanges.has(parentAgent.id)||this.activeUses.has(parentAgent.id))throw new Error('Contained allocation requires the parent working-folder fence');
    const current=this.store.getAgent(parentAgent.id),root=current?.workingCopy.rootPath,staged=root&&this.stagedImportedGitRoots.get(root);
    if(!current||current.projectId!==parentProject.id||current.workingCopy.id!==parentAgent.workingCopy.id||!root||!staged||staged.phase!=='allocated')throw new Error('Contained allocation has no fresh canonical parent');
    if(current.workingCopy.importedParent)await this.containedRootPath(current.workingCopy.importedParent);
    const parts=relativePath.split('/');
    if(!relativePath||relativePath.length>4096||parts.some(part=>!part||part==='.'||part==='..')||relativePath.includes('\\')||path.isAbsolute(relativePath)||/[\x00-\x1f\x7f]/.test(relativePath))throw new Error('Choose the exact canonical contained-root relation');
    const parentStat=await lstat(root,{bigint:true});
    if(!parentStat.isDirectory()||parentStat.dev!==staged.device||parentStat.ino!==staged.inode||await realpath(root)!==root)throw new Error('Contained allocation parent was replaced');
    const rootPath=path.join(root,...parts),id=randomUUID();
    const preparation={id,relativePath,rootPath,parentDevice:parentStat.dev.toString(),parentInode:parentStat.ino.toString(),phase:'creating' as 'creating'|'created'};
    const prior=current.workingCopy.containedRootPreparations??[];
    if(prior.some(item=>item.rootPath===rootPath)||prior.length>=10000)throw new Error('Contained allocation is already attempted or exceeds its root bound; inspect its exact receipt');
    this.requireUpdated(current.id,{...current.workingCopy,containedRootPreparations:[...prior,preparation]});
    let target=root;
    for(const [index,part] of parts.entries()){
      target=path.join(target,part);
      try{await mkdir(target,{mode:0o700});}
      catch(error){
        const owned=this.containedParentDirectories.get(target);
        if((error as NodeJS.ErrnoException).code!=='EEXIST'||index===parts.length-1||!owned)throw error;
        const stat=await lstat(target,{bigint:true});if(stat.dev!==owned.device||stat.ino!==owned.inode)throw new Error('Contained allocation intermediate parent changed');
      }
      const stat=await lstat(target,{bigint:true});if(!stat.isDirectory()||await realpath(target)!==target)throw new Error('Contained allocation followed an unexpected parent');
      this.containedParentDirectories.set(target,{device:stat.dev,inode:stat.ino});
    }
    const child=await lstat(rootPath,{bigint:true}),reservation:ImportedContainedRootReservation={id,rootPath,parent:{parentAgentId:current.id,parentProjectId:parentProject.id,parentPath:root,parentDevice:parentStat.dev.toString(),parentInode:parentStat.ino.toString(),relativePath,device:child.dev.toString(),inode:child.ino.toString()}};
    await this.containedRootPath(reservation.parent);
    this.requireUpdated(current.id,{...this.store.getAgent(current.id)!.workingCopy,containedRootPreparations:[...prior,{...preparation,phase:'created',device:child.dev.toString(),inode:child.ino.toString()}]});
    this.containedReservations.set(id,structuredClone(reservation));return reservation;
  }

  async bindImportedContainedRoot(agent:AgentDto,project:ProjectDto,reservation:ImportedContainedRootReservation,mode:AgentWorkingCopyMode):Promise<AgentDto> {
    if(!this.modeChanges.has(agent.id)||this.activeUses.has(agent.id))throw new Error('Contained binding requires the child working-folder fence');
    let issued=this.containedReservations.get(reservation.id);
    if(!issued&&reservation.parent){
      const parent=this.store.getAgent(reservation.parent.parentAgentId),proof=parent?.workingCopy.containedRootPreparations?.find(item=>item.id===reservation.id);
      if(parent&&proof?.phase==='created'&&proof.device&&proof.inode){
        issued={id:proof.id,rootPath:proof.rootPath,parent:{parentAgentId:parent.id,parentProjectId:parent.projectId,parentPath:parent.workingCopy.rootPath,parentDevice:proof.parentDevice,parentInode:proof.parentInode,relativePath:proof.relativePath,device:proof.device,inode:proof.inode}};
      }
    }
    const current=this.store.getAgent(agent.id);
    if(!issued||issued.rootPath!==reservation.rootPath||!reservation.parent||Object.keys(reservation.parent).length!==Object.keys(issued.parent).length||Object.entries(issued.parent).some(([key,value])=>(reservation.parent as unknown as Record<string,unknown>)[key]!==value)||!current||current.projectId!==project.id||current.workingCopy.mode!=='shared'||current.workingCopy.importedParent)throw new Error('Contained binding has no exact local reservation; inspect the original preparation after a restart');
    const root=await this.containedRootPath(issued.parent);
    if(mode!=='shared'&&mode!=='separate_git')throw new Error('Invalid contained destination working-copy mode');
    if(mode==='shared'&&project.hostPath!==root)throw new Error('Shared contained root must match the explicitly registered destination Project');
    const parent=this.store.getAgent(issued.parent.parentAgentId),preparation=parent?.workingCopy.containedRootPreparations?.find(item=>item.id===issued!.id);
    if(!parent||!this.modeChanges.has(parent.id)||preparation?.phase!=='created'||preparation.rootPath!==root)throw new Error('Contained reservation is already binding or bound; inspect its exact child identity');
    // Persist one child identity before binding it. A write failure retains this
    // exact intent; it can never reassign the same physical root to another Agent.
    this.requireUpdated(parent.id,{...parent.workingCopy,containedRootPreparations:parent.workingCopy.containedRootPreparations!.map(item=>item.id===issued!.id?{...item,phase:'binding' as const,childAgentId:agent.id}:item)});
    const result=mode==='shared'?{...current.workingCopy,importedParent:issued.parent}:{id:'copy:'+randomUUID(),mode:'separate_git' as const,state:'unavailable' as const,rootPath:root,repositoryRoot:root,importedParent:issued.parent,branch:separateBranch(current),failure:'Contained native Git import is in progress; inspect its exact preparation receipt.',updatedAt:new Date().toISOString()};
    const bound=this.requireUpdated(agent.id,result),stat=await lstat(root,{bigint:true});
    if(!stat.isDirectory()||stat.dev.toString()!==issued.parent.device||stat.ino.toString()!==issued.parent.inode||await this.containedRootPath(issued.parent)!==root)throw new Error('Contained binding root changed; retain its exact binding receipt');
    this.stagedImportedGitRoots.set(root,{device:stat.dev,inode:stat.ino,phase:'allocated',...(mode==='separate_git'?{agentId:agent.id}:{})});
    const latest=this.store.getAgent(parent.id)!;
    this.requireUpdated(parent.id,{...latest.workingCopy,containedRootPreparations:latest.workingCopy.containedRootPreparations!.map(item=>item.id===issued!.id?{...item,phase:'bound' as const}:item)});
    this.containedReservations.delete(issued.id);return bound;
  }

  /** Bind only a locally reserved contained root to an inactive staged Project. */
  async bindImportedContainedProject(agent:AgentDto,project:ProjectDto,reservation:ImportedContainedRootReservation,planId:string):Promise<AgentDto> {
    const owners=this.store.listAgents(project.id);
    if(owners.some(owner=>!this.modeChanges.has(owner.id)||this.activeUses.has(owner.id)))throw new Error('Final contained Project binding requires every destination owner fence');
    const parent=this.store.getAgent(reservation.parent.parentAgentId),issued=parent?.workingCopy.containedRootPreparations?.find(item=>item.id===reservation.id);
    if(!parent||!this.modeChanges.has(parent.id)||issued?.phase!=='created'||issued.rootPath!==reservation.rootPath||issued.device!==reservation.parent.device||issued.inode!==reservation.parent.inode||await this.containedRootPath(reservation.parent)!==reservation.rootPath)throw new Error('Final Project binding requires its exact locally created contained-root receipt');
    const rebound=this.store.bindStagedImportedProjectRoot(project.id,planId,project.hostPath,reservation.rootPath,owners.map(owner=>owner.id),reservation.parent);
    const bound=await this.bindImportedContainedRoot(this.store.getAgent(agent.id)!,rebound,reservation,'shared');
    for(const owner of owners)if(owner.id!==agent.id&&this.store.getAgent(owner.id)!.workingCopy.mode==='shared')this.requireUpdated(owner.id,{...this.store.getAgent(owner.id)!.workingCopy,importedParent:bound.workingCopy.importedParent});
    return bound;
  }

  /** Generic import uses the same locally issued contained inode, with its original preparing operation. */
  async bindImportedContainedProjectForCreation(agent:AgentDto,project:ProjectDto,reservation:ImportedContainedRootReservation,operationId:string):Promise<AgentDto> {
    const owners=this.store.listAgents(project.id,{includePendingCreation:true});
    if(owners.some(owner=>!this.modeChanges.has(owner.id)||this.activeUses.has(owner.id)))throw new Error('Final contained Project binding requires every preparing owner fence');
    const parent=this.store.getAgent(reservation.parent.parentAgentId),issued=parent?.workingCopy.containedRootPreparations?.find(item=>item.id===reservation.id);
    if(!parent||!this.modeChanges.has(parent.id)||issued?.phase!=='created'||issued.rootPath!==reservation.rootPath||issued.device!==reservation.parent.device||issued.inode!==reservation.parent.inode||await this.containedRootPath(reservation.parent)!==reservation.rootPath)throw new Error('Final Project binding requires its exact locally created contained-root receipt');
    const rebound=this.store.bindPreparingImportedProjectRoot(project.id,operationId,project.hostPath,reservation.rootPath,owners.map(owner=>owner.id),reservation.parent);
    const bound=await this.bindImportedContainedRoot(this.store.getAgent(agent.id)!,rebound,reservation,'shared');
    for(const owner of owners)if(owner.id!==agent.id&&this.store.getAgent(owner.id)!.workingCopy.mode==='shared')this.requireUpdated(owner.id,{...this.store.getAgent(owner.id)!.workingCopy,importedParent:bound.workingCopy.importedParent});
    return bound;
  }

  /** Same captured Shared root may have several independently owned Chat namespaces. */
  async bindImportedContainedProjectAlias(agent:AgentDto,project:ProjectDto,rootOwner:AgentDto,planId:string):Promise<AgentDto> {
    const proof=rootOwner.workingCopy.importedParent,owners=this.store.listAgents(project.id);
    if(!proof||!this.modeChanges.has(rootOwner.id)||owners.some(owner=>!this.modeChanges.has(owner.id)||this.activeUses.has(owner.id))||await this.containedRootPath(proof)!==rootOwner.workingCopy.rootPath||!this.stagedImportedGitRoots.has(rootOwner.workingCopy.rootPath))throw new Error('Contained Shared alias requires the exact fenced canonical root owner');
    this.store.bindStagedImportedProjectRoot(project.id,planId,project.hostPath,rootOwner.workingCopy.rootPath,owners.map(owner=>owner.id),proof);
    for(const owner of owners)if(this.store.getAgent(owner.id)!.workingCopy.mode==='shared')this.requireUpdated(owner.id,{...this.store.getAgent(owner.id)!.workingCopy,importedParent:proof});
    return this.store.getAgent(agent.id)!;
  }

  private async verifyImportedGitRoot(_project:ProjectDto,sha256:string,rootPath:string):Promise<void> {
    const proof=this.importedGitRoots.get(rootPath);
    if(!proof||proof.sha256!==sha256||proof.snapshot!==(await snapshotImportedNativeGit(rootPath,proof.allowedRoots,proof.storage,undefined,proof.external,proof.custody)).snapshot)throw new Error('Native Git differs from its exact local before-population ownership proof; preserve partial application');
  }

  private recordImportedGeneratedHooks(rootPath:string,sourceOriginalSha256:string,proof:LocalGeneratedHooksProof|undefined,agentIds:readonly string[]):void {
    if(!proof)return;
    for(const id of new Set(agentIds)){
      const agent=this.store.getAgent(id);if(!agent||agent.workingCopy.rootPath!==rootPath)continue;
      if(!this.modeChanges.has(id)||this.activeUses.has(id))throw new Error('Generated hook issuance lost exact current owner custody');
      this.store.recordGeneratedHookNamespace(id,rootPath,sourceOriginalSha256,proof);
    }
  }

  private async stageImportedGitRoot(rootPath:string,agentId?:string):Promise<void> {
    const stat=await lstat(rootPath,{bigint:true});
    if(!stat.isDirectory()||await realpath(rootPath)!==rootPath||(await readdir(rootPath)).length||this.stagedImportedGitRoots.has(rootPath))throw new Error('Native import root must be freshly allocated and empty');
    this.stagedImportedGitRoots.set(rootPath,{device:stat.dev,inode:stat.ino,phase:'allocated',...(agentId?{agentId}:{})});
  }

  async stageImportedSharedGit(project:ProjectDto,exactOwnedAgentIds:readonly string[]=[]):Promise<void> {
    const current=this.store.listAgents(project.id).map(agent=>agent.id);
    if(!this.store.isManagedProjectImportDestination(project.id)||current.length!==exactOwnedAgentIds.length||new Set(exactOwnedAgentIds).size!==exactOwnedAgentIds.length||current.some(id=>!exactOwnedAgentIds.includes(id)))throw new Error('Native Shared Git requires the unused NEW managed Chat');
    await this.stageImportedGitRoot(project.hostPath);
  }

  /** New recovery-root custody supplied by the one-shot Branch physical importer, never a source receipt. */
  async retainImportedRecoveryGitRoot(rootPath:string,identity:WorkingRootIdentity|{device:bigint;inode:bigint}):Promise<void>{
    const stat=await lstat(rootPath,{bigint:true});
    if(!path.isAbsolute(rootPath)||path.resolve(rootPath)!==rootPath||!stat.isDirectory()||stat.isSymbolicLink()||await realpath(rootPath)!==rootPath||stat.dev!==BigInt(identity.device)||stat.ino!==BigInt(identity.inode)||this.stagedImportedGitRoots.has(rootPath))throw new Error('Imported recovery Git root lost its exact new-directory identity');
    this.stagedImportedGitRoots.set(rootPath,{device:stat.dev,inode:stat.ino,phase:'populated',identity:{...identity,device:identity.device.toString(),inode:identity.inode.toString()}});
  }

  /** Read only local staging authority; callers may skip a duplicate allocation,
   * never infer custody from a source destination or a matching path alone. */
  async inspectPreparedImportedRoot(agent:AgentDto,project:ProjectDto):Promise<{rootPath:string;phase:'allocated'|'populating'|'populated'|'adopting'}|undefined> {
    if(!this.modeChanges.has(agent.id)||this.activeUses.has(agent.id))throw new Error('Prepared import inspection requires its Agent fence');
    const current=this.store.getAgent(agent.id);
    if(!current||current.projectId!==project.id||current.workingCopy.id!==agent.workingCopy.id||current.workingCopy.rootPath!==agent.workingCopy.rootPath)throw new Error('Prepared import canonical owner changed');
    const rootPath=current.workingCopy.rootPath,staged=this.stagedImportedGitRoots.get(rootPath);
    if(!staged)return undefined;
    const stat=await lstat(rootPath,{bigint:true});
    if(staged.agentId&&staged.agentId!==agent.id||!stat.isDirectory()||stat.dev!==staged.device||stat.ino!==staged.inode||await realpath(rootPath)!==rootPath)throw new Error('Prepared import root lost its local inode custody');
    if(current.workingCopy.importedParent&&await this.containedRootPath(current.workingCopy.importedParent)!==rootPath)throw new Error('Prepared import contained-root custody changed');
    if(current.workingCopy.repositoryRoot)await this.repositoryRoot(agent.id,current.workingCopy,project);
    return {rootPath,phase:staged.phase};
  }

  /** Allocate local ownership before mutation; never copy this path from source. */
  async allocateImportedSeparateGit(agent:AgentDto,project:ProjectDto):Promise<AgentDto> {
    if(!this.modeChanges.has(agent.id)||this.activeUses.has(agent.id))throw new Error('Independent Git import requires exclusive working-copy custody');
    const current=this.store.getAgent(agent.id);
    if(!current||current.projectId!==project.id||current.workingCopy.mode!=='shared')throw new Error('Independent Git import requires the fresh destination Agent');
    const rootPath=path.join(this.managedRoot,project.id,agent.id,'root'),branch=separateBranch(agent),id='copy:'+randomUUID();
    const workingCopy:AgentWorkingCopyDto={id,mode:'separate_git',state:'unavailable',rootPath,repositoryRoot:rootPath,branch,failure:'Native Git import is in progress; preserve partial data and inspect its import receipt.',updatedAt:new Date().toISOString()};
    this.requireUpdated(agent.id,workingCopy);
    try{
      for(const parent of [this.managedRoot,path.join(this.managedRoot,project.id),path.dirname(rootPath)]){
        try{await mkdir(parent,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
        const stat=await lstat(parent);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(parent)!==parent)throw new Error('Managed import parent changed');
      }
      await mkdir(rootPath,{mode:0o700});await this.stageImportedGitRoot(rootPath,agent.id);
      return this.store.getAgent(agent.id)!;
    }catch(error){throw Object.assign(new Error('Native Separate Git allocation incomplete; preserve its managed path',{cause:error}),{code:'ERR_IMPORTED_GIT_PARTIAL',partialStatePossible:true,observed:{path:rootPath}});}
  }

  /** Files first, one complete Git closure next, and final ACLs/times last. */
  async completeImportedGitRoots(_project:ProjectDto,pkg:import('@ponderosa/core').AgentPortablePackageDto,destinations:Record<string,string>,activation:import('@ponderosa/core').ReviewedUserDataActivation|undefined,onReceipt:Parameters<typeof applyReviewedRecoveryRoots>[2],agentIds:readonly string[]=[],nativeMetadata:WorkingNativeMetadata=createWorkingNativeMetadataEvidence(),finalizeWorkingData?:()=>Promise<void>):Promise<void> {
    const roots=[...new Set([...Object.values(destinations),...[...this.stagedImportedGitRoots.entries()].filter(([,staged])=>staged.agentId&&agentIds.includes(staged.agentId)).map(([root])=>root)])],tasks=activation?planReviewedRecoveryRoots(pkg,destinations,activation):[];
    const originalRoots:Record<string,WorkingRootIdentity>={},pendingReady=new Map<string,AgentDto>();
    // Canonical imported rows remain unavailable until the complete physical
    // graph and selected metadata finish, including Shared root aliases.
    for(const id of new Set(agentIds)){
      const agent=this.store.getAgent(id);if(!agent||!roots.includes(agent.workingCopy.rootPath))throw new Error('Native import current owner is outside its selected root closure');
      if(!this.modeChanges.has(id)||this.activeUses.has(id))throw new Error('Native import requires every current root owner fence');
      const pending=this.requireUpdated(id,{...agent.workingCopy,state:'unavailable',failure:'Native import metadata and ownership proof are pending; preserve the exact import operation.',updatedAt:new Date().toISOString()});pendingReady.set(id,pending);
    }
    for(const root of roots){
      const staged=this.stagedImportedGitRoots.get(root),stat=await lstat(root,{bigint:true});
      if(!staged||(staged.phase!=='populated'&&!(staged.phase==='allocated'&&!Object.values(destinations).includes(root)))||stat.dev!==staged.device||stat.ino!==staged.inode||await realpath(root)!==root)throw new Error('Native import root is not in its exact populated phase');
      if(staged.agentId&&(!agentIds.includes(staged.agentId)||!this.modeChanges.has(staged.agentId)||this.activeUses.has(staged.agentId)))throw new Error('Git adoption lost exact current Agent custody');
      originalRoots[root]=staged.identity??{device:staged.device.toString(),inode:staged.inode.toString()};
      if(staged.agentId&&tasks.some(task=>task.layout?.commonDir===root)&&!tasks.some(task=>task.destination===root&&task.activation.git))throw new Error('A selected bare common-storage root cannot also become a Separate Git working tree; choose a distinct storage subfolder or retain its Shared folder mode');
      staged.phase='adopting';
    }
    // The shared recreation engine validates included target/config closure and
    // records each applying/incomplete outcome for exactly the requested families.
    const receipts=new Map<string,Parameters<typeof onReceipt>[0]>(),nativeDirectories=new Map<string,{device:string;inode:string}>(),nativeMetadataScope={};
    for(const task of tasks)if(task.configuration){task.configuration.directoryProofs=nativeDirectories;task.configuration.nativeMetadata=nativeMetadata;task.configuration.nativeMetadataScope=nativeMetadataScope;task.configuration.deferNativeMetadata=true;}
    for(const root of roots)this.importedNativeMetadata.set(root,nativeMetadata);
    try{
    if(activation)await applyReviewedRecoveryRoots(tasks,activation,receipt=>{const current={...receipt,state:receipt.state==='completed'?'applying' as const:receipt.state};receipts.set(receipt.ref,current);onReceipt(current);},originalRoots,nativeMetadata);
    const prepare=[...new Set(tasks.flatMap(task=>task.configuration?.prepareNativeMetadata?[task.configuration.prepareNativeMetadata]:[]))];for(const apply of prepare)await apply();
    for(const root of roots){
      const staged=this.stagedImportedGitRoots.get(root)!;if(!staged.agentId)continue;
      const agent=this.store.getAgent(staged.agentId);if(!agent||agent.workingCopy.repositoryRoot!==root||agent.workingCopy.state!=='unavailable')throw new Error('Imported Separate Git ownership changed before activation');
      const workingCopy=agent.workingCopy,branch=workingCopy.branch!;
      if(!tasks.some(task=>task.destination===root&&task.activation.git))await runGit(root,['init','--template=','--initial-branch=main']);
      // An unborn source needs only a local empty ownership commit. The selected
      // source index and every imported branch/ref are retained unchanged.
      let baseHead:string;
      try{baseHead=await runGit(root,['rev-parse','--verify','HEAD^{commit}']);}
      catch(error){
        const task=tasks.find(task=>task.destination===root&&task.activation.git),git=task?.value.git;
        if(git&&(!('symbolic' in git.head)||git.refs.some(ref=>ref.name===('symbolic' in git.head?git.head.symbolic:''))))throw error;
        const emptyTree=execFileSync('git',['-c','core.hooksPath=/dev/null','hash-object','-t','tree','-w','--stdin'],{cwd:root,env:gitEnvironment(),input:'',encoding:'utf8',timeout:GIT_TIMEOUT_MS}).trim();
        baseHead=execFileSync('git',['-c','core.hooksPath=/dev/null','-c','user.name=Ponderosa Import','-c','user.email=import@localhost','commit-tree','--no-gpg-sign',emptyTree,'-m','Initialize imported Separate ownership'],{cwd:root,env:gitEnvironment(),encoding:'utf8',timeout:GIT_TIMEOUT_MS}).trim();
      }
      if(await gitBranchExists(root,branch))throw new Error('The newly allocated managed branch collides with imported user refs');
      const receipt={ownershipRef:creationOwnershipRef(),branchHead:baseHead};
      this.requireUpdated(agent.id,{...workingCopy,baseHead,branchCreationIntent:true,branchCreationReceipt:receipt});
      createOwnedBranchReferences(root,branch,receipt.ownershipRef,baseHead);
      await runGit(root,['symbolic-ref','HEAD','refs/heads/'+branch]);
      await runGit(root,['update-ref','-d',receipt.ownershipRef,baseHead]);
      const owned=this.requireUpdated(agent.id,{...workingCopy,state:'unavailable',baseHead,branchOwned:true,failure:'Native Git final metadata is pending; preserve its exact import operation.',updatedAt:new Date().toISOString()});
      const ownerProject=this.store.getProject(owned.projectId);if(!ownerProject)throw new Error('Imported Git owner Project disappeared');
      await this.resolve({...owned,workingCopy:{...owned.workingCopy,state:'ready',failure:undefined}},ownerProject);pendingReady.set(owned.id,owned);
    }
    // Seal after every local branch is established: common Git storage can be
    // shared by multiple selected roots, so earlier snapshots would be obsolete.
    const pendingProofs:Array<{task:typeof tasks[number];storage:ImportedNativeGitStorage;custody:ImportedNativeGitCustody;observed:Awaited<ReturnType<typeof snapshotImportedNativeGit>>}>=[];
    for(const task of tasks.filter(task=>task.activation.git&&task.value.git)){
      const gitDir=task.layout?.privateDir??task.storage?.gitDir??task.moduleOwner?.gitDir??path.join(task.destination,'.git'),commonDir=task.layout?.commonDir??task.storage?.gitDir??task.moduleOwner?.gitDir??path.join(task.destination,'.git'),storage=importedNativeGitStorage(task.destination,task.configuration,{gitDir,commonDir}),custody:ImportedNativeGitCustody={roots:originalRoots,directories:nativeDirectories,metadataPending:true},observed=await snapshotImportedNativeGit(task.destination,roots,storage,task.configuration,undefined,custody);
      pendingProofs.push({task,storage,custody,observed});
    }
    await finalizeWorkingData?.();
    const finalize=[...new Set(tasks.flatMap(task=>task.configuration?.finalizeNativeMetadata?[task.configuration.finalizeNativeMetadata]:[]))];for(const apply of finalize)await apply();
    for(const {task,storage,custody,observed} of pendingProofs){const finalized=finalizeImportedNativeSnapshot(observed,nativeMetadata);this.recordImportedGeneratedHooks(task.destination,task.sha256,finalized.generatedHooks,agentIds);this.importedGitRoots.set(task.destination,{sha256:task.sha256,...finalized,allowedRoots:roots,storage,custody:{...custody,metadataPending:false}});}
    for(const owned of pendingReady.values()){const current=this.store.getAgent(owned.id);if(!current||current.workingCopy.id!==owned.workingCopy.id||current.workingCopy.rootPath!==owned.workingCopy.rootPath||current.workingCopy.branch!==owned.workingCopy.branch||current.workingCopy.state!=='unavailable'||owned.workingCopy.mode==='separate_git'&&!current.workingCopy.branchOwned)throw new Error('Imported Git canonical ownership changed during final metadata');this.requireUpdated(owned.id,{...current.workingCopy,state:'ready',failure:undefined,updatedAt:new Date().toISOString()});}
    nativeMetadata.deferredMetadata.clear();
    for(const root of roots)this.stagedImportedGitRoots.delete(root);
    for(const receipt of receipts.values())onReceipt({...receipt,state:'completed'});
    }catch(error){
      nativeMetadata.deferredMetadata.clear();
      const receiptErrors:unknown[]=[];
      for(const id of pendingReady.keys()){const agent=this.store.getAgent(id);if(agent&&roots.includes(agent.workingCopy.rootPath)&&agent.workingCopy.state!=='removed')try{this.requireUpdated(id,{...agent.workingCopy,state:'unavailable',failure:'Native Git import proof is incomplete; preserve its exact root and original import operation.',updatedAt:new Date().toISOString()});}catch(storageError){receiptErrors.push(storageError);}}

      for(const receipt of receipts.values()){
        try{onReceipt({...receipt,state:'incomplete',error:{code:safeWorkingCopyFailureCode(error),partialStatePossible:true,observed:{paths:roots,cause:safeFailure(error)}}});}
        catch(storageError){receiptErrors.push(storageError);}
      }
      throw Object.assign(new Error('Imported Git adoption incomplete; preserve all local roots and exact import receipt',{cause:error}),{code:'ERR_IMPORTED_GIT_ADOPTION_PARTIAL',partialStatePossible:true,observed:{paths:roots},...(receiptErrors.length?{receiptErrors}:{})});
    }
  }

  async setMode(
    agent: AgentDto,
    project: ProjectDto,
    mode: AgentWorkingCopyMode,
    beforeMutation?: () => Promise<void>,
  ): Promise<AgentDto> {
    if (!this.modeChanges.has(agent.id)) {
      throw new Error("Working-folder change was not fenced before it began");
    }
    const current = this.store.getAgent(agent.id);
    if (!current || current.projectId !== project.id) {
      throw new Error("Agent became unavailable while changing its working folder");
    }
    if (current.workingCopy.mode === mode && current.workingCopy.state === "ready") {
      await this.resolve(current, project);
      return current;
    }
    if(mode==='separate_git'&&current.workingCopy.repositoryRoot!==undefined){
      throw new AgentWorkingCopyUnavailableError(current.workingCopy,'Independent imported Git creation is incomplete or released. Inspect its exact import operation for recovery; do not retry it as a Project-linked working copy.');
    }
    return this.applyMode(current, project, mode, beforeMutation);
  }

  beginModeChange(agentId: string): () => void {
    if (this.modeChanges.has(agentId)) {
      throw new Error("This Agent's working folder is already changing");
    }
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => { complete = resolve; });
    this.modeChanges.set(agentId, { completion, complete });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const change = this.modeChanges.get(agentId);
      this.modeChanges.delete(agentId);
      change?.complete();
    };
  }

  beginUse(agentId: string): () => void {
    if (this.modeChanges.has(agentId)) {
      throw new Error("This Agent's working folder is changing; retry the provider command safely");
    }
    let use = this.activeUses.get(agentId);
    if (!use) {
      let complete!: () => void;
      const completion = new Promise<void>((resolve) => { complete = resolve; });
      use = { count: 0, completion, complete };
      this.activeUses.set(agentId, use);
    }
    use.count += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.activeUses.get(agentId);
      if (!current) return;
      current.count -= 1;
      if (current.count === 0) {
        this.activeUses.delete(agentId);
        current.complete();
      }
    };
  }

  async awaitModeChanges(agentIds: ReadonlySet<string>): Promise<void> {
    const pending = [...agentIds].flatMap((agentId) => {
      const change = this.modeChanges.get(agentId);
      return change ? [change.completion] : [];
    });
    await Promise.all(pending);
  }

  async awaitUses(agentIds: ReadonlySet<string>): Promise<void> {
    const pending = [...agentIds].flatMap((agentId) => {
      const use = this.activeUses.get(agentId);
      return use ? [use.completion] : [];
    });
    await Promise.all(pending);
  }

  assertRunAdmission(
    agentId: string,
    expected: Pick<ResolvedAgentWorkingCopy, "id" | "mode" | "rootPath">,
  ): void {
    if (this.modeChanges.has(agentId)) {
      throw new Error("This Agent's working folder is changing; retry the Run safely");
    }
    const current = this.store.getAgent(agentId);
    if (!current || current.workingCopy.id !== expected.id ||
        current.workingCopy.mode !== expected.mode ||
        current.workingCopy.rootPath !== expected.rootPath) {
      throw new Error("This Agent's working folder changed before the Run started; retry safely");
    }
    if (current.workingCopy.state !== "ready") {
      // Only these fixed import states are safe to surface verbatim. Other
      // native failures can contain filesystem paths or tool output.
      const reason = current.workingCopy.failure;
      if (reason === "Native import metadata and ownership proof are pending; preserve the exact import operation." ||
          reason === "Native Git import proof is incomplete; preserve its exact root and original import operation.") {
        throw new Error(reason);
      }
      throw new Error("This Agent's working folder is unavailable; inspect its status before retrying.");
    }
  }

  /** Permanently remove a deleted Agent's explicitly retained Git copy. */
  async cleanupRetained(
    agentId: string,
    workingCopy: AgentWorkingCopyDto,
    project: Pick<ProjectDto, "id" | "hostPath">,
    options: {
      allowSourceUnavailable?: boolean;
      deleted?: boolean;
      beforeMutation?: () => Promise<void>;
      afterWorktreeRemoval?: () => void;
      beforeBranchRemoval?: () => void;
      afterBranchRemoval?: () => void;
      afterContainerRemoval?: () => void;
    } = {},
  ): Promise<AgentWorkingCopyDto> {
    if (workingCopy.mode !== "separate_git") {
      throw new Error("This deleted Agent has no retained Separate Git copy");
    }
    const expectedRoot = workingCopy.importedParent?path.join(workingCopy.importedParent.parentPath,...workingCopy.importedParent.relativePath.split('/')):path.join(this.managedRoot, project.id, agentId, "root");
    if (!samePath(path.resolve(workingCopy.rootPath), expectedRoot) ||
        !workingCopy.importedParent&&!inside(this.managedRoot, expectedRoot)) {
      throw new Error("The retained Separate Git copy is outside its managed location");
    }
    if(workingCopy.repositoryRoot!==undefined){
      if(workingCopy.repositoryRoot!==expectedRoot)throw new Error('Imported repository ownership path changed; preserve its data');
      try{await this.repositoryRoot(agentId,workingCopy,project);}catch(error){if(!missingPath(error))throw error;}
      // This repository contains imported user refs, history, config and bytes.
      // Releasing Agent authority never deletes those originals, even if clean.
      return this.persistCleanupState(agentId,{...workingCopy,state:'removed',branchCreationIntent:undefined,branchCreationReceipt:undefined,cleanupReceipt:undefined,failure:undefined,updatedAt:new Date().toISOString()},options.deleted===true);
    }
    if (workingCopy.state === "removed") {
      // Recover old terminal metadata that left its empty container behind.
      // rmdir preserves all entries, including replaced roots or user files.
      await options.beforeMutation?.();
      try {
        await rmdir(path.dirname(expectedRoot));
      } catch (error) {
        if (!missingPath(error)) throw error;
      }
      return workingCopy;
    }
    let rootExists = false;
    try {
      const metadata = await lstat(expectedRoot);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("The retained Separate Git copy is not a managed directory");
      }
      const canonical = await realpath(expectedRoot);
      if (!samePath(canonical, expectedRoot)) {
        throw new Error("The retained Separate Git copy resolves somewhere else");
      }
      rootExists = true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    // Preparation can fail before Git creates a branch or registration (for
    // example when Shared is not a Git repository). That state has no Git
    // authority to clean; removing its empty managed container is sufficient.
    if (!rootExists && !workingCopy.baseHead && !workingCopy.branchOwned &&
        !workingCopy.branchCreationIntent && !workingCopy.branchCreationReceipt &&
        !workingCopy.cleanupReceipt) {
      await options.beforeMutation?.();
      try {
        await rmdir(path.join(this.managedRoot, project.id, agentId));
      } catch (error) {
        if (!missingPath(error)) throw error;
      }
      return this.persistCleanupState(agentId, {
        ...workingCopy,
        state: "removed",
        cleanupReceipt: undefined,
        failure: undefined,
        updatedAt: new Date().toISOString(),
      }, options.deleted === true);
    }
    let projectRoot: string;
    try {
      projectRoot = await realpath(project.hostPath);
    } catch (error) {
      if (!options.allowSourceUnavailable || !missingPath(error)) throw error;
      throw new Error("The Project Shared folder is unavailable; the retained Git copy was preserved");
    }
    const topLevel = await realpath(await runGit(projectRoot, ["rev-parse", "--show-toplevel"]));
    if (!samePath(projectRoot, topLevel)) {
      throw new Error("The Project Shared folder is not the root of its Git repository");
    }
    if (!workingCopy.branch) {
      throw new Error("The retained Separate Git copy has no durable branch identity");
    }
    const cleanupReceipt = workingCopy.cleanupReceipt;
    if (cleanupReceipt && (
      workingCopy.state !== "unavailable" || workingCopy.branchOwned !== true ||
      workingCopy.branchCreationIntent !== undefined ||
      workingCopy.branchCreationReceipt !== undefined ||
      !["worktree_removal_authorized", "branch_marker_authorized", "branch_removal_authorized"].includes(cleanupReceipt.phase) ||
      !/^[0-9a-f]{40,64}$/u.test(cleanupReceipt.branchHead) ||
      (cleanupReceipt.creationOwnershipRef !== undefined &&
        !CREATION_OWNERSHIP_REF.test(cleanupReceipt.creationOwnershipRef)) ||
      (cleanupReceipt.cleanupOwnershipRef === undefined
        ? cleanupReceipt.phase === "branch_marker_authorized"
        : !CLEANUP_OWNERSHIP_REF.test(cleanupReceipt.cleanupOwnershipRef))
    )) {
      throw new Error("The retained Git copy has an invalid cleanup receipt");
    }
    const creationReceipt = workingCopy.branchCreationReceipt;
    if (creationReceipt && (
      workingCopy.state !== "unavailable" || workingCopy.branchOwned !== undefined ||
      workingCopy.branchCreationIntent !== true || !workingCopy.baseHead ||
      creationReceipt.branchHead !== workingCopy.baseHead ||
      !/^[0-9a-f]{40,64}$/u.test(creationReceipt.branchHead) ||
      !CREATION_OWNERSHIP_REF.test(creationReceipt.ownershipRef)
    )) {
      throw new Error("The retained Git copy has an invalid branch-creation receipt");
    }
    let branchOwned = workingCopy.branchOwned === true;
    let branchExists = await gitBranchExists(projectRoot, workingCopy.branch);
    const registeredRoots = branchExists
      ? await gitWorktreeBranchRoots(projectRoot, workingCopy.branch)
      : [];
    let registeredAtExpectedRoot = branchExists && registeredRoots.length === 1 &&
      samePath(registeredRoots[0]!, expectedRoot);
    if (rootExists && registeredAtExpectedRoot) {
      let currentRootMatches = false;
      try {
        const [rootTopLevel, rootBranch] = await Promise.all([
          runGit(expectedRoot, ["rev-parse", "--show-toplevel"]),
          runGit(expectedRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
        ]);
        currentRootMatches = samePath(await realpath(rootTopLevel), expectedRoot) &&
          rootBranch === workingCopy.branch;
      } catch { /* Preserve an unreadable or replaced working folder. */ }
      if (!currentRootMatches) {
        throw new Error("The retained Git working folder was replaced and was preserved");
      }
    }
    let creationOwnershipRef: string | undefined;
    if (!branchOwned && workingCopy.branchCreationIntent === true && branchExists &&
        workingCopy.baseHead) {
      const branchHead = await gitBranchHead(projectRoot, workingCopy.branch);
      if (creationReceipt) {
        const ownershipHead = await gitReferenceHead(projectRoot, creationReceipt.ownershipRef);
        if (branchHead === creationReceipt.branchHead &&
            ownershipHead === creationReceipt.branchHead &&
            registeredRoots.every((root) => samePath(root, expectedRoot))) {
          branchOwned = true;
          creationOwnershipRef = creationReceipt.ownershipRef;
        }
      } else if (registeredAtExpectedRoot && branchHead === workingCopy.baseHead) {
        branchOwned = true;
      }
    }
    if (creationReceipt && !branchExists && !rootExists && registeredRoots.length === 0) {
      if (await gitWorktreeRootRegistered(projectRoot, expectedRoot)) {
        throw new Error("The retained Separate Git copy still has a working-folder registration and was preserved");
      }
      await options.beforeMutation?.();
      try {
        await rmdir(path.join(this.managedRoot, project.id, agentId));
      } catch (error) {
        if (!missingPath(error)) throw error;
      }
      const ownershipHead = await gitReferenceHead(projectRoot, creationReceipt.ownershipRef);
      if (ownershipHead === creationReceipt.branchHead) {
        await options.beforeMutation?.();
        await runGit(projectRoot, [
          "update-ref", "-d", creationReceipt.ownershipRef, creationReceipt.branchHead,
        ]);
      }
      return this.persistCleanupState(agentId, {
        ...workingCopy,
        state: "removed",
        branchCreationIntent: undefined,
        branchCreationReceipt: undefined,
        cleanupReceipt: undefined,
        failure: undefined,
        updatedAt: new Date().toISOString(),
      }, options.deleted === true);
    }

    let durable = workingCopy;
    let phase = cleanupReceipt?.phase;
    let expectedBranchHead = cleanupReceipt?.branchHead;
    // Persist exact identity before removing the registration, then advance
    // once its absence is proven. A restart may trust only these monotonic
    // phases, never infer ownership from missing filesystem or Git state.
    if (!phase) {
      if (!rootExists && !branchExists && !workingCopy.branchOwned && !cleanupReceipt) {
        await options.beforeMutation?.();
        try {
          await rmdir(path.join(this.managedRoot, project.id, agentId));
        } catch (error) {
          if (!missingPath(error)) throw error;
        }
        return this.persistCleanupState(agentId, {
          ...workingCopy,
          state: "removed",
          branchCreationIntent: undefined,
          branchCreationReceipt: undefined,
          cleanupReceipt: undefined,
          failure: undefined,
          updatedAt: new Date().toISOString(),
        }, options.deleted === true);
      }
      if (!branchExists || !branchOwned ||
          (rootExists ? !registeredAtExpectedRoot : registeredRoots.length > 0 || !creationOwnershipRef)) {
        throw new Error("The retained Git copy no longer matches its durable branch and working-folder identity");
      }
      await assertCopyHasNoUnpreservedWork(projectRoot, expectedRoot, workingCopy.branch, rootExists);
      expectedBranchHead = await gitBranchHead(projectRoot, workingCopy.branch);
      await options.beforeMutation?.();
      durable = this.persistCleanupState(agentId, {
        ...workingCopy,
        state: "unavailable",
        branchOwned: true,
        branchCreationIntent: undefined,
        branchCreationReceipt: undefined,
        cleanupReceipt: {
          phase: "worktree_removal_authorized",
          branchHead: expectedBranchHead,
          ...(creationOwnershipRef ? { creationOwnershipRef } : {}),
        },
        failure: "Separate Git copy removal is in progress. Runs remain paused.",
        updatedAt: new Date().toISOString(),
      }, options.deleted === true);
      phase = "worktree_removal_authorized";
    }

    if (branchExists && await gitBranchHead(projectRoot, workingCopy.branch) !== expectedBranchHead) {
      throw new Error("The retained Git branch changed after cleanup was authorized and was preserved");
    }

    if (phase === "worktree_removal_authorized") {
      if (rootExists && !registeredAtExpectedRoot) {
        throw new Error("The retained Git working folder was replaced and was preserved");
      }
      if (registeredAtExpectedRoot) {
        await assertCopyHasNoUnpreservedWork(projectRoot, expectedRoot, workingCopy.branch, rootExists);
        await options.beforeMutation?.();
        await runGit(projectRoot, ["worktree", "remove", expectedRoot]);
        options.afterWorktreeRemoval?.();
      }
      if (await gitWorktreeRootRegistered(projectRoot, expectedRoot) ||
          (await gitWorktreeBranchRoots(projectRoot, workingCopy.branch)).length > 0) {
        throw new Error("The retained Git worktree registration remains after cleanup");
      }
      try {
        await lstat(expectedRoot);
        throw new Error("The retained Git working folder was replaced and was preserved");
      } catch (error) {
        if (!missingPath(error)) throw error;
      }
      await options.beforeMutation?.();
      durable = this.persistCleanupState(agentId, {
        ...durable,
        cleanupReceipt: {
          phase: "branch_marker_authorized",
          branchHead: expectedBranchHead!,
          cleanupOwnershipRef: cleanupOwnershipRef(),
          ...(durable.cleanupReceipt?.creationOwnershipRef
            ? { creationOwnershipRef: durable.cleanupReceipt.creationOwnershipRef }
            : {}),
        },
        updatedAt: new Date().toISOString(),
      }, options.deleted === true);
    }

    if (await gitWorktreeRootRegistered(projectRoot, expectedRoot) ||
        (await gitWorktreeBranchRoots(projectRoot, workingCopy.branch)).length > 0) {
      throw new Error("The retained Git worktree registration changed after cleanup and was preserved");
    }
    try {
      await lstat(expectedRoot);
      throw new Error("The retained Git working folder was replaced and was preserved");
    } catch (error) {
      if (!missingPath(error)) throw error;
    }
    const cleanupRef = durable.cleanupReceipt?.cleanupOwnershipRef;
    if (!cleanupRef) {
      if (await gitBranchExists(projectRoot, workingCopy.branch)) {
        throw new Error("The retained Git branch has no cleanup ownership marker and was preserved");
      }
    } else {
      branchExists = await gitBranchExists(projectRoot, workingCopy.branch);
      let cleanupHead = await gitReferenceHead(projectRoot, cleanupRef);
      if (durable.cleanupReceipt?.phase === "branch_marker_authorized") {
        if (!branchExists || await gitBranchHead(projectRoot, workingCopy.branch) !== expectedBranchHead) {
          throw new Error("The retained Git branch changed before cleanup ownership was recorded and was preserved");
        }
        if (cleanupHead === undefined) {
          await options.beforeMutation?.();
          await runGit(projectRoot, ["update-ref", cleanupRef, expectedBranchHead!, "0000000000000000000000000000000000000000"]);
        } else if (cleanupHead !== expectedBranchHead) {
          throw new Error("The retained Git cleanup ownership marker changed and was preserved");
        }
        await options.beforeMutation?.();
      durable = this.persistCleanupState(agentId, {
          ...durable,
          cleanupReceipt: { ...durable.cleanupReceipt, phase: "branch_removal_authorized" },
          updatedAt: new Date().toISOString(),
        }, options.deleted === true);
        cleanupHead = expectedBranchHead;
      }
      branchExists = await gitBranchExists(projectRoot, workingCopy.branch);
      cleanupHead = await gitReferenceHead(projectRoot, cleanupRef);
      if (branchExists && cleanupHead === expectedBranchHead) {
        if (await gitBranchHead(projectRoot, workingCopy.branch) !== expectedBranchHead) {
          throw new Error("The retained Git branch changed after cleanup was authorized and was preserved");
        }
        await runGit(projectRoot, ["check-ref-format", "--branch", workingCopy.branch]);
        await options.beforeMutation?.();
      options.beforeBranchRemoval?.();
        await assertCopyHasNoUnpreservedWork(projectRoot, expectedRoot, workingCopy.branch, false);
        deleteOwnedBranchReferences(projectRoot, workingCopy.branch, cleanupRef, expectedBranchHead!);
        options.afterBranchRemoval?.();
      } else if (branchExists || cleanupHead !== undefined) {
        throw new Error("The retained Git cleanup ownership proof changed and the branch was preserved");
      }
    }
    if (durable.cleanupReceipt?.creationOwnershipRef &&
        await gitReferenceHead(projectRoot, durable.cleanupReceipt.creationOwnershipRef) === expectedBranchHead) {
      await options.beforeMutation?.();
      await runGit(projectRoot, [
        "update-ref", "-d", durable.cleanupReceipt.creationOwnershipRef, expectedBranchHead!,
      ]);
    }
    await options.beforeMutation?.();
    try {
      await rmdir(path.join(this.managedRoot, project.id, agentId));
    } catch (error) {
      if (!missingPath(error)) throw error;
    }
    options.afterContainerRemoval?.();
    return this.persistCleanupState(agentId, {
      ...durable,
      state: "removed",
      branchCreationIntent: undefined,
      branchCreationReceipt: undefined,
      cleanupReceipt: undefined,
      failure: undefined,
      updatedAt: new Date().toISOString(),
    }, options.deleted === true);
  }

  /** Remove every managed Git copy before Project authority is committed away. */
  async cleanupProject(project: ProjectDto): Promise<void> {
    for (const record of this.store.listProjectWorkingCopies(project.id)) {
      if (record.workingCopy.mode !== "separate_git") continue;
      await this.cleanupRetained(record.agentId, record.workingCopy, project, {
        allowSourceUnavailable: true,
        deleted: record.deleted,
      });
    }
    if(this.store.listProjectWorkingCopies(project.id).some(record=>record.workingCopy.repositoryRoot!==undefined))return;
    try {
      await rmdir(path.join(this.managedRoot, project.id));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }

  private async applyMode(
    agent: AgentDto,
    project: ProjectDto,
    mode: AgentWorkingCopyMode,
    beforeMutation?: () => Promise<void>,
  ): Promise<AgentDto> {
    let mutationStarted = false;
    const beginMutation = async () => {
      if (mutationStarted) return;
      await beforeMutation?.();
      mutationStarted = true;
    };
    if (agent.workingCopy.mode === "separate_git" && agent.workingCopy.cleanupReceipt) {
      const recovered = await this.cleanupRetained(agent.id, agent.workingCopy, project, { beforeMutation: beginMutation });
      agent = { ...agent, workingCopy: recovered };
    }
    if (mode === "shared") {
      if (agent.workingCopy.mode === "separate_git" && agent.workingCopy.state !== "removed") {
        await this.cleanupRetained(agent.id, agent.workingCopy, project, { beforeMutation: beginMutation });
      }
      await beginMutation();
      return this.requireUpdated(agent.id, sharedWorkingCopy(project, new Date().toISOString()));
    }
    const identity = agent.workingCopy.mode === "separate_git"
      ? agent.workingCopy.id
      : `copy:${randomUUID()}`;
    const rootPath = path.join(this.managedRoot, project.id, agent.id, "root");
    const branch = agent.workingCopy.mode === "separate_git" && agent.workingCopy.branch
      ? agent.workingCopy.branch
      : separateBranch(agent);
    let branchOwned = agent.workingCopy.mode === "separate_git" &&
      agent.workingCopy.branchOwned === true;
    let branchCreationIntent = agent.workingCopy.mode === "separate_git" &&
      agent.workingCopy.branchCreationIntent === true;
    let branchCreationReceipt = agent.workingCopy.mode === "separate_git"
      ? agent.workingCopy.branchCreationReceipt
      : undefined;
    const unavailable = (failure: string, baseHead = agent.workingCopy.baseHead) => this.requireUpdated(agent.id, {
      id: identity,
      mode: "separate_git",
      state: "unavailable",
      rootPath,
      branch,
      ...(baseHead ? { baseHead } : {}),
      ...(branchOwned ? { branchOwned: true as const } : {}),
      ...(branchCreationIntent ? { branchCreationIntent: true as const } : {}),
      ...(branchCreationReceipt ? { branchCreationReceipt } : {}),
      failure,
      updatedAt: new Date().toISOString(),
    });
    let preparedBaseHead = agent.workingCopy.baseHead;
    try {
      const projectRoot = await realpath(project.hostPath);
      const topLevel = await realpath(await runGit(projectRoot, ["rev-parse", "--show-toplevel"]));
      if (!samePath(projectRoot, topLevel)) {
        throw new Error("the Project Shared folder is not the root of its Git repository");
      }
      await runGit(projectRoot, ["check-ref-format", "--branch", branch]);
      const currentHead = await runGit(projectRoot, ["rev-parse", "HEAD"]);
      const baseHead = (branchCreationIntent || branchCreationReceipt || branchOwned) &&
        agent.workingCopy.baseHead
        ? agent.workingCopy.baseHead
        : currentHead;
      preparedBaseHead = baseHead;
      let targetExists = false;
      try {
        const target = await lstat(rootPath);
        if (!target.isDirectory() || target.isSymbolicLink()) throw new Error("the Separate Git target was replaced and was preserved");
        targetExists = true;
      } catch (error) { if (!missingPath(error)) throw error; }
      // Validate every existing managed parent before mkdir/Git can follow it.
      for (const parent of [this.managedRoot, path.join(this.managedRoot, project.id), path.dirname(rootPath)]) {
        try {
          const metadata = await lstat(parent);
          if (!metadata.isDirectory() || metadata.isSymbolicLink() || !samePath(await realpath(parent), path.resolve(parent))) {
            throw new Error("the managed working-copy parent was replaced and was preserved");
          }
        } catch (error) { if (!missingPath(error)) throw error; }
      }
      if (targetExists) {
        const exactRegistration = await gitWorktreeRegistrationExact(projectRoot, rootPath, branch);
        const branchHead = await gitBranchHead(projectRoot, branch);
        const ownershipHead = branchCreationReceipt
          ? await gitReferenceHead(projectRoot, branchCreationReceipt.ownershipRef)
          : undefined;
        if (!branchOwned && !branchCreationIntent && !branchCreationReceipt) {
          throw new Error("the existing Git branch is not proven to be Ponderosa-owned");
        }
        if (!exactRegistration || (!branchOwned && branchHead !== baseHead) ||
            (branchCreationReceipt && ownershipHead !== undefined &&
              ownershipHead !== branchCreationReceipt.branchHead)) {
          throw new Error("the interrupted Git copy no longer matches its creation receipt");
        }
      } else {
        let branchExists = await gitBranchExists(projectRoot, branch);
        if (!branchExists && !branchOwned) {
          if (!branchCreationReceipt) {
            branchCreationIntent = true;
            branchCreationReceipt = {
              ownershipRef: creationOwnershipRef(),
              branchHead: baseHead,
            };
          }
          const ownershipHead = await gitReferenceHead(
            projectRoot,
            branchCreationReceipt.ownershipRef,
          );
          if (ownershipHead !== undefined) {
            throw new Error("the branch-creation ownership ref exists without its atomic branch");
          }
          await beginMutation();
          unavailable("Separate Git copy creation is in progress. Runs remain paused.", baseHead);
          await mkdir(path.dirname(rootPath), { recursive: true, mode: 0o700 });
          createOwnedBranchReferences(
            projectRoot,
            branch,
            branchCreationReceipt.ownershipRef,
            branchCreationReceipt.branchHead,
          );
          branchExists = true;
        }
        if (branchExists) {
          const registeredRoots = await gitWorktreeBranchRoots(projectRoot, branch);
          if (registeredRoots.some((root) => !samePath(root, rootPath))) {
            throw new Error("the requested Git branch is registered to another working folder");
          }
          const exactRegistration = registeredRoots.length === 1 &&
            samePath(registeredRoots[0]!, rootPath);
          const branchHead = await gitBranchHead(projectRoot, branch);
          const ownershipHead = branchCreationReceipt
            ? await gitReferenceHead(projectRoot, branchCreationReceipt.ownershipRef)
            : undefined;
          if (branchCreationReceipt) {
            if (branchHead !== branchCreationReceipt.branchHead ||
                (ownershipHead !== branchCreationReceipt.branchHead &&
                  !(ownershipHead === undefined && exactRegistration))) {
              throw new Error("the requested Git branch does not match its atomic creation receipt");
            }
            await beginMutation();
            unavailable("Separate Git copy is being prepared. Runs remain paused.", baseHead);
            await mkdir(path.dirname(rootPath), { recursive: true, mode: 0o700 });
            await runGit(projectRoot, ["worktree", "add", "--force", rootPath, branch]);
          } else if (branchOwned) {
            if (!exactRegistration) {
              throw new Error("the owned Git branch is no longer registered to its working folder");
            }
            await beginMutation();
            unavailable("Separate Git copy is being prepared. Runs remain paused.", baseHead);
            await mkdir(path.dirname(rootPath), { recursive: true, mode: 0o700 });
            await runGit(projectRoot, [
              "worktree", "add", "--force", rootPath, branch,
            ]);
          } else if (branchCreationIntent && agent.workingCopy.baseHead &&
              exactRegistration &&
              await gitBranchHead(projectRoot, branch) === agent.workingCopy.baseHead) {
            // Git may create the ref before it creates the worktree directory.
            // The durable intent plus exact ref/base identity proves this is
            // our interrupted creation, so attach that ref at the one managed
            // root instead of permanently treating it as foreign.
            await beginMutation();
            unavailable("Separate Git copy is being prepared. Runs remain paused.", baseHead);
            await mkdir(path.dirname(rootPath), { recursive: true, mode: 0o700 });
            await runGit(projectRoot, [
              "worktree", "add", "--force", rootPath, branch,
            ]);
          } else {
            throw new Error("the requested Git branch already exists and is not Ponderosa-owned");
          }
        }
      }
      const resolved = await this.resolve({
        ...agent,
        workingCopy: {
          id: identity,
          mode: "separate_git",
          state: "ready",
          rootPath,
          branch,
          baseHead,
          branchOwned: true,
          updatedAt: new Date().toISOString(),
        },
      }, project);
      if (!samePath(resolved.rootPath, rootPath)) {
        throw new Error("the prepared Separate Git copy has a different root");
      }
      await beginMutation();
      if (branchCreationReceipt) {
        const ownershipHead = await gitReferenceHead(projectRoot, branchCreationReceipt.ownershipRef);
        if (ownershipHead !== undefined) {
          if (ownershipHead !== branchCreationReceipt.branchHead) {
            throw new Error("the branch-creation ownership ref changed and was preserved");
          }
          await runGit(projectRoot, [
            "update-ref", "-d", branchCreationReceipt.ownershipRef, branchCreationReceipt.branchHead,
          ]);
        }
      }
      branchOwned = true;
      branchCreationIntent = false;
      branchCreationReceipt = undefined;
      const ready = this.requireUpdated(agent.id, {
        id: identity,
        mode: "separate_git",
        state: "ready",
        rootPath,
        branch,
        baseHead,
        branchOwned: true,
        updatedAt: new Date().toISOString(),
      });
      await this.resolve(ready, project);
      return ready;
    } catch (error) {
      if (!mutationStarted) throw error;
      return unavailable(safeFailure(error), preparedBaseHead);
    }
  }

  private requireUpdated(agentId: string, workingCopy: AgentDto["workingCopy"]): AgentDto {
    const updated = this.store.updateAgentWorkingCopy(agentId, workingCopy);
    if (!updated) throw new Error("Agent became unavailable while changing its working folder");
    return updated;
  }

  private persistCleanupState(
    agentId: string,
    workingCopy: AgentWorkingCopyDto,
    deleted: boolean,
  ): AgentWorkingCopyDto {
    if (deleted) {
      if (!this.store.updateDeletedAgentWorkingCopy(agentId, workingCopy)) {
        throw new Error("Deleted Agent became unavailable while recording working-copy cleanup");
      }
      return workingCopy;
    }
    const updated = this.store.updateAgentWorkingCopy(agentId, workingCopy);
    if (!updated) throw new Error("Agent became unavailable while recording working-copy cleanup");
    return updated.workingCopy;
  }
}

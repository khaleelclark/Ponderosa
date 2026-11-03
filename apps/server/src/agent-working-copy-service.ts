import {applyReviewedRecoveryRoots,planReviewedRecoveryRoots} from './portable-git-recreation.js';
import {assertReviewedProviderDestination,applyReviewedProviderData,createReviewedNativeGit,parseReviewedUserData,planReviewedUserDataActivation,REVIEWED_USER_DATA_PATH,type NativeReviewedGitConfiguration} from './portable-reviewed-user-data.js';
import {planFilesystemMetadata} from './portable-filesystem-metadata.js';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {importWorkingFiles,finalizeWorkingFolderMetadata} from './portable-working-files.js';
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rmdir, readdir, open } from "@ponderosa/native-host/fs/promises";
import { realpathSync } from "@ponderosa/native-host/fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  AgentWorkingCopyUnavailableError,
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
  const detail = error instanceof Error ? error.message : "Git could not prepare the folder.";
  const firstLine = detail.split(/[\r\n]/u, 1)[0]?.trim();
  return `Separate Git copy is unavailable. ${firstLine || "Git could not prepare the folder."}`.slice(0, 600);
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
  private readonly importedGitRoots=new Map<string,{sha256:string;snapshot:string;allowedRoots:string[]}>();
  private readonly importedRootCustody=new Map<string,{device:bigint;inode:bigint;agentId:string}>();
  private readonly stagedImportedGitRoots=new Map<string,{device:bigint;inode:bigint;phase:'allocated'|'populating'|'populated'|'adopting';agentId?:string}>();
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
      "updateDeletedAgentWorkingCopy" | "isManagedProjectImportDestination" | "listAgents" | "getProject"
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
      if (resolved.mode === "separate_git") {
        if (!inside(this.managedRoot, canonical)) {
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
      await createReviewedNativeGit(project.hostPath,original.data,original.sha256,original.activation,original.configuration);
      this.importedGitRoots.set(project.hostPath,{sha256:original.sha256,snapshot:await this.importedGitSnapshot(project.hostPath),allowedRoots:[project.hostPath]});return;
    }
    await runGit(project.hostPath,['init','--template=','--initial-branch=main']);
    await runGit(project.hostPath,['-c','core.hooksPath=/dev/null','-c','user.name=Ponderosa Import','-c','user.email=import@localhost','commit','--allow-empty','--no-gpg-sign','-m','Initialize imported working roots']);
  }

  /** Fresh local ownership is checked before any imported file enters a live root. */
  async populateImportedRoot(agent:AgentDto,project:ProjectDto,files:Parameters<typeof importWorkingFiles>[1],directories:Parameters<typeof importWorkingFiles>[2],metadata:Parameters<typeof importWorkingFiles>[3],backupRoot:string,links:Parameters<typeof importWorkingFiles>[5]=[],cyclicLinks:Parameters<typeof importWorkingFiles>[6]='refuse',activation?:import('@ponderosa/core').ReviewedUserDataActivation,metadataActivation?:import('@ponderosa/core').ReviewedMetadataActivation,rootDestinations?:Readonly<Record<string,string>>,deferFinalMetadata=false):Promise<void> {
    if(!this.modeChanges.has(agent.id))throw new Error('Live import was not fenced');
    const staged=this.stagedImportedGitRoots.get(agent.workingCopy.rootPath);
    if(staged){const stat=await lstat(agent.workingCopy.rootPath,{bigint:true});if(staged.phase!=='allocated'||stat.dev!==staged.device||stat.ino!==staged.inode||staged.agentId&&staged.agentId!==agent.id)throw new Error('Staged Git root changed or population was already attempted');staged.phase='populating';}
    const resolved=staged?{id:agent.workingCopy.id,mode:agent.workingCopy.mode,rootPath:agent.workingCopy.repositoryRoot?await this.repositoryRoot(agent.id,agent.workingCopy,project):agent.workingCopy.rootPath}:await this.resolve(agent,project);
    const rootIdentity=await lstat(resolved.rootPath,{bigint:true});
    this.importedRootCustody.set(resolved.rootPath,{device:rootIdentity.dev,inode:rootIdentity.ino,agentId:agent.id});
    const activationRoot=activation?rootIdentity:undefined;
    const original=activation||metadataActivation?files.find(file=>file.path===REVIEWED_USER_DATA_PATH):undefined;
    const metadataPlan=metadataActivation&&original?parseReviewedUserData(original.data):undefined;
    if(metadataActivation){
      if((resolved.mode!=='separate_git'&&!this.store.isManagedProjectImportDestination(project.id))||!original||!metadataPlan?.filesystemMetadata||createHash('sha256').update(original.data).digest('hex')!==original.sha256)throw new Error('Native metadata requires the original and a NEW managed destination');
      planFilesystemMetadata(metadataPlan.filesystemMetadata,metadataPlan.selection,metadataActivation);
    }
    if(activation){
      if(!original&&!staged||original&&createHash('sha256').update(original.data).digest('hex')!==original.sha256)throw new Error('Native activation original is unavailable or changed');
      const plan=original?(staged?parseReviewedUserData(original.data):planReviewedUserDataActivation(original.data,original.sha256,activation)):undefined;
      if(activation.harness&&plan)await assertReviewedProviderDestination(resolved.rootPath,plan);
      if(activation.git&&!staged)await this.verifyImportedGitRoot(project,original!.sha256,resolved.rootPath);
      if(resolved.mode!=='separate_git'&&!this.store.isManagedProjectImportDestination(project.id))throw new Error('Native Shared activation requires the NEW managed import destination');
    }
    await importWorkingFiles(resolved.rootPath,files,directories,activation||metadataActivation?undefined:metadata,{backupRoot},links,cyclicLinks,metadataActivation,deferFinalMetadata||!!activation||!!metadataActivation,rootDestinations);
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
      await finalizeWorkingFolderMetadata(current.rootPath,files,directories,metadata,links,metadataActivation);
    }
    if(staged)staged.phase='populated';
  }

  async finalizeImportedRootMetadata(agent:AgentDto,project:ProjectDto,files:Parameters<typeof importWorkingFiles>[1],directories:Parameters<typeof importWorkingFiles>[2],metadata:Parameters<typeof importWorkingFiles>[3],links:Parameters<typeof importWorkingFiles>[5],activation?:import('@ponderosa/core').ReviewedMetadataActivation,counts?:ReadonlyMap<string,bigint>):Promise<void>{
    if(!this.modeChanges.has(agent.id))throw new Error('Final live metadata requires its fenced imported destination');
    const root=await this.resolve(agent,project),proof=this.importedRootCustody.get(root.rootPath),stat=await lstat(root.rootPath,{bigint:true});
    if(!proof||proof.agentId!==agent.id||proof.device!==stat.dev||proof.inode!==stat.ino||await realpath(root.rootPath)!==root.rootPath)throw new Error('Final metadata root lost its fresh local custody');
    await finalizeWorkingFolderMetadata(root.rootPath,files,directories,metadata,links,activation,counts);
  }

  /** Local storage authority; a source package never supplies this path. */
  private async repositoryRoot(agentId:string,workingCopy:AgentWorkingCopyDto,project:Pick<ProjectDto,'id'|'hostPath'>):Promise<string> {
    if(workingCopy.repositoryRoot===undefined)return realpath(project.hostPath);
    const expected=path.join(this.managedRoot,project.id,agentId,'root');
    if(workingCopy.repositoryRoot!==expected||workingCopy.rootPath!==expected||!inside(this.managedRoot,expected))throw new Error('Independent imported Git repository has no local managed ownership');
    const stat=await lstat(expected);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(expected)!==expected)throw new Error('Independent imported Git root changed; preserve its data');
    return expected;
  }

  /** Capture directory or locally recreated pointer layouts without assuming
   * source Git paths are destination authority. No hooks or filters execute. */
  private async importedGitSnapshot(rootPath:string,allowedRoots:string[]=[rootPath]):Promise<string> {
    const root=await lstat(rootPath,{bigint:true});
    if(!root.isDirectory()||await realpath(rootPath)!==rootPath)throw new Error('Imported Git root changed');
    const gitDir=path.resolve(rootPath,await runGit(rootPath,['rev-parse','--absolute-git-dir']));
    const commonDir=path.resolve(rootPath,await runGit(rootPath,['rev-parse','--git-common-dir']));
    if(![gitDir,commonDir].every(target=>allowedRoots.some(root=>target===root||inside(root,target))))throw new Error('Imported Git storage is outside its locally owned root');
    const entries:unknown[]=[{path:rootPath,device:root.dev,inode:root.ino}],seen=new Set<string>();let count=0;
    const inspect=async(target:string):Promise<void>=>{
      if(seen.has(target))return;seen.add(target);if(++count>30000)throw new Error('Imported Git inventory exceeds its bound');
      const stat=await lstat(target,{bigint:true});
      if(stat.isDirectory()){
        if(await realpath(target)!==target)throw new Error('Imported Git directory changed');
        entries.push({path:target,device:stat.dev,inode:stat.ino});
        for(const name of (await readdir(target)).sort())await inspect(path.join(target,name));
      }else{
        if(!stat.isFile()||stat.nlink!==1n||stat.size>33554432n||await realpath(path.dirname(target))!==path.dirname(target))throw new Error('Imported Git file is not exclusive');
        const handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
        try{
          const before=await handle.stat({bigint:true});if(before.dev!==stat.dev||before.ino!==stat.ino)throw new Error('Imported Git file replaced');
          const data=await handle.readFile(),after=await handle.stat({bigint:true}),current=await lstat(target,{bigint:true});
          if(before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||current.dev!==before.dev||current.ino!==before.ino)throw new Error('Imported Git file changed');
          entries.push({path:target,device:stat.dev,inode:stat.ino,sha256:createHash('sha256').update(data).digest('hex')});
        }finally{await handle.close();}
      }
    };
    await inspect(path.join(rootPath,'.git'));await inspect(commonDir);await inspect(gitDir);
    const after=await lstat(rootPath,{bigint:true});if(root.dev!==after.dev||root.ino!==after.ino)throw new Error('Imported Git root replaced');
    return JSON.stringify(entries,(_key,value)=>typeof value==='bigint'?value.toString():value);
  }

  private async verifyImportedGitRoot(_project:ProjectDto,sha256:string,rootPath:string):Promise<void> {
    const proof=this.importedGitRoots.get(rootPath);
    if(!proof||proof.sha256!==sha256||proof.snapshot!==await this.importedGitSnapshot(rootPath,proof.allowedRoots))throw new Error('Native Git differs from its exact local before-population ownership proof; preserve partial application');
  }

  private async stageImportedGitRoot(rootPath:string,agentId?:string):Promise<void> {
    const stat=await lstat(rootPath,{bigint:true});
    if(!stat.isDirectory()||await realpath(rootPath)!==rootPath||(await readdir(rootPath)).length||this.stagedImportedGitRoots.has(rootPath))throw new Error('Native import root must be freshly allocated and empty');
    this.stagedImportedGitRoots.set(rootPath,{device:stat.dev,inode:stat.ino,phase:'allocated',...(agentId?{agentId}:{})});
  }

  async stageImportedSharedGit(project:ProjectDto):Promise<void> {
    if(!this.store.isManagedProjectImportDestination(project.id)||this.store.listAgents(project.id).length)throw new Error('Native Shared Git requires the unused NEW managed Chat');
    await this.stageImportedGitRoot(project.hostPath);
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
  async completeImportedGitRoots(project:ProjectDto,pkg:import('@ponderosa/core').AgentPortablePackageDto,destinations:Record<string,string>,activation:import('@ponderosa/core').ReviewedUserDataActivation,onReceipt:Parameters<typeof applyReviewedRecoveryRoots>[2],agentIds:readonly string[]=[]):Promise<void> {
    const roots=[...new Set([...Object.values(destinations),...[...this.stagedImportedGitRoots.entries()].filter(([root,staged])=>staged.agentId&&agentIds.includes(staged.agentId)&&root.startsWith(this.managedRoot+path.sep)).map(([root])=>root)])],tasks=planReviewedRecoveryRoots(pkg,destinations,activation);
    for(const root of roots){
      const staged=this.stagedImportedGitRoots.get(root),stat=await lstat(root,{bigint:true});
      if(!staged||(staged.phase!=='populated'&&!(staged.phase==='allocated'&&!Object.values(destinations).includes(root)))||stat.dev!==staged.device||stat.ino!==staged.inode||await realpath(root)!==root)throw new Error('Native import root is not in its exact populated phase');
      if(staged.agentId&&(!agentIds.includes(staged.agentId)||!this.modeChanges.has(staged.agentId)||this.activeUses.has(staged.agentId)))throw new Error('Git adoption lost exact current Agent custody');
      staged.phase='adopting';
    }
    // The shared recreation engine validates included target/config closure and
    // records each applying/incomplete outcome. Harness files are already placed.
    const receipts=new Map<string,Parameters<typeof onReceipt>[0]>();
    try{
    await applyReviewedRecoveryRoots(tasks,{...activation,harness:false},receipt=>{const current={...receipt,selection:activation,state:receipt.state==='completed'?'applying' as const:receipt.state};receipts.set(receipt.ref,current);onReceipt(current);});
    for(const root of roots){
      const staged=this.stagedImportedGitRoots.get(root)!;if(!staged.agentId)continue;
      const agent=this.store.getAgent(staged.agentId);if(!agent||agent.workingCopy.repositoryRoot!==root||agent.workingCopy.state!=='unavailable')throw new Error('Imported Separate Git ownership changed before activation');
      const workingCopy=agent.workingCopy,branch=workingCopy.branch!;
      if(!tasks.some(task=>task.destination===root))await runGit(root,['init','--template=','--initial-branch=main']);
      // An unborn source needs only a local empty ownership commit. The selected
      // source index and every imported branch/ref are retained unchanged.
      let baseHead:string;
      try{baseHead=await runGit(root,['rev-parse','--verify','HEAD^{commit}']);}
      catch(error){
        const task=tasks.find(task=>task.destination===root),git=task?.value.git;
        if(git&&(!('symbolic' in git.head)||git.refs.some(ref=>ref.name===('symbolic' in git.head?git.head.symbolic:''))))throw error;
        const emptyTree=execFileSync('git',['-c','core.hooksPath=/dev/null','hash-object','-t','tree','-w','--stdin'],{cwd:root,env:gitEnvironment(),input:'',encoding:'utf8',timeout:GIT_TIMEOUT_MS}).trim();
        baseHead=execFileSync('git',['-c','core.hooksPath=/dev/null','-c','user.name=Ponderosa Import','-c','user.email=import@localhost','commit-tree',emptyTree,'-m','Initialize imported Separate ownership'],{cwd:root,env:gitEnvironment(),encoding:'utf8',timeout:GIT_TIMEOUT_MS}).trim();
      }
      if(await gitBranchExists(root,branch))throw new Error('The newly allocated managed branch collides with imported user refs');
      const receipt={ownershipRef:creationOwnershipRef(),branchHead:baseHead};
      this.requireUpdated(agent.id,{...workingCopy,baseHead,branchCreationIntent:true,branchCreationReceipt:receipt});
      createOwnedBranchReferences(root,branch,receipt.ownershipRef,baseHead);
      await runGit(root,['symbolic-ref','HEAD','refs/heads/'+branch]);
      await runGit(root,['update-ref','-d',receipt.ownershipRef,baseHead]);
      const ready=this.requireUpdated(agent.id,{...workingCopy,state:'ready',baseHead,branchOwned:true,failure:undefined,updatedAt:new Date().toISOString()});
      const ownerProject=this.store.getProject(ready.projectId);if(!ownerProject)throw new Error('Imported Git owner Project disappeared');
      await this.resolve(ready,ownerProject);
    }
    // Seal after every local branch is established: common Git storage can be
    // shared by multiple selected roots, so earlier snapshots would be obsolete.
    for(const task of tasks)this.importedGitRoots.set(task.destination,{sha256:task.sha256,snapshot:await this.importedGitSnapshot(task.destination,roots),allowedRoots:roots});
    for(const root of roots)this.stagedImportedGitRoots.delete(root);
    for(const receipt of receipts.values())onReceipt({...receipt,state:'completed'});
    }catch(error){
      for(const receipt of receipts.values())onReceipt({...receipt,state:'incomplete',error:{code:(error as {code?:string}).code??'ERR_IMPORTED_GIT_ADOPTION_PARTIAL',partialStatePossible:true,observed:{paths:roots}}});
      throw Object.assign(new Error('Imported Git adoption incomplete; preserve all local roots and exact import receipt',{cause:error}),{code:'ERR_IMPORTED_GIT_ADOPTION_PARTIAL',partialStatePossible:true,observed:{paths:roots}});
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
    if (!current || current.workingCopy.state !== "ready" ||
        current.workingCopy.id !== expected.id ||
        current.workingCopy.mode !== expected.mode ||
        current.workingCopy.rootPath !== expected.rootPath) {
      throw new Error("This Agent's working folder changed before the Run started; retry safely");
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
    const expectedRoot = path.join(this.managedRoot, project.id, agentId, "root");
    if (!samePath(path.resolve(workingCopy.rootPath), expectedRoot) ||
        !inside(this.managedRoot, expectedRoot)) {
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

import {decodePortableMetadataArtifact} from '../agent-package-codec.js';
import {retainedOrphanDiscovery} from '../retained-orphan-discovery.js';
import {applyReviewedRecoveryRoots,planReviewedRecoveryRoots} from '../portable-git-recreation.js';
import {groupJournalAudit} from '../group-journal-audit.js';
import {checkpointGroupCaptureAbandonment} from '../checkpoint-group-capture-abandonment.js';
import {lifecycleDiscovery} from '../lifecycle-discovery.js';
import {destinationLifecycle} from '../destination-lifecycle.js';
import {checkpointCaptureAbandonment} from '../checkpoint-capture-abandonment.js';
import {destinationAdmissionHeld} from '@ponderosa/agents';
import {checkpointCustodyLifecycle} from '../checkpoint-custody-lifecycle.js';
import {custodyLifecycleProof} from '../custody-lifecycle-proof.js';
import {composeAgentPackages,type AgentPackageCompositionInput,type AgentPackageComposition} from '../compose-agent-packages.js';
import {assertCheckpointMembership} from '../checkpoint-package-membership.js';
import {activeChatResourceOwner} from '../branch-resource-owner.js';
import {checkpointPackageCustody,type CheckpointPackageSource,type CheckpointPackageReceipt,type CheckpointPackageStatus} from '../checkpoint-agent-packages.js';
export type {CheckpointPackageSource,CheckpointPackageReceipt,CheckpointPackageStatus} from '../checkpoint-agent-packages.js';
export type {AgentPackageCompositionInput,AgentPackageComposition} from '../compose-agent-packages.js';
import {withoutPortableSecrets,redactPortableDiagnostic} from '../portable-secrets.js';
import {planReviewedUserDataActivation,REVIEWED_USER_DATA_PATH,validateReviewedUserDataActivation,validateReviewedUserDataSelection,validateReviewedMetadataActivation,requireReviewedMetadataApplication,validateGitStorageSelections,createGitExportCapture,verifyGitExportAssociations,validatePortableGitStorageBindings,type GitExportCapture,type SelectedGitBinding} from '../portable-reviewed-user-data.js';
import {filesystemMetadataProvenance,planFilesystemMetadata} from '../portable-filesystem-metadata.js';
import {parseReviewedUserData} from '../portable-reviewed-user-data.js';
import {exportWorkingFiles,importWorkingFiles,validateWorkingFileData,inventoryWorkingFolder,validateMappedWorkingLinks,createWorkingHardlinkCapture,verifyWorkingHardlinkCapture,orderWorkingRoots,finalizeWorkingFolderMetadata,workingLinkCounts,type WorkingFolderInventory} from '../portable-working-files.js';
import type {AgentWorkingCopyService} from '../agent-working-copy-service.js';
import {CapabilityPolicyStore} from '@ponderosa/agents';
import {portableCommunicationVisible,portableCommunicationMessage} from '../portable-communication.js';
import type {OutputAgentApps} from '../output-agent-apps.js';
import {localMemoryFor} from '../local-memory.js';
import {validateMemorySnapshot} from '../portable-memory-snapshot.js';
import {executionArchives,validateExecutionArchive,EXECUTION_ARCHIVE_MEDIA_TYPE} from '../portable-execution-archive.js';
import { createHash, randomUUID } from "node:crypto";
import {constants} from "node:fs";
import syncFs,{ createReadStream, promises as fs } from "@ponderosa/native-host/fs";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import {
  normalizeAgentRole, FULL_PACKAGE_EXPORT_WARNING, agentPackageJsonUtf8Bytes, AGENT_PACKAGE_MAX_AGENTS, AGENT_PACKAGE_MAX_BYTES, AGENT_PACKAGE_ARTIFACT_MAX_BYTES,
  AGENT_PACKAGE_STAGING_MAX_BYTES, AGENT_PACKAGE_METADATA_MAX_BYTES,
  AGENT_PACKAGE_LIMIT_LABEL, AGENT_PACKAGE_ARTIFACT_LIMIT_LABEL,
} from "@ponderosa/core";
import path from "node:path";
import type {
  AgentAccessImportReviewDto,
  AgentImportOperationDto,
  AgentImportPhase,
  AgentDto,
  AgentExportMode,
  AgentPortablePackageDto,
  Adapter,
  CopyAgentPackageRequest,
  ImportAgentPackageRequest,
  ImportAgentPackageResponse,
  ModelOption,
} from "@ponderosa/core";
import {
  beginSourceCapture,commitSourceCapture,releaseSourceCapture,
  publishManagedArtifactContentsAsync,
  readManagedArtifactContentsAsync,
  readManagedArtifactContent,
  removeManagedArtifactContent,
  stableJson,
  importedAgentHistoryPath,
  type AgentStore,
  type CoordinationV3Store,
} from "@ponderosa/agents";
import type { FastifyContentTypeParser, FastifyInstance, FastifyReply,FastifyRequest } from "fastify";
import type {IncomingMessage} from 'node:http';
import {requestProduct,resourceInProduct} from '../product-scope.js';
import type { createOperationalNotifications } from "../operational-notifications.js";
import {
  rewritePortableArtifactReferences,
} from "../artifact-refs.js";
import {
  AssetError,
  type AssetStore,
  generatedArtifactMetadataIsValid,
  type RegisteredGeneratedArtifact,
} from "../assets.js";
import { runtimeSelectionError, runtimeSpeedSelectionError } from "../runtime-selection.js";
import {
  exactObjectFields,
  validatedObject,
} from "../object-validation.js";
import {
  assertAgentPackageMemoryAvailable,
  decodePortableArtifactData,
  encodePortableArtifactData,
  parsePortablePackageFile,
  portablePackageJsonChunks,
  portableArtifactByteLength,
  portableImportPayloadHash,
  withAgentImportAdmission,
} from "../agent-package-codec.js";

import {validatePortableAgentPackage} from "../portable-agent-package-validation.js";
export interface BranchPackageExportOptions {
  organization?:boolean;
  selectedWorkingFiles?:readonly string[];
  wholeWorkingFolder?:boolean;
  organizationWorkingFolders?:boolean;
  reviewedUserData?:import('@ponderosa/core').ReviewedUserDataSelection;
  gitStorageBindings?:import('@ponderosa/core').GitStorageSelection[];
}
export interface BranchPackageImportOptions {
  signal?:AbortSignal;
  branchHooks?:BranchImportHooks;
  accessSettingsResolution?:ImportAgentPackageRequest['accessSettingsResolution'];
  workingFilesDestination?:ImportAgentPackageRequest['workingFilesDestination'];
  workingRootDestinations?:ImportAgentPackageRequest['workingRootDestinations'];
  workingFilesActivation?:ImportAgentPackageRequest['workingFilesActivation'];
  reviewedUserDataActivation?:ImportAgentPackageRequest['reviewedUserDataActivation'];
  reviewedMetadataActivation?:ImportAgentPackageRequest['reviewedMetadataActivation'];
}
/** Shared packaging boundary; callers own durable human review and destination selection. */
export interface BranchPackageEngine {
  inspectCheckpoint(source:CheckpointPackageSource):Promise<CheckpointPackageStatus>;
  captureCheckpoint(source:CheckpointPackageSource,seal?:(receipt:CheckpointPackageReceipt)=>void):Promise<CheckpointPackageReceipt>;
  readCheckpoint(receipt:CheckpointPackageReceipt):Promise<AgentPortablePackageDto>;
  readCheckpointBytes(receipt:CheckpointPackageReceipt):Promise<string>;
  verifyCheckpointNow(receipt:CheckpointPackageReceipt):string;
  finishDestinationImport(operationId:string,compose:(result:ImportAgentPackageResponse,complete:()=>void)=>void):void;
  releaseCheckpoint(receipt:CheckpointPackageReceipt):Promise<void>;
  composeAgents(inputs:readonly AgentPackageCompositionInput[]):Promise<AgentPackageComposition>;
  setOutputApps(owner:OutputAgentApps):void;
  validateAgent(pkg:AgentPortablePackageDto,engines:Record<string,string>):void;
  exportMemory(chatId:string,agentIds:string[]):Promise<import('@ponderosa/core').PortableChatMemorySnapshotDto>;
  verifyStagedMemory(operationId:string,pkg:AgentPortablePackageDto):Promise<void>;
  rollbackStagedMemory(operationId:string):Promise<void>;
  exportAgent(id:string,mode:'template'|'full',options?:BranchPackageExportOptions):Promise<AgentPortablePackageDto>;
  reviewAccess(pkg:AgentPortablePackageDto,chatId:string,selection?:Pick<ImportAgentPackageRequest,'reviewedUserDataActivation'|'reviewedMetadataActivation'|'workingFilesActivation'|'workingFilesDestination'|'workingRootDestinations'|'workingCopyMode'>):Promise<AgentAccessImportReviewDto>;
  importAgent(projectId:string,chatId:string,pkg:AgentPortablePackageDto,engines:Record<string,string>,key:string,options?:BranchPackageImportOptions):Promise<ImportAgentPackageResponse>;
}
export interface BranchPackageImportError extends Error {
  statusCode:number;
  provisionRejected:boolean;
  accessSettingsReview?:AgentAccessImportReviewDto;
}
export interface BranchImportHooks {
  /** Persist idle canonical members for a later explicit human admission command. */
  holdForDisclosure?(result:ImportAgentPackageResponse):void;
  /** Called inside import reservation, before async effects and Agent creation. */
  stage?(plan:import('@ponderosa/core').CoordinationDestinationImportPlan):void;
  /** May wait for durable human disclosure review, outside any SQLite transaction. */
  beforeAdmit?(result:ImportAgentPackageResponse):void|Promise<void>;
  /** Compose historical admission; invoke completeImport synchronously in the owner transaction. */
  admit?(result:ImportAgentPackageResponse,completeImport:()=>void):void;
  plan(agentIds: string[], creationOperationId?: string): void | Promise<void>;
  transaction?(operation:()=>void):void;
  commit(result: ImportAgentPackageResponse): void;
}

interface AgentPackageRoutesContext {
  destinationRuntimeIdle:()=>boolean;
  assertLifecycleEffectsSettled:()=>void;
  custodyOwner:()=>import('@ponderosa/agents').BranchCustodyLifecycle;
  dataDir: string;
  workingCopies?: AgentWorkingCopyService;
  portableBrowserSettings?:(agent:AgentDto)=>{savedBrowserAllowed:boolean;browserMode:'disposable'|'trusted';sourceProfileName?:string};
  store: AgentStore;
  coordination: CoordinationV3Store;
  assets: AssetStore;
  engines: ReadonlyMap<string, { adapter: Adapter }>;
  deletingProjectIds: ReadonlySet<string>;
  deletingConversationIds: ReadonlySet<string>;
  deletingAgentIds: Set<string>;
  agentCreationConversationLeases: Map<string, number>;
  cachedModelOptions: (adapter: Adapter, projectId?: string) => ModelOption[] | undefined;
  appendWorkspace: (event: {
    type: "project_changed";
    projectId: string;
    action: "updated";
  } | {
    type: "conversation_changed";
    projectId: string;
    conversationId: string;
    action: "updated";
  }) => unknown;
  agentMessages: (agentId: string) => Array<{
    role: "user" | "assistant";
    text: string;
    createdAt: string;
  }>;
  createOperationalNotification: ReturnType<
    typeof createOperationalNotifications
  >["createOperationalNotification"];
}

export function registerAgentPackageRoutes(
  app: FastifyInstance,
  context: AgentPackageRoutesContext,
): {packageEngine:BranchPackageEngine} {
  const groupAudit=groupJournalAudit(context.store.sqlite,context.coordination);
  app.get<{Querystring:import('@ponderosa/core').GroupJournalAuditSelection}>('/api/lifecycle/destination-groups/journal',(request,reply)=>{
    try{exactObjectFields(validatedObject(request.query,'Group journal audit'),['kind','branchId','executionId','journalKey','journalSha256','custodySha256','commandKey','admissionId','reservationHash'],'Group journal audit');return groupAudit.read(request.query);}
    catch(error){return reply.code(409).send({error:error instanceof SyntaxError?'Invalid retained group audit metadata':(error as Error).message});}
  });
  const checkpointCustody=checkpointPackageCustody(context.dataDir);
  const lifecycle=checkpointCustodyLifecycle(path.join(context.dataDir,'checkpoint-package-custody'),(source,id)=>custodyLifecycleProof(context.store.sqlite,source,id,context.custodyOwner()));
  // Inherits the operator origin/capability boundary; reconciliation is never an Agent tool.
  app.get('/api/portable-metadata/provenance',()=>filesystemMetadataProvenance());
  app.get<{Querystring:import('@ponderosa/core').LifecycleDiscoveryQuery}>('/api/lifecycle/checkpoint-custody',(request,reply)=>{
    try{return lifecycle.list(request.query);}catch(error){return reply.code(409).send({error:(error as Error).message});}
  });
  app.get<{Params:{id:string}}>('/api/lifecycle/checkpoint-custody/:id',(request,reply)=>{
    try{return context.store.sqlite.transaction(()=>lifecycle.review(request.params.id))();}catch(error){return reply.code(409).send({error:(error as Error).message});}
  });
  app.post<{Params:{id:string};Body:import('@ponderosa/core').CheckpointCustodyReconcileInput}>('/api/lifecycle/checkpoint-custody/:id/reconcile',(request,reply)=>withAgentImportAdmission(async()=>{
    try{const body=validatedObject(request.body,'Custody reconciliation');exactObjectFields(body,['commandKey','reviewSha256','preserveEvidence'],'Custody reconciliation');return context.store.sqlite.transaction(()=>lifecycle.reconcile(request.params.id,body as unknown as import('@ponderosa/core').CheckpointCustodyReconcileInput)).immediate();}
    catch(error){return reply.code(409).send({error:(error as Error).message});}
  }));
  const groupAbandonment=checkpointGroupCaptureAbandonment(context.dataDir,context.store.sqlite,context.custodyOwner);
  app.post<{Body:import('@ponderosa/core').CheckpointGroupCaptureAbandonmentReviewInput}>('/api/lifecycle/checkpoint-capture-groups/abandonment-review',(request,reply)=>{
    try{context.assertLifecycleEffectsSettled();const body=validatedObject(request.body,'Group capture review');exactObjectFields(body,['executionId','captureKey'],'Group capture review');return groupAbandonment.review(request.body);}
    catch(error){return reply.code(409).send({error:error instanceof SyntaxError?'Invalid group capture metadata; evidence remains held':(error as Error).message});}
  });
  app.post<{Body:import('@ponderosa/core').CheckpointGroupCaptureAbandonmentInput}>('/api/lifecycle/checkpoint-capture-groups/abandon',(request,reply)=>withAgentImportAdmission(async()=>{
    try{context.assertLifecycleEffectsSettled();const body=validatedObject(request.body,'Group capture abandonment');exactObjectFields(body,['executionId','captureKey','commandKey','reviewSha256','preserveEvidence'],'Group capture abandonment');return groupAbandonment.abandon(request.body);}
    catch(error){return reply.code(409).send({error:error instanceof SyntaxError?'Invalid group capture metadata; evidence remains held':(error as Error).message});}
  }));
  const abandonment=checkpointCaptureAbandonment(context.dataDir,context.store.sqlite,context.custodyOwner);
  app.post<{Body:import('@ponderosa/core').CheckpointCaptureAbandonmentReviewInput}>('/api/lifecycle/checkpoint-captures/abandonment-review',(request,reply)=>{
    try{context.assertLifecycleEffectsSettled();const body=validatedObject(request.body,'Capture abandonment review');exactObjectFields(body,['source','captureKey'],'Capture abandonment review');return abandonment.review(request.body);}
    catch(error){return reply.code(409).send({error:(error as Error).message});}
  });
  app.post<{Body:import('@ponderosa/core').CheckpointCaptureAbandonmentInput}>('/api/lifecycle/checkpoint-captures/abandon',(request,reply)=>withAgentImportAdmission(async()=>{
    try{context.assertLifecycleEffectsSettled();const body=validatedObject(request.body,'Capture abandonment');exactObjectFields(body,['source','captureKey','commandKey','reviewSha256','preserveEvidence'],'Capture abandonment');return abandonment.abandon(request.body);}
    catch(error){return reply.code(409).send({error:(error as Error).message});}
  }));
  const {
    store,
    coordination: coordinationV3,
    assets,
    engines,
    deletingProjectIds,
    deletingConversationIds,
    deletingAgentIds,
    agentCreationConversationLeases,
    cachedModelOptions,
    appendWorkspace,
    agentMessages,
    createOperationalNotification,
  } = context;
  const validateNativeSelection=(pkg:AgentPortablePackageDto,selection:Pick<ImportAgentPackageRequest,'reviewedUserDataActivation'|'reviewedMetadataActivation'|'workingFilesActivation'|'workingFilesDestination'|'workingRootDestinations'|'workingCopyMode'>,projectId:string)=>{
    if(selection.reviewedMetadataActivation!==undefined){
      const metadataActivation=selection.reviewedMetadataActivation;requireReviewedMetadataApplication(metadataActivation);
      if(pkg.mode!=='full')throw new Error('Metadata restoration requires a full package');
      const refs=new Set(pkg.agents.filter(node=>node.workingFolder).map(node=>node.workingRootRef??node.ref));
      for(const ref of metadataActivation.rootRefs){
        if(!refs.has(ref))throw new Error('Metadata activation names an absent complete working root');
        const node=pkg.agents.find(node=>(node.workingRootRef??node.ref)===ref&&node.workingFolder)!;
        const file=node.workingFiles?.find(file=>file.path===REVIEWED_USER_DATA_PATH),artifact=file&&node.artifacts?.find(artifact=>artifact.ref===file.artifactRef);
        if(!artifact)throw new Error('Metadata restoration requires its authoritative original');
        const manifest=parseReviewedUserData(decodePortableMetadataArtifact(artifact));
        if(!manifest.filesystemMetadata)throw new Error('Per-node metadata evidence is absent');
        planFilesystemMetadata(manifest.filesystemMetadata,manifest.selection,metadataActivation);
      }
      if(selection.workingFilesActivation&&pkg.agents.some(node=>metadataActivation.rootRefs.includes(node.workingRootRef??node.ref)&&(selection.workingCopyMode??node.workingCopyMode??'shared')==='shared')&&!store.isManagedProjectImportDestination(projectId))throw new Error('Live metadata application requires a NEW managed destination');
    }
    const activation=selection.reviewedUserDataActivation;if(!activation)return;
    validateReviewedUserDataActivation(activation);
    if(!selection.workingFilesActivation){
      const owner=pkg.agents.find(node=>node.workingFolder||node.workingFiles?.length);
      const destinations=selection.workingRootDestinations??(selection.workingFilesDestination&&owner?{[owner.workingRootRef??owner.ref]:selection.workingFilesDestination}:{});
      planReviewedRecoveryRoots(pkg,destinations,activation);return;
    }
    const project=store.getProject(projectId),owners=pkg.agents.filter(node=>node.workingFolder||node.workingFiles?.length);
    if(pkg.mode!=='full'||!project||!owners.length)throw new Error('Native activation requires selected full-package working roots');
    const shared=pkg.agents.filter(node=>(selection.workingCopyMode??node.workingCopyMode??'shared')==='shared');
    if(shared.length&&(selection.workingFilesActivation.sharedRoot!==project.hostPath||!store.isManagedProjectImportDestination(projectId)||store.listAgents(projectId).length))throw new Error('Native Shared data requires the confirmed unused NEW managed Chat');
    const first=owners[0]!,destinations=selection.workingRootDestinations??(selection.workingFilesDestination?{[first.workingRootRef??first.ref]:selection.workingFilesDestination}:{});
    // Review against the user's selected recovery map. At application the same
    // included paths relocate to server-issued live roots, never arbitrary hosts.
    planReviewedRecoveryRoots(pkg,destinations,activation);

  };
  const reviewAccess = async(pkg:AgentPortablePackageDto,chatId:string,selection:Pick<ImportAgentPackageRequest,'reviewedUserDataActivation'|'reviewedMetadataActivation'|'workingFilesActivation'|'workingFilesDestination'|'workingRootDestinations'|'workingCopyMode'>={}):Promise<AgentAccessImportReviewDto>=>{
    const portable=validatePortableAgentPackage(pkg).package;
    const chat=store.getConversation(chatId);
    if(!chat||deletingConversationIds.has(chat.id)||deletingProjectIds.has(chat.projectId))throw Object.assign(new Error('Import destination unavailable'),{statusCode:404});
    if(selection.reviewedUserDataActivation!==undefined||selection.reviewedMetadataActivation!==undefined)validateNativeSelection(portable,selection,chat.projectId);
    const destination=new CapabilityPolicyStore(store.sqlite).resolveForChat(chat.id);
    const reviewSha256=await portableImportPayloadHash({package:portable,destination:chat.id,destinationPolicy:destination,...(selection.reviewedUserDataActivation||selection.reviewedMetadataActivation?{nativeApplication:{reviewedMetadataActivation:selection.reviewedMetadataActivation,reviewedUserDataActivation:selection.reviewedUserDataActivation,workingFilesActivation:selection.workingFilesActivation,workingFilesDestination:selection.workingFilesDestination,workingRootDestinations:selection.workingRootDestinations,workingCopyMode:selection.workingCopyMode,projectRoot:store.getProject(chat.projectId)?.hostPath,newManagedDestination:store.isManagedProjectImportDestination(chat.projectId)}}:{})});
    return {reviewSha256,source:portable.agents.map(node=>({ref:node.ref,settings:node.accessSettings})),destination};
  };
  let outputApps:OutputAgentApps|undefined;
  const blobImportContentType = "application/vnd.ponderosa.agent-import";
  const importOperationDirectory = path.join(context.dataDir, "agent-import-operations");
  const operationPath = (id: string) => path.join(importOperationDirectory, `${id}.json`);
  const payloadPath = (id: string) => path.join(importOperationDirectory, `${id}.payload`);
  const copySnapshotPath = (id: string) => path.join(importOperationDirectory, `${id}.copy.payload`);
  const removeCopySnapshot = async (id: string): Promise<void> => {
    let removed = false;
    await fs.unlink(copySnapshotPath(id))
      .then(() => { removed = true; })
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    if (removed) {
      releaseStagedReservation(operationReservations.get(`${id}.copy`));
      operationReservations.delete(`${id}.copy`);
    }
    if (removed && process.platform !== "win32") {
      const directory = await fs.open(importOperationDirectory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  };
  const operationByRequest = new Map<string, string>();
  const operationCache = new Map<string, AgentImportOperationDto>();
  const quarantinedOperationIds = new Set<string>();
  const projectImportTails = new Map<string, Promise<void>>();
  const activeCopyOperations = new Set<string>();
  type StagedImportUpload = {
    pathname: string;
    sha256: string;
    size: number;
    reservationId: string;
    metadata?:Omit<ImportAgentPackageRequest,'package'>;
  };
  const ownedUploads=new WeakSet<StagedImportUpload>();
  const pendingUploads=new WeakMap<IncomingMessage,StagedImportUpload>();
  const completedUploadRequests=new WeakSet<IncomingMessage>();
  // Owned package processing can legitimately exceed the server's 10-second
  // idle socket timeout before response headers. Body intake remains covered
  // by the server request deadline, byte quotas and owned-upload lifecycle.
  const packageOperation = async (_request: FastifyRequest, reply: FastifyReply) => {
    if (typeof reply.raw.socket?.setTimeout === "function") reply.raw.socket.setTimeout(0);
  };
  const maximumImportBytes = AGENT_PACKAGE_MAX_BYTES + AGENT_PACKAGE_METADATA_MAX_BYTES + 1;
  const maximumJsonImportBytes = AGENT_PACKAGE_MAX_BYTES + AGENT_PACKAGE_METADATA_MAX_BYTES + 12;
  const maximumStagedImportBytes = AGENT_PACKAGE_STAGING_MAX_BYTES;
  let stagedImportBytes = 0;
  const stagedReservations = new Map<string, number>();
  const operationReservations = new Map<string, string>();
  const reserveStagedBytes = (reservationId: string, bytes: number): void => {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("invalid staging reservation");
    if (bytes === 0) return;
    if (stagedImportBytes + bytes > maximumStagedImportBytes) {
      throw Object.assign(
        new Error("Agent import staging capacity is currently full"),
        { statusCode: 503 },
      );
    }
    stagedImportBytes += bytes;
    stagedReservations.set(
      reservationId,
      (stagedReservations.get(reservationId) ?? 0) + bytes,
    );
  };
  const releaseStagedReservation = (reservationId: string | undefined): void => {
    if (!reservationId) return;
    const bytes = stagedReservations.get(reservationId);
    if (bytes === undefined) return;
    stagedReservations.delete(reservationId);
    stagedImportBytes = Math.max(0, stagedImportBytes - bytes);
  };
  const cleanupUpload=async(staged:StagedImportUpload):Promise<void>=>{
    // Only parser-created objects reach this helper. Failure retains the byte
    // reservation until observed removal or restart inventory reconciliation.
    try{await fs.unlink(staged.pathname);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    releaseStagedReservation(staged.reservationId);ownedUploads.delete(staged);
  };
  const abandonUpload=async(request:FastifyRequest):Promise<void>=>{
    completedUploadRequests.add(request.raw);
    const staged=pendingUploads.get(request.raw);if(!staged)return;
    pendingUploads.delete(request.raw);
    try{await cleanupUpload(staged);}catch(error){request.log.error({err:error},'Unclaimed Agent upload cleanup remains pending');}
  };
  app.addHook('onResponse',abandonUpload);
  app.addHook('onError',abandonUpload);
  const claimUpload=async(request:FastifyRequest,reply:FastifyReply):Promise<unknown>=>{
    const staged=request.body as StagedImportUpload;
    if(!ownedUploads.has(staged))return reply.code(400).send({error:'An Agent package requires a parser-owned binary upload'});
    pendingUploads.delete(request.raw);
  };
  const sha256File = async (pathname: string): Promise<string> => {
    const hash = createHash("sha256");
    const handle = await fs.open(pathname, "r");
    const buffer = Buffer.allocUnsafe(256 * 1024);
    try {
      for (let offset = 0;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
    } finally {
      await handle.close();
    }
    return hash.digest("hex");
  };
  const withProjectImportLock = async <T>(projectId: string, work: () => Promise<T>): Promise<T> => {
    const previous = projectImportTails.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => current);
    projectImportTails.set(projectId, tail);
    await previous.catch(() => undefined);
    try { return await work(); } finally {
      release();
      if (projectImportTails.get(projectId) === tail) projectImportTails.delete(projectId);
    }
  };
  const requestOperationKey = (projectId: string, requestId: string) =>
    `${projectId}:${requestId}`;
  const validIdempotencyKey = (value: string | undefined): string | undefined => {
    const key = value?.trim();
    return key && /^[A-Za-z0-9_-]{8,128}$/u.test(key) ? key : undefined;
  };
  const operationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  const importPhases = new Set<AgentImportPhase>([
    "queued", "creating_records", "importing_agents", "importing_history",
    "importing_artifacts", "finalizing", "completed", "failed",
  ]);
  const validatedOperation = (value: unknown, expectedId: string): AgentImportOperationDto => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("operation record must be an object");
    }
    const operation = value as Partial<AgentImportOperationDto>;
    if (operation.id !== expectedId || !operationIdPattern.test(operation.id) ||
        typeof operation.requestId !== "string" || !validIdempotencyKey(operation.requestId) ||
        typeof operation.payloadHash !== "string" || !/^[0-9a-f]{64}$/u.test(operation.payloadHash) ||
        typeof operation.projectId !== "string" || !operation.projectId || operation.projectId.length > 200 ||
        typeof operation.conversationId!=='string'||!operation.conversationId||operation.conversationId.length>200||
        (operation.product!=='dev'&&operation.product!=='branches')||
        typeof operation.sourceLabel !== "string" || operation.sourceLabel.length > 240 ||
        typeof operation.phase !== "string" || !importPhases.has(operation.phase as AgentImportPhase) ||
        !["pending", "completed", "failed"].includes(operation.status ?? "") ||
        typeof operation.createdAt !== "string" || operation.createdAt.length > 100 ||
        typeof operation.updatedAt !== "string" || operation.updatedAt.length > 100 ||
        (operation.error !== undefined && (typeof operation.error !== "string" || operation.error.length > 1_000)) ||
        (operation.result !== undefined && (
          !operation.result || typeof operation.result !== "object" ||
          typeof operation.result.rootAgentId !== "string" || !operation.result.rootAgentId ||
          operation.result.rootAgentId.length > 200 ||
          !Array.isArray(operation.result.agentIds) ||
          operation.result.agentIds.length > AGENT_PACKAGE_MAX_AGENTS ||
          operation.result.agentIds.some((id) => typeof id !== "string" || !id || id.length > 200)
        ))) {
      throw new Error("operation record fields are invalid or do not match its filename");
    }
    return operation as AgentImportOperationDto;
  };
  const quarantineOperation = async (id: string, error: unknown): Promise<void> => {
    quarantinedOperationIds.add(id);
    const source = operationPath(id);
    let destination = `${source}.corrupt`;
    try {
      await fs.access(destination);
      destination = `${source}.corrupt.${randomUUID()}`;
    } catch { /* the stable quarantine name is available */ }
    try {
      await fs.rename(source, destination);
      if (process.platform !== "win32") {
        const directory = await fs.open(importOperationDirectory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } catch (renameError) {
      if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") {
        error = new AggregateError([error, renameError], "Import journal quarantine failed");
      }
    }
    try {
      createOperationalNotification({
        dedupeKey: `agent-import-corrupt:${id}`,
        category: "system",
        severity: "urgent",
        title: "Agent import recovery needs attention",
        body: `Import operation ${id} was quarantined; its payload was preserved. ${
          error instanceof Error ? error.message : String(error)
        }`.slice(0, 1_000),
      });
    } catch { /* quarantine and payload preservation remain authoritative */ }
  };
  const writeOperation = async (operation: AgentImportOperationDto): Promise<void> => {
    await fs.mkdir(importOperationDirectory, { recursive: true });
    const finalPath = operationPath(operation.id);
    const previous = await fs.readFile(finalPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    const temporary = `${finalPath}.${randomUUID()}.tmp`;
    let installed = false;
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(operation));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, finalPath);
      installed = true;
      if (process.platform !== "win32") {
        const directory = await fs.open(importOperationDirectory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      if (installed) {
        try {
          if (previous) {
            const rollback = `${finalPath}.${randomUUID()}.tmp`;
            const handle = await fs.open(rollback, "wx", 0o600);
            try {
              await handle.writeFile(previous);
              await handle.sync();
            } finally {
              await handle.close();
            }
            await fs.rename(rollback, finalPath);
          } else {
            await fs.unlink(finalPath);
          }
          if (process.platform !== "win32") {
            const directory = await fs.open(importOperationDirectory, "r");
            try { await directory.sync(); } finally { await directory.close(); }
          }
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Import operation durability and rollback both failed");
        }
      }
      throw error;
    }
    operationCache.set(operation.id, operation);
    operationByRequest.set(
      requestOperationKey(operation.projectId, operation.requestId),
      operation.id,
    );
  };
  const readOperation = async (id: string): Promise<AgentImportOperationDto | undefined> => {
    if (!operationIdPattern.test(id)) return undefined;
    try {
      return validatedOperation(JSON.parse(await fs.readFile(operationPath(id), "utf8")), id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      await quarantineOperation(id, error);
      return undefined;
    }
  };
  const discovery=lifecycleDiscovery({db:store.sqlite,dataDir:context.dataDir,validateImport:validatedOperation,owner:context.custodyOwner,readRetirement:(id,group)=>group?coordinationV3.readCoordinationDestinationGroupRetirement(id):coordinationV3.readCoordinationDestinationRetirement(id)});
  for(const [route,read] of [['agent-imports',discovery.imports],['destinations',discovery.destinations],['checkpoint-captures',discovery.captures],['checkpoint-capture-groups',discovery.groupCaptures]] as const){
    app.get<{Querystring:import('@ponderosa/core').LifecycleDiscoveryQuery}>(`/api/lifecycle/${route}`,(request,reply)=>{
      try{return read(request.query);}catch(error){return reply.code(409).send({error:error instanceof SyntaxError?'Invalid retained lifecycle metadata; evidence remains held':(error as Error).message});}
    });
  }
  const importLifecyclePath=(id:string)=>{if(!operationIdPattern.test(id))throw Error('Invalid import identity');return path.join(importOperationDirectory,`${id}.lifecycle.json`);};
  const writeLifecycle=(file:string,value:unknown)=>{
    const temporary=`${file}.${randomUUID()}.tmp`,fd=syncFs.openSync(temporary,'wx',0o600);
    try{syncFs.writeFileSync(fd,stableJson(value));syncFs.fsyncSync(fd);}finally{syncFs.closeSync(fd);}syncFs.renameSync(temporary,file);
    if(process.platform!=='win32'){const fd=syncFs.openSync(path.dirname(file),'r');try{syncFs.fsyncSync(fd);}finally{syncFs.closeSync(fd);}}
  };
  const importLifecycleReview=async(id:string)=>{
    await operationHydration;const operation=await readOperation(id);if(!operation)throw Error('Import operation unavailable; corrupt evidence remains quarantined');
    const creation=store.findAgentCreationOperation({projectId:operation.projectId,actorScope:'user:local-operator',kind:'import',idempotencyKey:operation.requestId});
    const references=creation?custodyLifecycleProof(store.sqlite,undefined,creation.id).references:[];
    const blockers=[...(operation.status==='completed'||operation.result?['Committed import must retain its canonical owner receipt']:[]),...references.map(ref=>`Canonical reference: ${ref}`),...(creation&&(creation.status!=='preparing'||creation.agentIds.length||creation.artifactIds.length||creation.result)?['Import has actual/reserved effects; canonical owner reconciliation required']:[])];
    const reviewSha256=createHash('sha256').update(stableJson({operation,creation,references})).digest('hex');
    return {operation,creation,dto:{operationId:id,...(creation?{creationOperationId:creation.id}:{}),canRetireMutationFree:!blockers.length,blockers,reviewSha256} as import('@ponderosa/core').AgentImportLifecycleReview};
  };
  app.get<{Params:{id:string}}>('/api/lifecycle/agent-imports/:id',async(request,reply)=>{
    try{return (await importLifecycleReview(request.params.id)).dto;}catch(error){return reply.code(409).send({error:(error as Error).message});}
  });
  app.get<{Querystring:import('@ponderosa/core').LifecycleDiscoveryQuery}>('/api/lifecycle/agent-imports/orphan-evidence',async(request,reply)=>{
    try{await operationHydration;return await retainedOrphanDiscovery(path.join(importOperationDirectory,'retained-orphans'),request.query);}
    catch(error){return reply.code(409).send({error:(error as Error).message});}
  });
  app.post<{Params:{id:string};Body:import('@ponderosa/core').AgentImportLifecycleReconcileInput}>('/api/lifecycle/agent-imports/:id/reconcile',(request,reply)=>withAgentImportAdmission(async()=>{
    try{
      const input=validatedObject(request.body,'Import lifecycle reconciliation');exactObjectFields(input,['commandKey','reviewSha256','action','note'],'Import lifecycle reconciliation');
      if(typeof input.commandKey!=='string'||!input.commandKey||input.commandKey.length>256||typeof input.note!=='string'||input.note.length<8||input.note.length>4096||!['preserve_unresolved','retire_mutation_free'].includes(String(input.action)))throw Error('Exact operator reconciliation command and note required');
      const file=importLifecyclePath(request.params.id);
      if(syncFs.existsSync(file)){const saved=JSON.parse(syncFs.readFileSync(file,'utf8'));if(stableJson(saved.input)!==stableJson(input))throw Error('Import lifecycle command conflict');if(saved.receipt.state==='retired'){const operation=await readOperation(request.params.id);if(operation?.status==='pending')await writeOperation({...operation,status:'failed',phase:'failed',error:'Operator retired mutation-free import; original upload evidence retained',updatedAt:new Date().toISOString()});}return saved.receipt as import('@ponderosa/core').AgentImportLifecycleReceipt;}
      const review=await importLifecycleReview(request.params.id);
      if(review.dto.reviewSha256!==input.reviewSha256)throw Error('Import custody changed; review again');
      if(review.operation.status==='completed'||review.operation.result)throw Error('Committed import ownership cannot be replaced by an unresolved hold');
      if(input.action==='retire_mutation_free'&&!review.dto.canRetireMutationFree)throw Error('Only proved mutation-free unreferenced imports may retire');
      const receipt:import('@ponderosa/core').AgentImportLifecycleReceipt={version:1,operationId:request.params.id,commandKey:input.commandKey,reviewSha256:review.dto.reviewSha256,state:input.action==='retire_mutation_free'?'retired':'preserved_unresolved',operatorId:'local-operator'};
      store.sqlite.transaction(()=>{
        const actual=review.creation?store.getAgentCreationOperation(review.creation.id):undefined;
        if(stableJson(actual)!==stableJson(review.creation))throw Error('Import effects changed; review again');
        if(input.action==='retire_mutation_free'&&actual&&custodyLifecycleProof(store.sqlite,undefined,actual.id).references.length)throw Error('Import acquired a canonical reference; owner retirement required');
        if(input.action==='retire_mutation_free'&&actual)store.updateAgentCreationOperation(actual.id,{status:'rolled_back',lastError:'Operator retired proved mutation-free import'});
        // This durable hold is checked before every background import attempt and survives owner deletion.
        writeLifecycle(file,{input,receipt,operation:review.operation,creation:review.creation});
      }).immediate();
      if(receipt.state==='retired')await writeOperation({...review.operation,status:'failed',phase:'failed',error:'Operator retired mutation-free import; original upload evidence retained',updatedAt:new Date().toISOString()});
      return receipt;
    }catch(error){return reply.code(409).send({error:(error as Error).message});}
  }));
  const operationHydration = fs.mkdir(importOperationDirectory, { recursive: true })
    .then(async () => {
      const names = await fs.readdir(importOperationDirectory);
      for (const name of names) {
        const match = /^([0-9a-f-]{36})\.json\.corrupt(?:\..+)?$/u.exec(name);
        if (match && operationIdPattern.test(match[1]!)) quarantinedOperationIds.add(match[1]!);
      }
      for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
        const operation = await readOperation(name.slice(0, -5));
        if (!operation) continue;
        operationCache.set(operation.id, operation);
        operationByRequest.set(
          requestOperationKey(operation.projectId, operation.requestId),
          operation.id,
        );
      }
      const durableIds = new Set(operationCache.keys());
      let cleaned = false;
      for (const name of names) {
        const payloadMatch = /^([0-9a-f-]{36})\.payload$/u.exec(name);
        const copyMatch = /^(agent-create-[0-9a-f]{64})\.copy\.payload$/u.exec(name);
        const temporary = name.endsWith(".tmp");
        const abandonedUpload = name.startsWith(".incoming-");
        const liveCopy = copyMatch
          ? store.getAgentCreationOperation(copyMatch[1]!)
          : undefined;
        if (!temporary && !abandonedUpload && (
          (payloadMatch && (
            quarantinedOperationIds.has(payloadMatch[1]!) ||
            (durableIds.has(payloadMatch[1]!) &&
              operationCache.get(payloadMatch[1]!)?.status === "pending")
          )) ||
          (copyMatch && liveCopy && liveCopy.status !== "completed") ||
          (!payloadMatch && !copyMatch)
        )) continue;
        // Abandoned uploads/copy payloads can be the last private originals. Preserve them.
        const orphanStat=await fs.lstat(path.join(importOperationDirectory,name)).catch(()=>undefined);
        if(!orphanStat?.isFile()||orphanStat.isSymbolicLink()||orphanStat.nlink!==1)continue;
        const evidence=path.join(importOperationDirectory,'retained-orphans');
        await fs.mkdir(evidence,{recursive:true,mode:0o700});
        await fs.rename(path.join(importOperationDirectory,name),path.join(evidence,`${randomUUID()}-${name}`)).then(()=>{cleaned=true;}).catch(()=>undefined);
        if(process.platform!=='win32'){const fd=await fs.open(evidence,'r');try{await fd.sync();}finally{await fd.close();}}
      }
      if (cleaned && process.platform !== "win32") {
        const directory = await fs.open(importOperationDirectory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
      // Pending payloads consume the same bounded staging budget after a
      // restart. Admission is initialized before new uploads are accepted.
      for (const name of await fs.readdir(importOperationDirectory)) {
        if (!name.endsWith(".payload") && !name.endsWith(".tmp") && !name.startsWith(".incoming-")) continue;
        const stat = await fs.stat(path.join(importOperationDirectory, name)).catch(() => undefined);
        if (!stat?.isFile()) continue;
        const id = name.slice(0, -".payload".length);
        const reservationId = `retained:${id}`;
        // Retained/quarantined data is never discarded to make space. Existing
        // bytes above capacity block new admission until recovery releases them.
        stagedImportBytes += stat.size;
        stagedReservations.set(reservationId, stat.size);
        if (name.endsWith(".payload")) operationReservations.set(id, reservationId);
      }
      const orphanDirectory=path.join(importOperationDirectory,'retained-orphans');
      for(const name of await fs.readdir(orphanDirectory).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;})){
        const stat=await fs.lstat(path.join(orphanDirectory,name));if(!stat.isFile()||stat.isSymbolicLink())continue;
        stagedImportBytes+=stat.size;stagedReservations.set(`orphan:${name}`,stat.size);
      }
    });
  const stagedImportParser = (jsonEnvelope = false): FastifyContentTypeParser => (request, payload, done) => {
      void (async () => {
        const allowedRoutes = jsonEnvelope ? ['/api/projects/:id/import-agents'] : ['/api/projects/:id/agent-import-operations','/api/projects/:id/import-agent-package','/api/projects/:id/agent-role-preview','/api/projects/:id/agent-access-preview'];
        if(request.method!=='POST'||!allowedRoutes.includes(request.routeOptions.url??''))throw Object.assign(new Error('Agent package media is only accepted by upload routes'),{statusCode:415});
        await operationHydration;
        await fs.mkdir(importOperationDirectory, { recursive: true });
        const pathname = path.join(importOperationDirectory, `.incoming-${randomUUID()}`);
        const reservationId = `upload:${randomUUID()}`;
        const handle = await fs.open(pathname, "wx", 0o600);
        const hash = createHash("sha256");
        let size = 0;
        let metadataBytes: number | undefined;
        let headerBytes = 0;
        const headerParts:Buffer[]=[];
        let metadata:StagedImportUpload['metadata']|undefined;
        try {
          for await (const chunk of payload) {
            if(completedUploadRequests.has(request.raw))throw new Error('Agent upload request already completed');
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            if (!jsonEnvelope && metadataBytes === undefined) {
              const separator = bytes.indexOf(0x0a);
              if (separator >= 0) metadataBytes = headerBytes + separator + 1;
              else headerBytes += bytes.length;
              if ((metadataBytes ?? headerBytes) > AGENT_PACKAGE_METADATA_MAX_BYTES + 1) {
                throw Object.assign(new Error("Agent package upload metadata is invalid"), { statusCode: 400 });
              }
              headerParts.push(Buffer.from(bytes.subarray(0,separator<0?bytes.length:separator)));
              if(separator>=0){
                const value=validatedObject(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(headerParts))),'Agent upload metadata');
                exactObjectFields(value,['conversationId','engineMapping','acknowledgeElevatedManagementPermissions','chatInstructionsResolution','outputRoleReviewId','accessSettingsResolution','workingCopyMode','workingFilesDestination','workingRootDestinations','workingFilesActivation','reviewedUserDataActivation','reviewedMetadataActivation'],'Agent upload metadata');
                const projectId=(request.params as {id:string}).id,destination=typeof value.conversationId==='string'?store.getConversation(value.conversationId):undefined;
                if(!destination||destination.projectId!==projectId||!resourceInProduct(store,'conversation',destination.id,requestProduct(request)))throw Object.assign(new Error('The destination Chat is unavailable in this product'),{statusCode:404});
                metadata=value as unknown as StagedImportUpload['metadata'];
              }
            }
            if (jsonEnvelope ? size > maximumJsonImportBytes : size - (metadataBytes ?? headerBytes) > AGENT_PACKAGE_MAX_BYTES) {
              throw Object.assign(new Error(`Agent package exceeds ${AGENT_PACKAGE_LIMIT_LABEL}`), { statusCode: 413 });
            }
            reserveStagedBytes(reservationId, bytes.length);
            hash.update(bytes);
            await handle.write(bytes);
          }
          if((!jsonEnvelope&&!metadata)||completedUploadRequests.has(request.raw))throw Object.assign(new Error('Agent upload metadata is unavailable'),{statusCode:400});
          await handle.sync();
          await handle.close();
          if(completedUploadRequests.has(request.raw))throw new Error('Agent upload request already completed');
          const staged:StagedImportUpload={
            pathname,
            sha256: hash.digest("hex"),
            size,
            reservationId,
            metadata,
          };
          ownedUploads.add(staged);pendingUploads.set(request.raw,staged);
          done(null,staged);
        } catch (error) {
          await handle.close().catch(() => undefined);
          // This pathname was allocated by this parser. Retain its byte charge
          // if removal fails, just as handler-owned staged uploads do.
          try {
            await fs.unlink(pathname);
            releaseStagedReservation(reservationId);
          } catch (cleanupError) {
            if ((cleanupError as NodeJS.ErrnoException).code === 'ENOENT') releaseStagedReservation(reservationId);
            else request.log.error({ err: cleanupError }, 'Rejected Agent upload cleanup remains pending');
          }
          request.log.warn({ err: error }, "Agent package upload was rejected before admission");
          done(error as Error);
        }
      })().catch((error) => done(error as Error));
    };
  app.addContentTypeParser(blobImportContentType, stagedImportParser());

  const buildPortablePackage = async (
    agentId: string,
    requestedMode: AgentExportMode,
    organization: boolean,
    selectedWorkingFiles:readonly string[] = [],
    wholeWorkingFolder=false,
    organizationWorkingFolders=false,
    reviewedUserData?:import('@ponderosa/core').ReviewedUserDataSelection,
    gitStorageBindings?:import('@ponderosa/core').GitStorageSelection[],
  ): Promise<AgentPortablePackageDto> => {
    if(!Array.isArray(selectedWorkingFiles)||selectedWorkingFiles.some(item=>typeof item!=='string'))throw new AssetError(400,'Select working files as an array of relative paths');
    if(selectedWorkingFiles.length&&requestedMode==='template')throw new AssetError(400,'Selected working files require a full export');
    if(reviewedUserData){validateReviewedUserDataSelection(reviewedUserData);if(requestedMode==='template'||!wholeWorkingFolder&&!organizationWorkingFolders)throw new AssetError(400,'Git/settings review data requires full export and explicit working-folder selection');}
    const root = store.getAgent(agentId);
    if (!root || store.agentCreationPending(agentId)) throw new AssetError(404, "agent not found");
    // Context packages were an early V3.3 spelling of a full portable Agent.
    const mode: AgentExportMode = requestedMode === "context" ? "full" : requestedMode;
    const nodes = organization
      ? store.listAgentSubtree(root.id)
      : [root];
    if (nodes.length > AGENT_PACKAGE_MAX_AGENTS) {
      throw new AssetError(413, `Agent package contains ${nodes.length} Agents; the limit is ${AGENT_PACKAGE_MAX_AGENTS}`);
    }
    if (nodes.some((agent) => store.agentCreationPending(agent.id))) {
      throw new AssetError(409, "Agent creation is still being recovered");
    }
    if(organizationWorkingFolders&&mode!=='full')throw new AssetError(400,'Organization folders require a full export');
    const workingRoots=new Map<string,string>(),exportedRoots=new Set<string>();
    const rootHandles:Array<{pathname:string;handle?:Awaited<ReturnType<typeof fs.open>>;device:bigint;inode:bigint;owner:bigint}>=[];
    const ownedRootHandles:Array<Awaited<ReturnType<typeof fs.open>>>=[];
    let captureError:unknown;
    let gitCapture:GitExportCapture|undefined;
    try {
    // Allocate every final root ref before any association reads.
    const physicalRoots=new Map<string,{ref:string;pathname:string}>();
    if(organizationWorkingFolders)for(const agent of nodes){
      const pathname=path.resolve(agent.workingCopy.rootPath);
      if(workingRoots.has(pathname))continue;
      const handle=process.platform==='win32'?undefined:await fs.open(pathname,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      if(handle)ownedRootHandles.push(handle);
      const held=handle?await handle.stat({bigint:true}):await fs.lstat(pathname,{bigint:true}),named=await fs.lstat(pathname,{bigint:true});
      if(!held.isDirectory()||held.dev!==named.dev||held.ino!==named.ino||await fs.realpath(pathname)!==pathname)throw new Error('Selected working root must be canonical and held');
      const physical=`${held.dev}:${held.ino}`,prior=physicalRoots.get(physical);
      if(prior&&prior.pathname!==pathname)throw new Error('Physical working-root aliases require mount/view equivalence proof; inode equality alone is insufficient');
      const ref=prior?.ref??randomUUID();
      physicalRoots.set(physical,{ref,pathname});workingRoots.set(pathname,ref);
      rootHandles.push({pathname,handle,device:held.dev,inode:held.ino,owner:held.uid});
    }
    const verifySelectedRoots=async()=>{
      if(gitStorageBindings!==undefined){const current=store.listAgentSubtree(root.id);if(current.length!==nodes.length||current.some(agent=>!nodes.some(selected=>selected.id===agent.id)))throw new Error('Selected organization membership changed during capture');}
      for(const agent of organizationWorkingFolders?nodes:[]){
        const current=store.getAgent(agent.id);
        if(!current||current.projectId!==agent.projectId||current.conversationId!==agent.conversationId||current.managerAgentId!==agent.managerAgentId||current.workingCopy.mode!==agent.workingCopy.mode||path.resolve(current.workingCopy.rootPath)!==path.resolve(agent.workingCopy.rootPath)||store.agentCreationPending(agent.id)||deletingAgentIds.has(agent.id)||deletingConversationIds.has(agent.conversationId)||deletingProjectIds.has(agent.projectId))throw new Error('Selected source membership or registered working root changed');
      }
      for(const root of rootHandles){
        const held=root.handle?await root.handle.stat({bigint:true}):await fs.lstat(root.pathname,{bigint:true}),named=await fs.lstat(root.pathname,{bigint:true});
        if(!held.isDirectory()||!named.isDirectory()||held.dev!==root.device||held.ino!==root.inode||held.uid!==root.owner||named.dev!==root.device||named.ino!==root.inode||named.uid!==root.owner||await fs.realpath(root.pathname)!==root.pathname)throw new Error('Selected held working-root identity changed');
      }
    };
    await verifySelectedRoots();
    if(gitStorageBindings!==undefined){
      validateGitStorageSelections(gitStorageBindings);
      if(mode!=='full'||!organization||!organizationWorkingFolders||!reviewedUserData?.git||reviewedUserData.source==='retained_originals')throw new Error('Git storage bindings require one full organization with explicitly selected live whole-folder Git roots');
      const selected=new Map(nodes.map(agent=>[agent.id,agent]));
      const bindings:SelectedGitBinding[]=[];
      for(const binding of gitStorageBindings){
        const worktree=selected.get(binding.worktreeAgentId),storage=selected.get(binding.storageAgentId);
        if(!worktree||!storage)throw new Error('Git storage Agents must both be included in the selected organization');
        const source=rootHandles.find(root=>root.pathname===path.resolve(worktree.workingCopy.rootPath))!,target=rootHandles.find(root=>root.pathname===path.resolve(storage.workingCopy.rootPath))!;
        if(source.owner!==target.owner)throw new Error('Associated Git roots must have the same observed owner');
        bindings.push({id:binding.id,worktreeRootRef:workingRoots.get(source.pathname)!,storageRootRef:workingRoots.get(target.pathname)!,relativePath:binding.relativePath,role:binding.role,worktreePath:source.pathname,storagePath:target.pathname});
      }
      validatePortableGitStorageBindings(bindings.map(({worktreePath,storagePath,...binding})=>binding),new Set(workingRoots.values()));
      gitCapture=createGitExportCapture(rootHandles.map(root=>{
        if(!root.handle)throw new Error('Cross-root capture requires held selected roots');
        return {pathname:root.pathname,ref:workingRoots.get(root.pathname)!,handle:root.handle,owner:root.owner};
      }),bindings);
      await verifyGitExportAssociations(gitCapture);
      await verifySelectedRoots();
    }
    const folderInventories=new Map<string,WorkingFolderInventory>(),hardlinkCapture=organizationWorkingFolders||wholeWorkingFolder?createWorkingHardlinkCapture():undefined;
    const reviewedSelectionForRoot=async(sourceRoot:string)=>{
      if(!gitCapture||!reviewedUserData||await gitCapture.usesGit(sourceRoot))return reviewedUserData;
      return reviewedUserData.harness||reviewedUserData.extendedMetadata||reviewedUserData.persistentNodes?{...reviewedUserData,git:false}:undefined;
    };
    if(organizationWorkingFolders)for(const sourceRoot of workingRoots.keys()){
      folderInventories.set(sourceRoot,await inventoryWorkingFolder(sourceRoot,await reviewedSelectionForRoot(sourceRoot),gitCapture,workingRoots,hardlinkCapture));
    }
    if(!organizationWorkingFolders&&wholeWorkingFolder){
      const sourceRoot=path.resolve(root.workingCopy.rootPath);
      folderInventories.set(sourceRoot,await inventoryWorkingFolder(sourceRoot,await reviewedSelectionForRoot(sourceRoot),gitCapture,new Map([[sourceRoot,root.id]]),hardlinkCapture));
    }
    if(hardlinkCapture)await verifyWorkingHardlinkCapture(hardlinkCapture);
    const included = new Set(nodes.map((agent) => agent.id));
    const chat = store.getConversation(root.conversationId);
    const project = { ...store.getProject(root.projectId)!, label: chat?.title ?? root.title, instructions: chat?.instructions };
    let portableArtifactBytes = 0;
    let retainedArtifactWireBytes = 0;
    const admitArtifact = (artifact: import('@ponderosa/core').PortableArtifactDto) => {
      retainedArtifactWireBytes += agentPackageJsonUtf8Bytes(artifact);
      if (retainedArtifactWireBytes + retainedHistoryBytes > AGENT_PACKAGE_MAX_BYTES) {
        throw new AssetError(413, `Agent package exceeds ${AGENT_PACKAGE_LIMIT_LABEL} of serialized UTF-8 bytes; complete originals were not omitted`);
      }
      return artifact;
    };
    const canonicalCommunications = mode === "template"
      ? []
      : store.readCommunicationEvents(root.projectId);
    const revisionsByEvent=new Map<string,ReturnType<AgentStore['readCommunicationRevisions']>>();
    if(mode!=='template')for(const revision of store.readCommunicationRevisions(root.projectId)){
      const revisions=revisionsByEvent.get(revision.targetEventId)??[];revisions.push(revision);revisionsByEvent.set(revision.targetEventId,revisions);
    }
    type ImportedHistory = {
      messages: NonNullable<AgentPortablePackageDto["agents"][number]["history"]>;
      initialInstructions?: string;
      portableState?: {workingFiles?:AgentPortablePackageDto['agents'][number]['workingFiles'];workingFolder?:AgentPortablePackageDto['agents'][number]['workingFolder']};
    };
    const importedHistories = new Map<string, ImportedHistory>();
    let retainedImportedBytes = 0;
    for (const agent of nodes) {
      const pathname = importedAgentHistoryPath(context.dataDir, agent.projectId, agent.id);
      try {
        await fs.access(pathname);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const { portable } = await parsePortablePackageFile(pathname, { packageOnly: true });
      const imported = portable as unknown as ImportedHistory;
      // Bound the total retained text while loading, rather than loading up to
      // 10,000 separately admitted archives before the export can be refused.
      // These values are a lower bound of the eventual package's JSON bytes.
      const messages = mode === "template" ? [] : imported.messages;
      const importedInstructions = imported.initialInstructions;
      if (mode !== "template") retainedImportedBytes += agentPackageJsonUtf8Bytes(messages);
      if (importedInstructions !== undefined) retainedImportedBytes += agentPackageJsonUtf8Bytes(importedInstructions);
      if (retainedImportedBytes > AGENT_PACKAGE_MAX_BYTES) throw new AssetError(413, `Agent package exceeds ${AGENT_PACKAGE_LIMIT_LABEL} (${retainedImportedBytes} serialized UTF-8 bytes)`);
      importedHistories.set(agent.id, { messages, ...(imported.portableState?{portableState:imported.portableState}:{}), ...(importedInstructions !== undefined ? { initialInstructions: importedInstructions } : {}) });
    }
    const histories = new Map<string, ImportedHistory["messages"]>();
    let retainedHistoryBytes = 0;
    for (const [index, agent] of (mode === "template" ? [] : nodes).entries()) {
      const history:ImportedHistory["messages"] = [
        ...(importedHistories.get(agent.id)?.messages ?? []),
        ...agentMessages(agent.id).map((message) => ({
          role: message.role,
          text: message.text,
          createdAt: message.createdAt,
        })),
      ];
      for (const event of canonicalCommunications) {
        if (!portableCommunicationVisible(event,agent)) continue;
        if (history.some(message=>message.communication?.eventId===event.eventId)) continue;
        // Replace the flattened projection once; preserve genuine repeated authored messages.
        const flattened=history.findIndex(message=>!message.communication && message.text===event.text && message.createdAt===event.createdAt);
        const message=portableCommunicationMessage(event);
        const revisions=revisionsByEvent.get(event.eventId)??[];
        if(revisions.length)message.communicationRevisions=withoutPortableSecrets(revisions) as typeof revisions;
        if(flattened<0)history.push(message);else history[flattened]=message;
      }
      retainedHistoryBytes += agentPackageJsonUtf8Bytes(history);
      if (retainedHistoryBytes > AGENT_PACKAGE_MAX_BYTES) throw new AssetError(413, `Agent package exceeds ${AGENT_PACKAGE_LIMIT_LABEL} (${retainedHistoryBytes} serialized UTF-8 bytes)`);
      histories.set(agent.id, history);
      if (index % 32 === 0) await yieldToLoop();
    }
    const projectArtifacts = mode === "template"
      ? []
      : store.getProjectArtifacts(root.projectId);
    const artifactOwner = new Map<string, string>();
    if (mode !== "template") {
      for (const [artifactIndex, artifact] of projectArtifacts.entries()) {
        if (artifactIndex % 128 === 0) await yieldToLoop();
        if (artifact.origin?.kind === "operator") continue;
        if (artifact.originAgentId && included.has(artifact.originAgentId)) {
          artifactOwner.set(artifact.id, artifact.originAgentId);
          continue;
        }
        const referencingAgent = nodes.find((agent) =>
          (histories.get(agent.id) ?? []).some((message) =>
            message.text.includes(artifact.id)||Object.values(message.artifactRefs??{}).includes(artifact.id)||message.attachmentRefs?.includes(artifact.id)||message.communication?.artifactIds?.includes(artifact.id)||message.communication?.document?.artifactId===artifact.id||importedHistories.get(agent.id)?.portableState?.workingFiles?.some(file=>file.artifactRef===artifact.id)));
        if (referencingAgent) artifactOwner.set(artifact.id, referencingAgent.id);
      }
    }
    const agents: AgentPortablePackageDto["agents"] = [];
    const artifactsByOwner = new Map<string, typeof projectArtifacts>();
    for (const artifact of projectArtifacts) {
      const owner = artifactOwner.get(artifact.id);
      if (!owner) continue;
      const owned = artifactsByOwner.get(owner) ?? [];
      owned.push(artifact);
      artifactsByOwner.set(owner, owned);
    }
    let retainedAgentBytes = 0;
    for (const agent of nodes) {
      const history = histories.get(agent.id) ?? [];
      const selectedArtifacts = mode === "template"
        ? []
        : artifactsByOwner.get(agent.id) ?? [];
      const artifacts: NonNullable<AgentPortablePackageDto["agents"][number]["artifacts"]> = [];
      const pendingArtifacts: Array<{
        artifact: typeof selectedArtifacts[number];
        identity: { size: number; sha256: string };
      }> = [];
      let reservedArtifactBytes = portableArtifactBytes;
      const flushArtifacts = async (): Promise<void> => {
        if (pendingArtifacts.length === 0) return;
        const batch = pendingArtifacts.splice(0);
        const bodies = await readManagedArtifactContentsAsync(
          context.dataDir,
          agent.projectId,
          batch.map(({ artifact, identity }) => ({
            artifactId: artifact.id,
            expectedSize: identity.size,
            expectedSha256: identity.sha256,
          })),
        );
        for (const [index, { artifact }] of batch.entries()) {
          const data = bodies[index];
          if (!data) {
            throw new AssetError(409, `artifact ${artifact.id} content is unavailable or changed`);
          }
          artifacts.push(admitArtifact({
            ref: artifact.id,
            kind: artifact.kind,
            path: artifact.path,
            ...(artifact.summary ? { summary: artifact.summary } : {}),
            createdAt: artifact.createdAt,
            ...(artifact.mediaType ? { mediaType: artifact.mediaType } : {}),
            ...(artifact.visibility ? { visibility: artifact.visibility } : {}),
            ...(artifact.pinned !== undefined ? { pinned: artifact.pinned } : {}),
            ...(artifact.sourcePath ? { sourcePath: artifact.sourcePath } : {}),
            ...await encodePortableArtifactData(data),
          }));
        }
      };
      for (const artifact of selectedArtifacts) {
        const runtimeArtifact = coordinationV3.runtimeArtifact(artifact.id);
        const runtimeIdentity = runtimeArtifact?.projectId === agent.projectId &&
          assets.authoritativeRuntimeArtifactMetadata(
            agent.projectId,
            runtimeArtifact,
          )
          ? {
              size: runtimeArtifact.byteLength,
              sha256: runtimeArtifact.blobHash,
            }
          : undefined;
        const generatedIdentity =
          artifact.kind === "generated_file" &&
          assets.authoritativeGeneratedArtifactMetadata(
            agent.projectId,
            artifact,
          ) &&
          artifact.size &&
          artifact.sha256
            ? { size: artifact.size, sha256: artifact.sha256 }
            : undefined;
        const fallbackIdentity =
          !runtimeIdentity && !generatedIdentity &&
          artifact.size && artifact.sha256
            ? { size: artifact.size, sha256: artifact.sha256 }
            : undefined;
        const identity =
          runtimeIdentity ?? generatedIdentity ?? fallbackIdentity;
        if (identity && reservedArtifactBytes + identity.size > AGENT_PACKAGE_ARTIFACT_MAX_BYTES) {
          throw new AssetError(
            413,
            `portable Agent package artifacts exceed the ${AGENT_PACKAGE_ARTIFACT_LIMIT_LABEL} export limit`,
          );
        }
        if (!identity) {
          throw new AssetError(409, `artifact ${artifact.id} content is unavailable or changed`);
        }
        reservedArtifactBytes += identity.size;
        pendingArtifacts.push({ artifact, identity });
        if (pendingArtifacts.length >= 128 || pendingArtifacts.reduce((bytes, entry) => bytes + entry.identity.size, 0) >= 16 * 1024 * 1024) await flushArtifacts();
      }
      await flushArtifacts();
      if(mode === "full") {
        const originals=new Map<string,string>();
        for(const message of history) {
          if(!message.communication?.attachments?.length)continue;
          if(message.attachmentRefs?.length===message.communication.attachments.length && message.attachmentRefs.every(ref=>artifacts.some(a=>a.ref===ref)))continue;
          message.attachmentRefs=[];
          for(const attachment of message.communication.attachments) {
            const key=`${attachment.agentId}:${attachment.id}`;
            let ref=originals.get(key);
            if(!ref) {
              const content=await assets.content(agent.projectId,attachment.conversationId??attachment.agentId,attachment.id,false);
              if(!content||content.body.length!==attachment.size||(attachment.sha256&&createHash('sha256').update(content.body).digest('hex')!==attachment.sha256))throw new AssetError(409,`Attachment ${attachment.id} original is unavailable or changed`);
              reservedArtifactBytes+=content.body.length;
              if(reservedArtifactBytes>AGENT_PACKAGE_ARTIFACT_MAX_BYTES)throw new AssetError(413,'Portable attachment originals exceed the artifact byte limit');
              ref=randomUUID();originals.set(key,ref);
              artifacts.push(admitArtifact({ref,kind:'document',path:attachment.name,summary:attachment.name,mediaType:attachment.mediaType,createdAt:attachment.createdAt??message.createdAt??new Date().toISOString(),...await encodePortableArtifactData(content.body)}));
            }
            message.attachmentRefs.push(ref);
          }
        }
      }
      if(mode === "full") {
        const archives=await executionArchives(store,agent.id,AGENT_PACKAGE_ARTIFACT_MAX_BYTES-reservedArtifactBytes);
        for(const archive of archives){reservedArtifactBytes+=portableArtifactByteLength(archive);artifacts.push(admitArtifact(archive));}
      }
      const sourceRoot=path.resolve(agent.workingCopy.rootPath);
      await verifySelectedRoots();
      const firstRoot=organizationWorkingFolders&&!exportedRoots.has(workingRoots.get(sourceRoot)!);
      if(firstRoot)exportedRoots.add(workingRoots.get(sourceRoot)!);
      if(gitCapture?.exclusions(sourceRoot).includes('.')&&reviewedUserData?.harness)throw new Error('Whole-root Git storage cannot also carry harness working-file review; select separate storage and working roots');
      const rootReviewedSelection=await reviewedSelectionForRoot(sourceRoot);
      const folderInventory=firstRoot?folderInventories.get(sourceRoot):!organizationWorkingFolders&&agent.id===root.id&&wholeWorkingFolder?folderInventories.get(sourceRoot):undefined;
      let retainedOriginal:{data:Buffer;mode?:number;mtime?:string}|undefined;
      if(folderInventory&&reviewedUserData?.source==='retained_originals'){
        // Shared-root originals may belong to a peer excluded from this Agent export.
        const owners=store.listAgents(agent.projectId).filter(node=>node.conversationId===agent.conversationId&&path.resolve(node.workingCopy.rootPath)===sourceRoot);
        if(owners.length>AGENT_PACKAGE_MAX_AGENTS)throw new AssetError(413,'Retained original owner inventory exceeds the package bound');
        const bindings:NonNullable<AgentPortablePackageDto['agents'][number]['workingFiles']>=[];
        for(const owner of owners){
          let imported=importedHistories.get(owner.id);
          if(!imported){
            const pathname=importedAgentHistoryPath(context.dataDir,owner.projectId,owner.id);
            try{const parsed=await parsePortablePackageFile(pathname,{packageOnly:true});imported=parsed.portable as unknown as ImportedHistory;}
            catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
          }
          bindings.push(...(imported.portableState?.workingFiles?.filter(file=>file.path==='.ponderosa-portable-review/user-data.json')??[]));
        }
        if(bindings.length!==1)throw new AssetError(409,'Retained review data needs one unambiguous imported original binding for this working root');
        const binding=bindings[0]!,original=projectArtifacts.find(artifact=>artifact.id===binding.artifactRef);
        if(!original?.size||!original.sha256)throw new AssetError(409,'Retained review original artifact identity is unavailable');
        const [data]=await readManagedArtifactContentsAsync(context.dataDir,agent.projectId,[{artifactId:original.id,expectedSize:original.size,expectedSha256:original.sha256}]);
        if(!data)throw new AssetError(409,'Retained review original artifact is missing or changed');
        retainedOriginal={data,mode:binding.mode,mtime:binding.mtime};
      }
      const selectedPaths=folderInventory?.paths??selectedWorkingFiles;
      const workingFiles=(organizationWorkingFolders?firstRoot:agent.id===root.id)&&(selectedPaths.length||folderInventory)
        ? await exportWorkingFiles(agent.workingCopy.rootPath,selectedPaths,AGENT_PACKAGE_ARTIFACT_MAX_BYTES-reservedArtifactBytes,folderInventory?.links,folderInventory?rootReviewedSelection:undefined,retainedOriginal,gitCapture,workingRoots,folderInventory):undefined;
      if(workingFiles){if(mode!=='full')throw new AssetError(400,'Selected working files require a full export');for(const artifact of workingFiles.artifacts)artifacts.push(admitArtifact(artifact));reservedArtifactBytes+=workingFiles.bytes;}
      portableArtifactBytes = reservedArtifactBytes;
      const initialInstructions = importedHistories.get(agent.id)?.initialInstructions
        ?? agent.role ?? agent.spawnPrompt ?? agent.presetSnapshot?.guidance;
      const portableAgent: AgentPortablePackageDto["agents"][number] = {
        ref: agent.id,
        title: agent.title,
        engine: agent.activeEngine,
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.effort ? { effort: agent.effort } : {}),
        ...(agent.speed !== undefined ? { speed: agent.speed } : {}),
        ...(agent.role !== undefined ? { role: agent.role } : {}),
        ...(agent.presetSnapshot ? { presetSnapshot: agent.presetSnapshot } : {}),
        managementPermissions: agent.managementPermissions,
        workingCopyMode:agent.workingCopy.mode,
        ...(organizationWorkingFolders?{workingRootRef:workingRoots.get(sourceRoot)!}:{}),
        ...(folderInventory?{workingFolder:{cyclicLinks:'passive_in_root',mode:folderInventory.mode,mtime:folderInventory.mtime,directories:folderInventory.directories,excludedPaths:folderInventory.excludedPaths,...(folderInventory.links.length?{links:folderInventory.links}:{})}}:mode==='full'&&importedHistories.get(agent.id)?.portableState?.workingFolder?{workingFolder:importedHistories.get(agent.id)!.portableState!.workingFolder}:{}),
        ...(workingFiles?{workingFiles:workingFiles.files}:mode==='full'&&importedHistories.get(agent.id)?.portableState?.workingFiles?{workingFiles:importedHistories.get(agent.id)!.portableState!.workingFiles}:{}),
        sourceChat:{ref:agent.conversationId,title:store.getConversation(agent.conversationId)?.title??agent.conversationId},
        accessSettings:{restrictedCapabilityIds:new CapabilityPolicyStore(store.sqlite).resolveForAgent(agent.id).restrictedCapabilityIds,
          ...(localMemoryFor(app)?{readGlobalMemory:localMemoryFor(app)!.getGrant(agent.conversationId,store.getConversation(agent.conversationId)?.branchId?'branches':'dev').readGlobal}:{}),
          ...context.portableBrowserSettings?.(agent)},
        ...(initialInstructions !== undefined ? { initialInstructions } : {}),
        ...(agent.managerAgentId && included.has(agent.managerAgentId)
          ? { managerRef: agent.managerAgentId }
          : {}),
        ...(mode !== "template" ? { history } : {}),
        ...(artifacts.length ? { artifacts } : {}),
      };
      retainedAgentBytes += agentPackageJsonUtf8Bytes(portableAgent);
      if (retainedAgentBytes > AGENT_PACKAGE_MAX_BYTES) throw new AssetError(413, `Agent package exceeds ${AGENT_PACKAGE_LIMIT_LABEL} (${retainedAgentBytes} serialized UTF-8 bytes)`);
      agents.push(portableAgent);
      await yieldToLoop();
    }
    const portable: AgentPortablePackageDto = {
      schema: "ponderosa.agent-package.v1",
      mode,
      kind: nodes.length === 1 ? "agent" : "organization",
      exportedAt: new Date().toISOString(),
      sourceLabel: `${project.label} / ${root.title}`,
      ...(mode === "full" && project.instructions
        ? { sourceProjectInstructions: project.instructions }
        : {}),
      rootRef: root.id,
      agents,
    };
    if(mode==='full'&&localMemoryFor(app)){
      const groups=new Map<string,string[]>();for(const agent of nodes){if(!agent.conversationId)throw new Error('Package memory Agent has no Chat');const ids=groups.get(agent.conversationId)??[];ids.push(agent.id);groups.set(agent.conversationId,ids);}
      if(groups.size>1)throw new Error('Cross-Chat memory exports require separate packages and destination Chats');
      portable.memory=[];
      for(const [chatId,ids] of groups)portable.memory.push({snapshot:await localMemoryFor(app)!.exportPackageMemory(chatId,ids),agentRefs:Object.fromEntries(ids.map(id=>[id,id]))});
    }
    const roles=outputApps?.portableRoles([...included]);if(roles?.length)portable.outputRoles=roles;
    for(const node of agents)for(const message of node.history??[]){
      const refs=[...(message.communication?.artifactIds??[]),...(message.communication?.document?[message.communication.document.artifactId]:[])];
      for(const ref of refs){if(message.artifactRefs?.[ref])continue;if(!agents.some(owner=>owner.artifacts?.some(a=>a.ref===ref)))throw new AssetError(409,`Authored Communication artifact ${ref} is unavailable`);message.artifactRefs={...message.artifactRefs,[ref]:ref};}
    }
    await verifySelectedRoots();
    if(gitCapture){
      portable.gitStorageBindings=gitCapture.portableBindings();
      validatePortableGitStorageBindings(portable.gitStorageBindings,new Set(workingRoots.values()));
      validatePortableAgentPackage(portable);
      await verifyGitExportAssociations(gitCapture);await verifySelectedRoots();
    }
    if(portable.agents.some(node=>node.workingFolder?.links?.some(link=>link.targetRootRef)))validateMappedWorkingLinks(portable.agents.filter(node=>node.workingFolder).map(node=>({ref:node.workingRootRef??node.ref,links:node.workingFolder!.links??[],cyclicLinks:node.workingFolder!.cyclicLinks})));
    if(hardlinkCapture)await verifyWorkingHardlinkCapture(hardlinkCapture);
    agentPackageJsonUtf8Bytes(portable);
    return portable;
    }catch(error){captureError=error;throw error;}
    finally{
      // Finish descendant cleanup before releasing the selected root descriptors; retain every failure.
      const descendantCleanup:unknown[]=[];
      if(gitCapture)try{await gitCapture.close(captureError);}catch(error){descendantCleanup.push(error);}
      const closed=await Promise.allSettled(ownedRootHandles.map(handle=>handle.close()));
      const cleanupErrors=[...descendantCleanup,...closed.flatMap(result=>result.status==='rejected'?[result.reason]:[])];
      if(cleanupErrors.length){
        const primary=captureError as {code?:string;observed?:unknown;cleanupErrors?:unknown[]}|undefined;
        throw Object.assign(new Error('Selected-root capture descriptor cleanup failed',{cause:captureError}),{code:primary?.code??'ERR_PORTABLE_ROOT_CAPTURE_CLEANUP',partialStatePossible:false,observed:primary?.observed??null,cleanupErrors:[...(primary?.cleanupErrors??[]),...cleanupErrors]});
      }
    }
  };

  type PreparedCopySnapshot = {
    phase: "prepared_copy";
    snapshotSha256: string;
  };
  const preparedCopySnapshot = (result: unknown): PreparedCopySnapshot | undefined =>
    result && typeof result === "object" &&
    (result as { phase?: unknown }).phase === "prepared_copy" &&
    typeof (result as { snapshotSha256?: unknown }).snapshotSha256 === "string"
      ? result as PreparedCopySnapshot
      : undefined;
  const readCopySnapshot = async (
    operationId: string,
    expectedSha256?: string,
  ): Promise<{ portable: AgentPortablePackageDto; sha256: string } | undefined> => {
    try { await fs.access(copySnapshotPath(operationId)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const sha256 = await sha256File(copySnapshotPath(operationId));
    if (expectedSha256 && sha256 !== expectedSha256) {
      throw new Error("Agent copy snapshot no longer matches its durable operation");
    }
    const { portable } = await parsePortablePackageFile(copySnapshotPath(operationId), { packageOnly: true });
    return { portable, sha256 };
  };
  const installCopySnapshot = async (
    operationId: string,
    portable: AgentPortablePackageDto,
  ): Promise<{ portable: AgentPortablePackageDto; sha256: string }> => {
    const existing = await readCopySnapshot(operationId);
    if (existing) return existing;
    await fs.mkdir(importOperationDirectory, { recursive: true });
    const finalPath = copySnapshotPath(operationId);
    const temporary = `${finalPath}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        for await (const chunk of portablePackageJsonChunks(portable)) {
          const bytes = Buffer.from(chunk, "utf8");
          reserveStagedBytes(`copy:${operationId}`, bytes.length);
          await handle.writeFile(bytes);
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, finalPath);
      if (process.platform !== "win32") {
        const directory = await fs.open(importOperationDirectory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } catch (error) {
      const removed = await fs.unlink(temporary).then(() => true).catch(() => false);
      if (removed) releaseStagedReservation(`copy:${operationId}`);
      throw error;
    }
    operationReservations.set(`${operationId}.copy`, `copy:${operationId}`);
    const installed = await readCopySnapshot(operationId);
    if (!installed) throw new Error("Agent copy snapshot was not durably installed");
    return installed;
  };

  app.get<{Params:{id:string};Querystring:{offset?:string;limit?:string;archiveVersion?:string}}>('/api/agents/:id/imported-communications',async(request,reply)=>{
    const agent=store.getAgent(request.params.id);
    if(!agent||store.agentCreationPending(agent.id)||!resourceInProduct(store,'agent',agent.id,requestProduct(request)))return reply.code(404).send({error:'Agent unavailable'});
    const offset=Number(request.query.offset??0),limit=Number(request.query.limit??10);
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>20)return reply.code(400).send({error:'Use nonnegative offset and limit 1–20'});
    const availability=store.getImportedHistoryAvailability(agent.id);
    if(!availability.archiveVersion)return {source:'',importedAt:'',messages:[],artifacts:[],hasMore:false};
    if(request.query.archiveVersion&&request.query.archiveVersion!==availability.archiveVersion)return reply.code(409).send({error:'Imported history changed; reload from the first page'});
    const {portable:archiveData}=await parsePortablePackageFile(importedAgentHistoryPath(context.dataDir,agent.projectId,agent.id),{packageOnly:true});
    if(!store.getAgent(agent.id)||deletingAgentIds.has(agent.id))return reply.code(404).send({error:'Agent unavailable'});
    if(store.getImportedHistoryAvailability(agent.id).archiveVersion!==availability.archiveVersion)return reply.code(409).send({error:'Imported history changed; reload from the first page'});
    const archive=archiveData as unknown as {source:string;importedAt:string;messages:AgentPortablePackageDto['agents'][number]['history']};
    if(!archive?.messages)return reply.code(404).send({error:'Imported history unavailable'});
    const messages=archive.messages.slice(offset,offset+limit);
    const refs=new Set(messages.flatMap(message=>[...(message.attachmentRefs??[]),...Object.values(message.artifactRefs??{})]));
    const artifacts=[...refs].flatMap(ref=>{
      if(!store.agentCanReadProjectArtifact(agent.projectId,ref,agent.id)||!store.operatorCanReadProjectArtifact(agent.projectId,ref))return [];
      const artifact=store.getProjectArtifact(agent.projectId,ref);
      return artifact?[{...artifact,downloadUrl:`/api/projects/${encodeURIComponent(agent.projectId)}/artifacts/${encodeURIComponent(ref)}/download`}]:[];
    });
    const result={source:archive.source,importedAt:archive.importedAt,archiveVersion:availability.archiveVersion,messages,artifacts,hasMore:offset+messages.length<archive.messages.length,nextOffset:offset+messages.length};
    if(agentPackageJsonUtf8Bytes(result)>2*1024*1024)return reply.code(413).send({error:'History page exceeds 2 MiB; request fewer messages or use bounded history retrieval'});
    return result;
  });

  app.get<{
    Params: { id: string };
    Querystring: {
      mode?: AgentExportMode;
      organization?: string;
      download?: string;
      workingFiles?: string;
      wholeWorkingFolder?: string;
      organizationWorkingFolders?:string;
      reviewedUserData?:string;
      gitStorageBindings?:string;
    };
  }>("/api/agents/:id/export", { onRequest: packageOperation,config:{agentPackageOperation:true} }, async (request, reply) => withAgentImportAdmission(async () => {
    const requestedMode: AgentExportMode = ["template", "context", "full"]
      .includes(request.query.mode ?? "")
      ? request.query.mode!
      : "full";
    let selectedWorkingFiles:unknown=[];
    try{if(request.query.workingFiles)selectedWorkingFiles=JSON.parse(request.query.workingFiles);}catch{throw new AssetError(400,'Selected working files must be a JSON array');}
    if(!Array.isArray(selectedWorkingFiles)||selectedWorkingFiles.some(item=>typeof item!=='string'))throw new AssetError(400,'Selected working files must be relative paths');
    let reviewedUserData:import('@ponderosa/core').ReviewedUserDataSelection|undefined;
    if(request.query.reviewedUserData!==undefined){try{const value:unknown=JSON.parse(request.query.reviewedUserData);validateReviewedUserDataSelection(value);reviewedUserData=value;}catch{throw new AssetError(400,'Choose explicit Git/settings review data');}}
    let gitStorageBindings:import('@ponderosa/core').GitStorageSelection[]|undefined;
    if(request.query.gitStorageBindings!==undefined){try{const value:unknown=JSON.parse(request.query.gitStorageBindings);validateGitStorageSelections(value);gitStorageBindings=value;}catch{throw new AssetError(400,'Choose canonical selected-Agent Git storage bindings');}}
    const result = await buildPortablePackage(
      request.params.id,
      requestedMode,
      request.query.organization === "true",
      selectedWorkingFiles as string[],
      request.query.wholeWorkingFolder==='true',
      request.query.organizationWorkingFolders==='true',
      reviewedUserData,
      gitStorageBindings,
    );
    if (result.mode === "full") reply.header("x-ponderosa-export-warning", FULL_PACKAGE_EXPORT_WARNING);
    if (request.query.download === "1") {
      const safeTitle = result.sourceLabel
        .normalize("NFKD")
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-+|-+$/gu, "")
        .toLocaleLowerCase()
        .slice(0, 80);
      reply.header(
        "content-disposition",
        `attachment; filename="${safeTitle || "agent"}-${result.mode}.ponderosa.json"`,
      );
    }
    // Serialize to admitted, owned staging before starting the response so an
    // over-limit export fails honestly; the download then streams with backpressure.
    await operationHydration;
    const reservationId = `export:${randomUUID()}`;
    const pathname = path.join(importOperationDirectory, `.incoming-${randomUUID()}`);
    const handle = await fs.open(pathname, "wx", 0o600);
    try {
      for await (const chunk of portablePackageJsonChunks(result)) {
        const bytes = Buffer.from(chunk, "utf8");
        reserveStagedBytes(reservationId, bytes.length);
        await handle.writeFile(bytes);
      }
      await handle.close();
    } catch (error) {
      await handle.close().catch(() => undefined);
      const removed = await fs.unlink(pathname).then(() => true).catch(() => false);
      if (removed) releaseStagedReservation(reservationId);
      throw error;
    }
    const stream = createReadStream(pathname);
    stream.once("close", () => {
      void fs.unlink(pathname).then(() => releaseStagedReservation(reservationId)).catch(() => undefined);
    });
    reply.raw.once("close", () => stream.destroy());
    return reply.type("application/json; charset=utf-8").send(stream);
  }));

  const validChatInstructionsResolution = (value: unknown): boolean => {
    if (value === undefined) return true;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return Object.keys(record).length === 2 &&
      (record.action === "keep_destination" || record.action === "use_source") &&
      typeof record.expectedDestinationSha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(record.expectedDestinationSha256);
  };

  type RoleResult=ImportAgentPackageResponse&{outputRoleFinalization?:{reviewId:string;binding:string;mapping:Record<string,string>;done?:boolean}};
  const finishRoles=(operationId:string):ImportAgentPackageResponse=>{
    const operation=store.getAgentCreationOperation(operationId)!;const result=operation.result as RoleResult;
    if(operation.agentIds.some(id=>destinationAdmissionHeld(store.sqlite,id)))throw new Error('Output roles remain held until destination admission commits');
    const intent=result.outputRoleFinalization;
    if(intent&&!intent.done){
      if(!outputApps)throw new Error('Output role service unavailable');
      outputApps.finalizeImport(intent.reviewId,intent.binding,operationId,intent.mapping);
      intent.done=true;store.updateAgentCreationOperation(operationId,{result});
      outputApps.finishImport(intent.reviewId);
    }
    return result;
  };
  const importPackage = async (
    projectId: string,
    body: ImportAgentPackageRequest,
    reply: FastifyReply,
    onPhase?: (phase: AgentImportPhase) => Promise<void>,
    creationOperationId?: string,
    creationRequest?: { idempotencyKey: string; rawPayloadHash?: string },
    branchHooks?: BranchImportHooks,
    signal?: AbortSignal,
  ): Promise<unknown> => withProjectImportLock(projectId, async () => {
      signal?.throwIfAborted();
      let importBody: Record<string, unknown>;
      try {
        importBody = validatedObject(body, "Agent import request");
        exactObjectFields(
          importBody,
          ["package", "conversationId", "engineMapping", "acknowledgeElevatedManagementPermissions", "chatInstructionsResolution", "outputRoleReviewId", "accessSettingsResolution", "workingCopyMode", "workingFilesDestination", "workingRootDestinations", "workingFilesActivation", "reviewedUserDataActivation", "reviewedMetadataActivation"],
          "Agent import request",
        );
        if(importBody.workingFilesDestination!==undefined&&(typeof importBody.workingFilesDestination!=='string'||!path.isAbsolute(importBody.workingFilesDestination)))throw new Error('Choose an absolute new working-files destination');
        if (importBody.workingCopyMode!==undefined&&!['shared','separate_git'].includes(String(importBody.workingCopyMode)))throw new Error('Invalid destination working-copy mode');
        if(importBody.reviewedUserDataActivation!==undefined)validateReviewedUserDataActivation(importBody.reviewedUserDataActivation);
        if(importBody.reviewedMetadataActivation!==undefined)validateReviewedMetadataActivation(importBody.reviewedMetadataActivation);
        if(importBody.workingFilesActivation!==undefined){const activation=validatedObject(importBody.workingFilesActivation,'Live working-root activation');exactObjectFields(activation,['sharedRoot'],'Live working-root activation');if(activation.sharedRoot!==undefined&&typeof activation.sharedRoot!=='string')throw new Error('Invalid new Shared root confirmation');}
        if(importBody.accessSettingsResolution!==undefined){const resolution=validatedObject(importBody.accessSettingsResolution,'Access review');exactObjectFields(resolution,['action','reviewSha256','agentActions'],'Access review');if(resolution.agentActions!==undefined){const actions=validatedObject(resolution.agentActions,'Per-Agent access choices');if(Object.values(actions).some(action=>action!=='keep_destination'&&action!=='use_source'))throw new Error('Invalid per-Agent access choice');}if(!['keep_destination','use_source'].includes(String(resolution.action))||typeof resolution.reviewSha256!=='string'||!/^[a-f0-9]{64}$/.test(resolution.reviewSha256))throw new Error('Invalid access review');}
        if (!validChatInstructionsResolution(importBody.chatInstructionsResolution) ||
            typeof importBody.conversationId !== "string" ||
            !importBody.engineMapping || typeof importBody.engineMapping !== "object" ||
            Array.isArray(importBody.engineMapping) ||
            Object.values(importBody.engineMapping as Record<string, unknown>)
              .some((value) => typeof value !== "string") ||
            (importBody.acknowledgeElevatedManagementPermissions !== undefined &&
              typeof importBody.acknowledgeElevatedManagementPermissions !== "boolean")) {
          throw new Error("Agent import request fields are invalid");
        }
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : "invalid Agent import request",
        });
      }
      if (!creationOperationId) {
        if (!creationRequest) throw new Error("Agent import idempotency identity is required");
        const normalizedEngineMapping = Object.fromEntries(
          Object.entries(importBody.engineMapping as Record<string, string>)
            .map(([source, target]) => [source, target.trim()]),
        );
        let payloadHash: string;
        try {
          if (!creationRequest.rawPayloadHash) {
            const { package: portable, ...metadata } = importBody;
            agentPackageJsonUtf8Bytes(portable);
            agentPackageJsonUtf8Bytes(metadata, AGENT_PACKAGE_METADATA_MAX_BYTES);
          }
          payloadHash = creationRequest.rawPayloadHash ?? await portableImportPayloadHash({
            package: importBody.package,
            conversationId: importBody.conversationId,
            engineMapping: normalizedEngineMapping,
            ...(importBody.accessSettingsResolution?{accessSettingsResolution:importBody.accessSettingsResolution}:{}),
            ...(importBody.reviewedUserDataActivation?{reviewedUserDataActivation:importBody.reviewedUserDataActivation}:{}),
            ...(importBody.reviewedMetadataActivation!==undefined?{reviewedMetadataActivation:importBody.reviewedMetadataActivation}:{}),
            ...(importBody.workingFilesActivation?{workingFilesActivation:importBody.workingFilesActivation}:{}),
        ...(importBody.workingRootDestinations?{workingRootDestinations:importBody.workingRootDestinations}:{}),
            ...(importBody.workingFilesDestination?{workingFilesDestination:importBody.workingFilesDestination}:{}),
            ...(importBody.workingCopyMode?{workingCopyMode:importBody.workingCopyMode}:{}),
            ...(importBody.outputRoleReviewId ? {outputRoleReviewId:importBody.outputRoleReviewId} : {}),
            ...(importBody.chatInstructionsResolution ? { chatInstructionsResolution: importBody.chatInstructionsResolution } : {}),
            acknowledgeElevatedManagementPermissions:
              importBody.acknowledgeElevatedManagementPermissions ?? false,
          }, signal);
        } catch (error) {
          return reply.code((error as {statusCode?:number})?.statusCode ?? 400).send({ error: error instanceof Error ? error.message : "invalid Agent import identity" });
        }
        try {
          creationOperationId = store.beginAgentCreationOperation({
            projectId,
            actorScope: "user:local-operator",
            kind: "import",
            idempotencyKey: creationRequest.idempotencyKey,
            payloadHash,
            conversationId: body.conversationId,
          }).operation.id;
        } catch (error) {
          return reply.code(409).send({
            error: error instanceof Error ? error.message : "Agent import replay conflict",
          });
        }
      }
      const durableOperation = store.getAgentCreationOperation(creationOperationId);
      if (!durableOperation) throw new Error("Agent import creation operation is unavailable");
      const backgroundId=operationByRequest.get(requestOperationKey(projectId,durableOperation.idempotencyKey));
      if(backgroundId&&syncFs.existsSync(importLifecyclePath(backgroundId)))return reply.code(409).send({error:'Import is held by an explicit lifecycle reconciliation decision',operationId:backgroundId});
      if (durableOperation.projectId !== projectId || durableOperation.conversationId !== body.conversationId) {
        return reply.code(409).send({error:"Agent import destination does not match its durable owner"});
      }
      if (durableOperation.status === "completed" && durableOperation.result) {
        return reply.code(200).send(finishRoles(durableOperation.id));
      }
      if (durableOperation.status === "canonical_committed" || durableOperation.status === "rolling_back") {
        return reply.code(409).send({
          error: "A prior import attempt is still being recovered; retry after recovery completes",
          operationId: durableOperation.id,
        });
      }
      if (durableOperation.agentIds.length > 0) {
        return reply.code(409).send({
          error: "A prior import attempt is still being recovered; retry after recovery completes",
          operationId: durableOperation.id,
        });
      }
      const abandonMutationFreeOperation = (reason: string) => {
        const current = store.getAgentCreationOperation(durableOperation.id);
        if (!current || current.agentIds.some((agentId) => store.getAgent(agentId))) return;
        store.updateAgentCreationOperation(current.id, {
          status: "rolled_back",
          lastError: reason,
        });
        for (const agentId of current.agentIds) deletingAgentIds.delete(agentId);
      };
      const project = store.getProject(projectId);
      const conversation = body?.conversationId
        ? store.getConversation(body.conversationId)
        : undefined;
      if (!project) {
        abandonMutationFreeOperation("project not found");
        return reply.code(404).send({ error: "project not found" });
      }
      if (deletingProjectIds.has(project.id)) {
        abandonMutationFreeOperation("Project deletion is already in progress");
        return reply.code(409).send({
          error: "Project deletion is already in progress",
        });
      }
      if (!conversation || conversation.projectId !== project.id ||
          deletingConversationIds.has(conversation.id)) {
        abandonMutationFreeOperation("an active destination Project Chat is required");
        return reply.code(400).send({
          error: "an active destination Project Chat is required",
        });
      }
      agentCreationConversationLeases.set(
        conversation.id,
        (agentCreationConversationLeases.get(conversation.id) ?? 0) + 1,
      );
      let creationLeaseReleased = false;
      const releaseCreationLease = () => {
        if (creationLeaseReleased) return;
        creationLeaseReleased = true;
        const remaining = (agentCreationConversationLeases.get(conversation.id) ?? 1) - 1;
        if (remaining > 0) agentCreationConversationLeases.set(conversation.id, remaining);
        else agentCreationConversationLeases.delete(conversation.id);
      };
      type PlannedArtifact =
        NonNullable<AgentPortablePackageDto["agents"][number]["artifacts"]>[number]
        & {
          data: Buffer;
          destinationId: string;
          managedPath: string;
          createdAt: string;
          summary: string;
          mediaType: string;
          sha256: string;
        };
      type PlannedNode = Omit<
        AgentPortablePackageDto["agents"][number],
        "artifacts" | "history"
      > & {
        targetEngine: string;
        model?: string;
        effort?: string;
        history: NonNullable<
          AgentPortablePackageDto["agents"][number]["history"]
        >;
        artifacts: PlannedArtifact[];
      };

      const rollbackAgentIds: string[] = [];
      let operationAgentIds: string[] = [];
      let rollbackArtifacts: PlannedArtifact[] = [];
      let appliedChatInstructions: string | undefined;
      let roleIntent:RoleResult["outputRoleFinalization"];
      let reviewedDestinationPolicy:string|undefined;
      let retainedWorkingFiles=false;
      const reviewedApplications:NonNullable<ImportAgentPackageResponse['reviewedUserDataApplications']>=[];
      const metadataApplications:NonNullable<ImportAgentPackageResponse['reviewedMetadataApplications']>=[];
      const pendingFolderMetadata:Array<{receipt?:NonNullable<ImportAgentPackageResponse['reviewedMetadataApplications']>[number];apply:()=>Promise<void>}>=[];
      const pendingLiveMetadata:Array<{receipt?:NonNullable<ImportAgentPackageResponse['reviewedMetadataApplications']>[number];apply:()=>Promise<void>}>=[];
      let metadataPrimaryError:unknown;
      const saveMetadataApplications=()=>{
        try{return store.updateAgentCreationOperation(creationOperationId!,{result:{...(store.getAgentCreationOperation(creationOperationId!)?.result as object??{}),reviewedMetadataApplications:metadataApplications}});}
        catch(receiptError){throw Object.assign(new Error('Metadata receipt persistence failed; preserve destination and original: '+(metadataPrimaryError instanceof Error?metadataPrimaryError.message:String(receiptError)),{cause:metadataPrimaryError??receiptError}),{code:(metadataPrimaryError as {code?:string}|undefined)?.code??'ERR_METADATA_RECEIPT_PERSISTENCE',partialStatePossible:true,receiptError});}
      };
      const metadataFailure=(error:unknown)=>{
        const failure=error as {code?:string;observed?:Record<string,unknown>};
        const raw=failure.observed?.identity??failure.observed;
        const identity=raw&&typeof raw==='object'?Object.fromEntries(['device','inode','kind','mode','mtimeNs','ownerId','groupId','parentDevice','parentInode','deviceMajor','deviceMinor'].filter(key=>Object.hasOwn(raw,key)).map(key=>[key,(raw as Record<string,unknown>)[key]])):null;
        return {message:redactPortableDiagnostic(error instanceof Error?error.message:String(error)),code:failure.code,partialStatePossible:true,observed:failure.observed?JSON.parse(JSON.stringify({identity,inventoryState:failure.observed.inventoryState??null},(_key,value)=>typeof value==='bigint'?value.toString():value)):null};
      };
      const liveWorkingRoots:NonNullable<ImportAgentPackageResponse['liveWorkingRoots']>=[];
      try {
      await onPhase?.("creating_records");
      signal?.throwIfAborted();

      let portablePackage: AgentPortablePackageDto;
      let importNodes: PlannedNode[];
      const metadataRootLinks=()=>importNodes.filter(node=>node.workingFolder).map(node=>({ref:node.workingRootRef??node.ref,links:node.workingFolder!.links??[]}));
      let importSourceLabel: string;
      const artifactRefMap = new Map<string, string>();
      try {
        const validated = validatePortableAgentPackage(body?.package);
        assertAgentPackageMemoryAvailable(validated.totalArtifactBytes);
        portablePackage = validated.package;
        importSourceLabel = portablePackage.sourceLabel.slice(0,240);
        const sourceChatRefs=new Set(portablePackage.agents.flatMap(node=>node.sourceChat?[node.sourceChat.ref]:[]));
        if(sourceChatRefs.size>1)throw new Error('Multiple source Chat bindings require separate organization packages; one export is one within-Chat reporting subtree');
        if(body.accessSettingsResolution?.agentActions){
          const refs=portablePackage.agents.filter(node=>node.accessSettings).map(node=>node.ref),actions=body.accessSettingsResolution.agentActions;
          if(Object.keys(actions).length!==refs.length||refs.some(ref=>!Object.hasOwn(actions,ref))||Object.keys(actions).some(ref=>!refs.includes(ref)))throw new Error('Per-Agent access choices must cover exactly the reviewed source settings');
        }
        if(body.reviewedUserDataActivation!==undefined||body.reviewedMetadataActivation!==undefined||body.accessSettingsResolution||portablePackage.agents.some(node=>node.accessSettings?.restrictedCapabilityIds.length)){
          const accessReview=await reviewAccess(portablePackage,conversation.id,body);
          reviewedDestinationPolicy=stableJson(accessReview.destination);
          const {reviewSha256}=accessReview;
          if(body.accessSettingsResolution?.reviewSha256!==reviewSha256){
            abandonMutationFreeOperation('Nonsecret access settings require human review');
            return reply.code(409).send({error:'Review source restrictions and destination access before importing',...accessReview});
          }
        }
        const rootRefs=[...new Set(portablePackage.agents.flatMap(node=>node.workingRootRef?[node.workingRootRef]:[]))];
        if(rootRefs.length){
          if(body.workingFilesDestination)throw new Error('Choose per-root destinations for an organization folder bundle');
          const mapping=body.workingRootDestinations;
          if(!mapping||typeof mapping!=='object'||Array.isArray(mapping)||Object.keys(mapping).length!==rootRefs.length||rootRefs.some(ref=>typeof mapping[ref]!=='string'||!path.isAbsolute(mapping[ref]!))||Object.keys(mapping).some(ref=>!rootRefs.includes(ref)))throw new Error('Choose one new absolute destination for every exported working root');
          const destinations=Object.values(mapping).map(value=>path.resolve(value));
          if(destinations.some((value,i)=>destinations.some((other,j)=>i!==j&&(value===other||value.startsWith(other+path.sep)))))throw new Error('Working-root destinations must be distinct and cannot nest');
        }else{
          if(body.workingRootDestinations)throw new Error('Package has no organization working roots');
          if(portablePackage.agents.some(node=>node.workingFiles?.length||node.workingFolder)&&!body.workingFilesDestination)throw new Error('Choose a new destination folder for selected working files');
          if(body.workingFilesDestination&&portablePackage.agents.filter(node=>node.workingFiles?.length||node.workingFolder).length!==1)throw new Error('One selected working folder is required for this destination');
        }
        validateNativeSelection(portablePackage,body,project.id);
        if(body.workingFilesActivation){
          if(portablePackage.mode!=='full'||!portablePackage.agents.some(node=>node.workingFolder||node.workingFiles?.length))throw new Error('Live activation requires a full package with selected folder originals');
          if(!context.workingCopies)throw new Error('Live working-copy import service is unavailable');
          const shared=portablePackage.agents.filter(node=>(body.workingCopyMode??node.workingCopyMode??'shared')==='shared');
          if(shared.length||body.workingFilesActivation.sharedRoot!==undefined){
            if(body.workingFilesActivation.sharedRoot!==project.hostPath||!store.isManagedProjectImportDestination(project.id)||store.listAgents(project.id).length)throw new Error('Choose an unused NEW managed Chat and explicitly confirm its Shared root');
            if(new Set(shared.map(node=>node.workingRootRef??node.ref)).size>1&&shared.filter(node=>node.workingFolder||node.workingFiles?.length).length>1)throw new Error('Distinct source roots cannot be collapsed into one Shared folder');
          }
          for(const ref of rootRefs){const members=portablePackage.agents.filter(node=>node.workingRootRef===ref);const modes=new Set(members.map(node=>body.workingCopyMode??node.workingCopyMode??'shared'));if(modes.size!==1||modes.has('separate_git')&&members.length!==1)throw new Error('Live import must preserve source root membership');}
        }
        if(portablePackage.agents.some(node=>(body.workingCopyMode??node.workingCopyMode)==='separate_git')&&!context.workingCopies)throw new Error('Separate Git copy import service is unavailable');
        if(portablePackage.outputRoles?.length&&!branchHooks){
          if(!outputApps||typeof body.outputRoleReviewId!=='string')throw new Error('Review imported output roles before confirming');
          const binding=await portableImportPayloadHash({package:portablePackage,destination:conversation.id});
          outputApps.claimImport(body.outputRoleReviewId,binding,creationOperationId!);
          roleIntent={reviewId:body.outputRoleReviewId,binding,mapping:{}};
        }
        const elevatedAgentRefs = portablePackage.agents.filter(node =>
          node.managementPermissions.allowAutomaticDescendantDeletion ||
          node.managementPermissions.allowAutomaticDescendantReorganization).map(node=>node.ref);
        const sourceEngines = new Set(portablePackage.agents.map(node=>node.engine));
        if (
          elevatedAgentRefs.length > 0
          && body.acknowledgeElevatedManagementPermissions !== true
        ) {
          abandonMutationFreeOperation("elevated management permissions were not acknowledged");
          return reply.code(409).send({
            error:
              "explicit acknowledgement is required to import autonomous destructive management permissions",
            elevatedAgentRefs,
          });
        }
        const missingMappings = [...sourceEngines].filter((engine) =>
          typeof body.engineMapping?.[engine] !== "string"
          || !body.engineMapping[engine]!.trim());
        if (missingMappings.length) {
          abandonMutationFreeOperation("required engine mappings were not supplied");
          return reply.code(409).send({
            error: "explicit engine mapping is required",
            requiredEngines: missingMappings,
          });
        }
        for (const source of sourceEngines) {
          const target = body.engineMapping[source]!.trim();
          if (!engines.has(target)) {
            throw new Error(`mapped engine is not configured: ${target}`);
          }
        }

        let artifactBytes = 0;
        const reservedDestinationIds = new Set<string>();
        let artifactPosition = 0;
        const artifactsByNode = new Map<string, PlannedArtifact[]>();
        for (const node of portablePackage.agents) {
          const plannedArtifacts: PlannedArtifact[] = [];
          for (const artifactCandidate of node.artifacts ?? []) {
            const artifact = artifactCandidate;
            const encodedBytes = validated.artifactBytes.get(artifact)!;
            if (artifactBytes + encodedBytes > AGENT_PACKAGE_ARTIFACT_MAX_BYTES) {
              abandonMutationFreeOperation(`portable Agent package artifacts exceed ${AGENT_PACKAGE_ARTIFACT_LIMIT_LABEL}`);
              return reply.code(413).send({ error: `portable Agent package artifacts exceed ${AGENT_PACKAGE_ARTIFACT_LIMIT_LABEL}` });
            }
            signal?.throwIfAborted();
            const { data, sha256 } = await decodePortableArtifactData(artifact);
            signal?.throwIfAborted();
            if(artifact.mediaType===EXECUTION_ARCHIVE_MEDIA_TYPE)validateExecutionArchive(data);
            artifactBytes += data.length;
            if (artifactBytes > AGENT_PACKAGE_ARTIFACT_MAX_BYTES) {
              abandonMutationFreeOperation(`portable Agent package artifacts exceed ${AGENT_PACKAGE_ARTIFACT_LIMIT_LABEL}`);
              return reply.code(413).send({
                error:
                  `portable Agent package artifacts exceed ${AGENT_PACKAGE_ARTIFACT_LIMIT_LABEL}`,
              });
            }
            const replayDestinationId = durableOperation.artifactIds[artifactPosition];
            let destinationId = replayDestinationId ?? artifact.ref;
            if (!replayDestinationId && (
              store.getProjectArtifact(project.id, destinationId)
              || reservedDestinationIds.has(destinationId)
              || (
                artifact.kind === "generated_file"
                && !/^[A-Za-z0-9_-]{1,128}$/u.test(destinationId)
              )
            )) {
              do destinationId = randomUUID();
              while (
                store.getProjectArtifact(project.id, destinationId)
                || reservedDestinationIds.has(destinationId)
              );
            }
            const extension = path.extname(artifact.path).toLowerCase()
              .slice(0, 16);
            const managedPath = `imported/${destinationId}${extension}`;
            const createdAt = new Date(artifact.createdAt).toISOString();
            const summary = artifact.summary?.trim()
              || path.basename(artifact.path).trim()
              || "Imported artifact";
            const mediaType = artifact.mediaType?.trim()
              || "application/octet-stream";
            if (
              artifact.kind === "generated_file"
              && !generatedArtifactMetadataIsValid({
                id: destinationId,
                projectId: project.id,
                agentId: project.id,
                originAgentId: project.id,
                kind: "generated_file",
                path: managedPath,
                ...(artifact.sourcePath
                  ? { sourcePath: artifact.sourcePath }
                  : {}),
                summary,
                createdAt,
                mediaType,
                size: data.length,
                sha256,
              })
            ) {
              throw new Error(
                `generated artifact ${artifact.ref} has invalid immutable metadata`,
              );
            }
            artifactRefMap.set(artifact.ref, destinationId);
            reservedDestinationIds.add(destinationId);
            artifactPosition += 1;
            plannedArtifacts.push({
              ...(artifactCandidate as PlannedArtifact),
              data,
              destinationId,
              managedPath,
              createdAt,
              summary,
              mediaType,
              sha256,
            });
          }
          artifactsByNode.set(node.ref, plannedArtifacts);
        }
        if (durableOperation.artifactIds.length > 0 &&
            durableOperation.artifactIds.length !== artifactPosition) {
          throw new Error("Agent import artifact recovery plan does not match the package");
        }

        importNodes = [];
        for (const node of portablePackage.agents) {
          const targetEngine = body.engineMapping[node.engine]!.trim();
          const model = node.model?.trim() || undefined;
          const effort = node.effort?.trim() || undefined;
          const importAdapter = engines.get(targetEngine)!.adapter;
          const selectionError = runtimeSelectionError(
            importAdapter,
            model,
            effort,
            cachedModelOptions(importAdapter, project.id),
          );
          const speedError = runtimeSpeedSelectionError(importAdapter, model, node.speed, cachedModelOptions(importAdapter, project.id));
          if (selectionError || speedError) {
            throw new Error(`${node.title}: ${selectionError ?? speedError}`);
          }
          const initialInstructions = node.initialInstructions === undefined ? undefined
            : rewritePortableArtifactReferences(node.initialInstructions, artifactRefMap);
          // Initial guidance has its own portable authority. Its private-context
          // entry is derived by the store, never added to exportable history.
          const history = [...(node.history ?? [])];
          for (let index = 0; index < history.length; index++) {
            const message = history[index]!;
            history[index] = { ...message, text: rewritePortableArtifactReferences(message.text, artifactRefMap), ...(message.attachmentRefs?{attachmentRefs:message.attachmentRefs.map(ref=>artifactRefMap.get(ref)!)}:{}), ...(message.artifactRefs?{artifactRefs:Object.fromEntries(Object.entries(message.artifactRefs).map(([source,ref])=>[source,artifactRefMap.get(ref)!]))}:{}) };
            if (index % 16 === 0) await yieldToLoop();
          }
          importNodes.push({
            ...node,
            title: node.title.trim().slice(0, 80) || "Imported Agent",
            initialInstructions,
            ...(node.role !== undefined ? { role: normalizeAgentRole(rewritePortableArtifactReferences(node.role, artifactRefMap)) } : {}),
            ...(node.presetSnapshot ? { presetSnapshot: {
              ...node.presetSnapshot,
              guidance: rewritePortableArtifactReferences(node.presetSnapshot.guidance, artifactRefMap),
            } } : {}),
            targetEngine,
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
            history,
            ...(node.workingFiles?{workingFiles:node.workingFiles.map(file=>({...file,artifactRef:artifactRefMap.get(file.artifactRef)!}))}:{}),
            artifacts: artifactsByNode.get(node.ref) ?? [],
          });
          await yieldToLoop();
        }
      } catch (error) {
        abandonMutationFreeOperation(error instanceof Error ? error.message : "invalid Ponderosa Agent package");
        return reply.code((error as {statusCode?:number})?.statusCode ?? 400).send({
          error: error instanceof Error ? error.message : "invalid Ponderosa Agent package",
        });
      }

      for(const node of importNodes)for(const file of node.workingFiles??[]){
        const original=node.artifacts.find(artifact=>artifact.destinationId===file.artifactRef);
        if(!original)throw new Error('Selected working-file original is missing');
        validateWorkingFileData(file.path,original.data);
      }
      const activeDestinationConversation = () => {
        const current = store.getConversation(conversation.id);
        return current?.projectId === project.id &&
          !deletingConversationIds.has(current.id)
          ? current
          : undefined;
      };
      const removeUncataloguedPublications = (
        artifacts: readonly PlannedArtifact[],
      ): boolean => {
        let removed = true;
        for (const artifact of artifacts) {
          if (store.getProjectArtifact(project.id, artifact.destinationId)) continue;
          try {
            removeManagedArtifactContent(
              context.dataDir,
              project.id,
              artifact.destinationId,
              artifact.data.length,
              artifact.sha256,
            );
            if (readManagedArtifactContent(
              context.dataDir,
              project.id,
              artifact.destinationId,
              artifact.data.length,
              artifact.sha256,
            )) removed = false;
          } catch {
            removed = false;
          }
        }
        return removed;
      };

      // Every deterministic decision is complete before the first mutation.
      if (deletingProjectIds.has(project.id)) {
        throw new Error("Project deletion is already in progress");
      }
      if (!activeDestinationConversation()) {
        abandonMutationFreeOperation("The destination Chat is no longer active");
        return reply.code(409).send({
          error: "The destination Chat is no longer active",
        });
      }
      const sourceInstructions = portablePackage.mode === "full"
        ? portablePackage.sourceProjectInstructions : undefined;
      const destinationInstructions = conversation.instructions ?? "";
      const resolution = body.chatInstructionsResolution;
      const destinationSha256 = createHash("sha256").update(destinationInstructions).digest("hex");
      if ((resolution && resolution.expectedDestinationSha256 !== destinationSha256) ||
          (sourceInstructions && destinationInstructions &&
            sourceInstructions !== destinationInstructions && !resolution)) {
        abandonMutationFreeOperation("Chat instructions need an explicit conflict choice");
        return reply.code(409).send({
          error: resolution ? "Destination Chat instructions changed. Review them and choose again."
            : "This Chat has different instructions. Choose whether to keep them or use the imported instructions.",
        });
      }
      const importedChatInstructions = sourceInstructions &&
        sourceInstructions !== destinationInstructions && resolution?.action !== "keep_destination"
        ? rewritePortableArtifactReferences(sourceInstructions, artifactRefMap) : undefined;
      if (importedChatInstructions && importedChatInstructions.length > 100_000) {
        abandonMutationFreeOperation("Imported Chat instructions exceed 100000 characters");
        return reply.code(400).send({ error: "Imported Chat instructions exceed 100000 characters" });
      }
      try {
        // Remapping a short colliding reference can grow otherwise admitted
        // text. Admit the complete persisted values before reserving records,
        // publishing bytes or changing the destination Chat.
        agentPackageJsonUtf8Bytes({
          ...portablePackage,
          ...(importedChatInstructions !== undefined ? { sourceProjectInstructions: importedChatInstructions } : {}),
          agents: importNodes.map((node, index) => ({
            ...portablePackage.agents[index],
            ...(node.initialInstructions !== undefined ? { initialInstructions: node.initialInstructions } : {}),
            ...(node.role !== undefined ? { role: node.role } : {}),
            ...(node.presetSnapshot ? { presetSnapshot: node.presetSnapshot } : {}),
            ...(portablePackage.mode === "full" ? { history: node.history } : {}),
            ...(node.artifacts.length ? { artifacts: node.artifacts.map((artifact, artifactIndex) => ({
              ...portablePackage.agents[index]!.artifacts![artifactIndex],
              ref: artifact.destinationId,
              path: artifact.managedPath,
            })) } : {}),
          })),
        });
        for (const node of importNodes) {
          agentPackageJsonUtf8Bytes({
            source: importSourceLabel,
            importedAt: new Date().toISOString(),
            ...(node.initialInstructions !== undefined ? { initialInstructions: node.initialInstructions, initialInstructionsSeparated: true } : {}),
            messages: node.history,
          }, AGENT_PACKAGE_MAX_BYTES - 1);
        }
      } catch (error) {
        abandonMutationFreeOperation(error instanceof Error ? error.message : "Agent package exceeds its byte limit");
        return reply.code((error as {statusCode?:number})?.statusCode ?? 400).send({ error: error instanceof Error ? error.message : "Agent package exceeds its byte limit" });
      }
      const packageMemory=portablePackage.memory??[];
      if(packageMemory.length){
        const memory=localMemoryFor(app);if(!memory)throw new AssetError(409,'Package contains memory; configure destination local memory before importing');
        for(const entry of packageMemory){try{validateMemorySnapshot(entry.snapshot,memory.core.database.raw.signature);}catch(error){throw new AssetError(400,error instanceof Error?error.message:'Invalid memory snapshot');}}
      }
      const plannedArtifacts = importNodes.flatMap((node) => node.artifacts);
      rollbackArtifacts = plannedArtifacts;
      store.sqlite.transaction(() => {
      if (creationOperationId) {
        const creationOperation = store.getAgentCreationOperation(creationOperationId);
        if (!creationOperation) throw new Error("Agent import creation operation is unavailable");
        if (creationOperation.agentIds.length === 0) {
          operationAgentIds = importNodes.map(() => randomUUID());
          operationAgentIds.forEach((agentId, position) => {
            store.addAgentCreationOperationMember(creationOperationId!, agentId, position);
            deletingAgentIds.add(agentId);
          });
          store.updateAgentCreationOperation(creationOperationId!, {
            artifactIds: plannedArtifacts.map((artifact) => artifact.destinationId),
            artifactIdentities: importNodes.flatMap((node, nodeIndex) =>
              node.artifacts.map((artifact) => ({
                id: artifact.destinationId,
                byteLength: artifact.data.length,
                sha256: artifact.sha256,
                ...(artifact.kind === "generated_file"
                  ? {
                      generated: {
                        agentId: operationAgentIds[nodeIndex]!,
                        originAgentId: operationAgentIds[nodeIndex]!,
                        path: artifact.managedPath,
                        ...(artifact.sourcePath
                          ? { sourcePath: artifact.sourcePath }
                          : {}),
                        summary: artifact.summary,
                        createdAt: artifact.createdAt,
                        mediaType: artifact.mediaType,
                      },
                    }
                  : {}),
              })),
            ),
          });
        } else {
          if (creationOperation.agentIds.length !== importNodes.length) {
            throw new Error("Agent import creation plan does not match the package");
          }
          operationAgentIds = creationOperation.agentIds;
          for (const agentId of operationAgentIds) deletingAgentIds.add(agentId);
        }
      }

      if(packageMemory.length){
        const memoryPlan=localMemoryFor(app)!.prepareImportMemory(creationOperationId!,packageMemory);
        store.updateAgentCreationOperation(creationOperationId!,{result:{phase:'prepared_memory',memoryPlan}});
      }

      if(branchHooks?.stage){
        if(!creationOperationId)throw new Error('Staged import requires its canonical creation operation');
        const result:unknown=branchHooks.stage({creationOperationId,projectId:project.id,conversationId:conversation.id,
          agents:importNodes.map((node,index)=>({sourceRef:node.ref,agentId:operationAgentIds[index]!})),
          artifacts:plannedArtifacts.map(artifact=>({sourceRef:artifact.ref,destinationId:artifact.destinationId,sha256:artifact.sha256,byteLength:artifact.data.length}))});
        if(result&&typeof result==='object'&&'then' in result)throw new Error('Import staging must be synchronous');
      }
      })();
      await branchHooks?.plan(operationAgentIds, creationOperationId);
      signal?.throwIfAborted();
      await onPhase?.("importing_artifacts");
      signal?.throwIfAborted();
      const publishedArtifacts = await publishManagedArtifactContentsAsync(
        context.dataDir,
        project.id,
        plannedArtifacts.map((artifact) => ({
          artifactId: artifact.destinationId,
          input: artifact.data,
        })),
      );
      const publicationById = new Map(
        plannedArtifacts.map((artifact, index) => [
          artifact.destinationId,
          publishedArtifacts[index]!,
        ]),
      );

      if (deletingProjectIds.has(project.id) ||
          !activeDestinationConversation()) {
        const rollbackComplete = removeUncataloguedPublications(plannedArtifacts);
        const reason = deletingProjectIds.has(project.id)
          ? "Project deletion is already in progress"
          : "The destination Chat is no longer active";
        if (rollbackComplete) abandonMutationFreeOperation(reason);
        else store.updateAgentCreationOperation(durableOperation.id, {
          status: "rolling_back",
          lastError: `${reason}; published artifact cleanup remains pending`,
        });
        return reply.code(409).send({
          error: reason,
        });
      }

      const folderImports=orderWorkingRoots((body.workingRootDestinations
        ? Object.entries(body.workingRootDestinations).map(([ref,destination])=>({destination,nodes:importNodes.filter(node=>node.workingRootRef===ref)}))
        : body.workingFilesDestination?[{destination:body.workingFilesDestination,nodes:importNodes}]:[]).map(item=>({...item,ref:item.nodes.find(node=>node.workingFolder)?.workingRootRef??item.nodes[0]!.ref,links:item.nodes.find(node=>node.workingFolder)?.workingFolder?.links??[]})));
      for(const {destination,nodes} of folderImports){
        const files=nodes.flatMap(node=>(node.workingFiles??[]).map(file=>{const artifact=node.artifacts.find(a=>a.destinationId===file.artifactRef)!;return {path:file.path,data:artifact.data,sha256:artifact.sha256,mode:file.mode,mtime:file.mtime};}));
        store.updateAgentCreationOperation(creationOperationId!,{result:{...(store.getAgentCreationOperation(creationOperationId!)?.result as object??{}),workingFilesDestination:body.workingFilesDestination,workingRootDestinations:body.workingRootDestinations}});
        const folder=nodes.find(node=>node.workingFolder)?.workingFolder;
        retainedWorkingFiles=true;
        const ref=nodes.find(node=>node.workingFolder)?.workingRootRef??nodes[0]!.ref;
        const metadataActivation=body.reviewedMetadataActivation?.rootRefs.includes(ref)?body.reviewedMetadataActivation:undefined;
        const original=files.find(file=>file.path===REVIEWED_USER_DATA_PATH);
        const receipt=metadataActivation&&original?{ref,path:destination,originalSha256:original.sha256,state:'applying' as 'applying'|'completed'|'incomplete',error:undefined as ReturnType<typeof metadataFailure>|undefined}:undefined;
        if(receipt){metadataApplications.push(receipt);saveMetadataApplications();}
        try{await importWorkingFiles(destination,files,folder?.directories??[],folder?.mode!==undefined&&folder.mtime?{mode:folder.mode,mtime:folder.mtime}:undefined,undefined,folder?.links,folder?.cyclicLinks,metadataActivation,true,body.workingRootDestinations);pendingFolderMetadata.push({receipt,apply:()=>finalizeWorkingFolderMetadata(destination,files,folder?.directories??[],folder?.mode!==undefined&&folder.mtime?{mode:folder.mode,mtime:folder.mtime}:undefined,folder?.links??[],metadataActivation,workingLinkCounts(ref,metadataRootLinks()))});}
        catch(error){metadataPrimaryError=error;for(const receipt of metadataApplications)if(receipt.state==='applying'){receipt.state='incomplete';receipt.error=metadataFailure(error);}throw error;}
        finally{if(receipt)saveMetadataApplications();}
      }
      if(body.reviewedUserDataActivation&&!body.workingFilesActivation){
        const owner=portablePackage.agents.find(node=>node.workingFolder||node.workingFiles?.length);
        const destinations=body.workingRootDestinations??{[owner!.workingRootRef??owner!.ref]:body.workingFilesDestination!};
        await applyReviewedRecoveryRoots(planReviewedRecoveryRoots(portablePackage,destinations,body.reviewedUserDataActivation),body.reviewedUserDataActivation,receipt=>{
          const index=reviewedApplications.findIndex(application=>application.ref===receipt.ref);
          if(index<0)reviewedApplications.push(receipt);else reviewedApplications[index]=receipt;
          store.updateAgentCreationOperation(creationOperationId!,{result:{...(store.getAgentCreationOperation(creationOperationId!)?.result as object??{}),reviewedUserDataApplications:reviewedApplications}});
        });
      }
      for(const pending of pendingFolderMetadata){
        try{await pending.apply();if(pending.receipt)pending.receipt.state='completed';}
        catch(error){metadataPrimaryError=error;for(const receipt of metadataApplications)if(receipt.state==='applying'){receipt.state='incomplete';receipt.error=metadataFailure(error);}throw error;}
        finally{if(pending.receipt)saveMetadataApplications();}
      }
      signal?.throwIfAborted();
      if(body.workingFilesActivation?.sharedRoot!==undefined){
        store.updateAgentCreationOperation(creationOperationId!,{result:{...(store.getAgentCreationOperation(creationOperationId!)?.result as object??{}),liveWorkingProjectRoot:project.hostPath}});
        if(body.reviewedUserDataActivation?.git)await context.workingCopies!.stageImportedSharedGit(project);
        else await context.workingCopies!.initializeImportProject(project);

      }
      const created = new Map<string, AgentDto>();
      await onPhase?.("importing_agents");
      signal?.throwIfAborted();
      for (const [index, node] of importNodes.entries()) {
        signal?.throwIfAborted();
        const agent = store.createAgent(project.id, {
          title: node.title,
          engine: node.targetEngine,
          conversationId: conversation.id,
          ...(node.model ? { model: node.model } : {}),
          ...(node.effort ? { effort: node.effort } : {}),
          ...(node.speed !== undefined ? { speed: node.speed } : {}),
          ...(node.role !== undefined ? { role: node.role } : {}),
          managementPermissions: node.managementPermissions,
        }, undefined, operationAgentIds[index], node.presetSnapshot ?? null);
        created.set(node.ref, agent);
        rollbackAgentIds.push(agent.id);
        const folderMode=body.workingCopyMode??node.workingCopyMode;
        if(folderMode==='separate_git'){
          const release=context.workingCopies!.beginModeChange(agent.id);
          try{const configured=body.workingFilesActivation&&body.reviewedUserDataActivation?.git?await context.workingCopies!.allocateImportedSeparateGit(agent,project):await context.workingCopies!.setMode(agent,project,folderMode);if(!body.reviewedUserDataActivation?.git&&configured.workingCopy.state!=='ready')throw new Error(configured.workingCopy.failure??'Imported working copy is unavailable');created.set(node.ref,configured);}finally{release();}
        }
        deletingAgentIds.add(agent.id);
        await yieldToLoop();
      }

      if(body.workingFilesActivation){
        const liveLinkDestinations=Object.fromEntries(importNodes.map(node=>[node.workingRootRef??node.ref,created.get(node.ref)!.workingCopy.rootPath]));
        const owners=orderWorkingRoots(importNodes.filter(node=>node.workingFolder||node.workingFiles?.length).map(node=>({node,ref:node.workingRootRef??node.ref,links:node.workingFolder?.links??[]}))).map(item=>item.node);
        for(const node of owners){
          const agent=created.get(node.ref)!;
          const members=importNodes.filter(member=>created.get(member.ref)!.workingCopy.rootPath===agent.workingCopy.rootPath);
          const ref=node.workingRootRef??node.ref;
          const root={ref,path:agent.workingCopy.rootPath,agentIds:members.map(member=>created.get(member.ref)!.id)};
          liveWorkingRoots.push(root);
          const backupRoot=path.join(root.path,'.ponderosa-import-backups');
          store.updateAgentCreationOperation(creationOperationId!,{result:{...(store.getAgentCreationOperation(creationOperationId!)?.result as object??{}),liveWorkingRoots}});
          const files=(node.workingFiles??[]).map(file=>{const artifact=node.artifacts.find(a=>a.destinationId===file.artifactRef)!;return {path:file.path,data:artifact.data,sha256:artifact.sha256,mode:file.mode,mtime:file.mtime};});
          const reviewedOriginal=files.find(file=>file.path===REVIEWED_USER_DATA_PATH);
          const application=body.reviewedUserDataActivation&&reviewedOriginal?{ref,path:root.path,originalSha256:reviewedOriginal.sha256,selection:body.reviewedUserDataActivation,state:'applying' as 'applying'|'completed'|'incomplete',error:undefined as {code?:string;partialStatePossible:boolean;observed:unknown}|undefined}:undefined;
          if(application){reviewedApplications.push(application);store.updateAgentCreationOperation(creationOperationId!,{result:{...(store.getAgentCreationOperation(creationOperationId!)?.result as object??{}),reviewedUserDataApplications:reviewedApplications}});}
          const metadataActivation=body.reviewedMetadataActivation?.rootRefs.includes(ref)?body.reviewedMetadataActivation:undefined;
          const metadataApplication=metadataActivation&&reviewedOriginal?{ref,path:root.path,originalSha256:reviewedOriginal.sha256,state:'applying' as 'applying'|'completed'|'incomplete',error:undefined as ReturnType<typeof metadataFailure>|undefined}:undefined;
          if(metadataApplication){metadataApplications.push(metadataApplication);saveMetadataApplications();}
          const release=context.workingCopies!.beginModeChange(agent.id);
          try{await context.workingCopies!.populateImportedRoot(agent,project,files,node.workingFolder?.directories??[],node.workingFolder?.mode!==undefined&&node.workingFolder.mtime?{mode:node.workingFolder.mode,mtime:node.workingFolder.mtime}:undefined,backupRoot,node.workingFolder?.links,node.workingFolder?.cyclicLinks,body.reviewedUserDataActivation,metadataActivation,liveLinkDestinations,true);if(application&&!body.reviewedUserDataActivation?.git)application.state='completed';pendingLiveMetadata.push({...(metadataApplication?{receipt:metadataApplication}:{}),apply:async()=>{const release=context.workingCopies!.beginModeChange(agent.id);try{await context.workingCopies!.finalizeImportedRootMetadata(store.getAgent(agent.id)!,project,files,node.workingFolder?.directories??[],node.workingFolder?.mode!==undefined&&node.workingFolder.mtime?{mode:node.workingFolder.mode,mtime:node.workingFolder.mtime}:undefined,node.workingFolder?.links??[],metadataActivation,workingLinkCounts(ref,metadataRootLinks()));}finally{release();}}});}catch(error){metadataPrimaryError=error;for(const receipt of metadataApplications)if(receipt.state==='applying'){receipt.state='incomplete';receipt.error=metadataFailure(error);}if(application){application.state='incomplete';const failure=error as {code?:string;partialStatePossible?:boolean;observed?:unknown};application.error={code:failure.code,partialStatePossible:true,observed:failure.observed===undefined?null:JSON.parse(JSON.stringify(failure.observed,(_key,value)=>typeof value==='bigint'?value.toString():value))};}throw error;}finally{release();if(metadataApplication)saveMetadataApplications();if(application)store.updateAgentCreationOperation(creationOperationId!,{result:{...(store.getAgentCreationOperation(creationOperationId!)?.result as object??{}),reviewedUserDataApplications:reviewedApplications}});}
        }
        if(body.reviewedUserDataActivation?.git){
          const liveDestinations=Object.fromEntries(owners.map(node=>[node.workingRootRef??node.ref,created.get(node.ref)!.workingCopy.rootPath]));
          const recoveryDestinations=body.workingRootDestinations??{[owners[0]!.workingRootRef??owners[0]!.ref]:body.workingFilesDestination!};
          const relocate=(target:string)=>{const entries=Object.entries(recoveryDestinations).filter(([,root])=>target===root||target.startsWith(root+path.sep)).sort((a,b)=>b[1].length-a[1].length);const entry=entries[0];if(!entry)throw new Error('Git activation path lost its included source root');return path.join(liveDestinations[entry[0]]!,path.relative(entry[1],target));};
          const activation={...body.reviewedUserDataActivation,...(body.reviewedUserDataActivation.gitPathMappings?{gitPathMappings:body.reviewedUserDataActivation.gitPathMappings.map(mapping=>({...mapping,destination:relocate(mapping.destination)}))}:{})};
          const releases=[...new Set([...created.values()].map(agent=>agent.id))].map(id=>context.workingCopies!.beginModeChange(id));
          try{await context.workingCopies!.completeImportedGitRoots(project,portablePackage,liveDestinations,activation,receipt=>{
            const index=reviewedApplications.findIndex(application=>application.ref===receipt.ref);
            if(index<0)reviewedApplications.push(receipt);else reviewedApplications[index]=receipt;
            store.updateAgentCreationOperation(creationOperationId!,{result:{...(store.getAgentCreationOperation(creationOperationId!)?.result as object??{}),reviewedUserDataApplications:reviewedApplications}});
          },[...created.values()].map(agent=>agent.id));}finally{for(const release of releases)release();}
          for(const [ref,agent] of created)created.set(ref,store.getAgent(agent.id)!);

        }
      }

      for(const pending of pendingLiveMetadata){
        try{await pending.apply();if(pending.receipt)pending.receipt.state='completed';}
        catch(error){metadataPrimaryError=error;for(const receipt of metadataApplications)if(receipt.state==='applying'){receipt.state='incomplete';receipt.error=metadataFailure(error);}throw error;}
        finally{if(pending.receipt)saveMetadataApplications();}
      }

      const catalogArtifacts: Array<{
        artifact: Parameters<AgentStore["recordProjectArtifact"]>[0];
      }> = [];
      await onPhase?.("importing_history");
      await onPhase?.("finalizing");
      for (const node of importNodes) {
        const agent = created.get(node.ref)!;
        for (const artifact of node.artifacts) {
          const catalogArtifact = {
            id: artifact.destinationId,
            projectId: project.id,
            agentId: agent.id,
            originAgentId: agent.id,
            kind: artifact.kind,
            path: artifact.managedPath,
            summary: artifact.summary,
            createdAt: artifact.createdAt,
            mediaType: artifact.mediaType,
            visibility: artifact.visibility ?? "project",
            pinned: artifact.pinned ?? false,
            ...(artifact.sourcePath
              ? { sourcePath: artifact.sourcePath }
              : {}),
            size: artifact.data.length,
            sha256: artifact.sha256,
          };
          catalogArtifacts.push({ artifact: catalogArtifact });
        }
      }
      store.recordProjectArtifacts(catalogArtifacts);

      for (const node of importNodes) {
        const agent = created.get(node.ref)!;
        if (node.history.length || node.initialInstructions !== undefined || node.workingFiles?.length || node.workingFolder) {
          await store.setImportedHistoryAsync(
            agent.id,
            importSourceLabel,
            node.history,
            node.initialInstructions,
            node.workingFiles||node.workingFolder?{workingFiles:node.workingFiles,workingFolder:node.workingFolder}:undefined,
          );
        }
      }
      for(const [index,entry] of packageMemory.entries()){
        signal?.throwIfAborted();
        const mapping=Object.fromEntries(Object.entries(entry.agentRefs).map(([id,ref])=>[id,created.get(ref)!.id]));
        await localMemoryFor(app)!.restoreImportMemory(creationOperationId!,entry,mapping,creationOperationId+':m:'+index,signal);
      }
      signal?.throwIfAborted();
      // All imported Agents start detached. Attach descendants before their
      // managers so each existing ancestry check stays bounded even for a
      // 10,000-deep organization supplied in arbitrary package order.
      const childrenByManager = new Map<string, PlannedNode[]>();
      for (const node of importNodes) {
        if (!node.managerRef) continue;
        const siblings = childrenByManager.get(node.managerRef) ?? [];
        siblings.push(node);
        childrenByManager.set(node.managerRef, siblings);
      }
      const assignmentOrder = (portablePackage.rootRefs??[portablePackage.rootRef]).map(ref=>importNodes.find(node=>node.ref===ref)!);
      for (let index = 0; index < assignmentOrder.length; index++) {
        for (const child of childrenByManager.get(assignmentOrder[index]!.ref) ?? []) assignmentOrder.push(child);
      }
      for (const node of assignmentOrder.reverse()) {
        signal?.throwIfAborted();
        if (node.managerRef) {
          store.updateAgentOrganization(
            created.get(node.ref)!.id,
            { managerAgentId: created.get(node.managerRef)!.id },
          );
        }
        await yieldToLoop();
      }
      for (const { artifact } of catalogArtifacts) {
        if (artifact.kind !== "generated_file") continue;
        assets.registerPublishedGeneratedArtifact(
          artifact as RegisteredGeneratedArtifact,
          publicationById.get(artifact.id)!,
        );
      }
      const response: RoleResult = {
        agentRefs:Object.fromEntries([...created].map(([ref,agent])=>[ref,agent.id])),
        ...(body.workingFilesActivation?{liveWorkingRoots}:{}),
        ...(body.reviewedUserDataActivation?{reviewedUserDataApplications:reviewedApplications}:{}),
        ...(body.reviewedMetadataActivation?{reviewedMetadataApplications:metadataApplications}:{}),
        ...(body.workingFilesDestination?{workingFilesDestination:body.workingFilesDestination}:{}),
        ...(roleIntent?{outputRoleFinalization:{...roleIntent,mapping:Object.fromEntries([...created].map(([ref,agent])=>[ref,agent.id]))}}:{}),
        accessSettingsToReview:importNodes.filter(node=>node.accessSettings&&(node.accessSettings.readGlobalMemory!==undefined||node.accessSettings.savedBrowserAllowed!==undefined||node.accessSettings.browserMode!==undefined)).map(node=>({agentId:created.get(node.ref)!.id,source:node.accessSettings!,conversationId:conversation.id})),
        ...(body.workingRootDestinations?{workingRoots:Object.entries(body.workingRootDestinations).map(([ref,destination])=>({ref,destination,agentIds:importNodes.filter(node=>node.workingRootRef===ref).map(node=>created.get(node.ref)!.id)}))}:{}),
        rootAgentId: created.get(portablePackage.rootRef)!.id,
        agentIds: [...created.values()].map((agent) => agent.id),
      };
      if (creationOperationId) {
        // Copy snapshots are retry authority only until the canonical import
        // commits. Remove and fsync them before acknowledging completion so the
        // caller cannot observe success with stale recovery data.
        await removeCopySnapshot(creationOperationId);
        if (importedChatInstructions !== undefined) {
          const currentDestination = activeDestinationConversation();
          if (!currentDestination || (currentDestination.instructions ?? "") !== destinationInstructions) {
            throw Object.assign(new Error("Destination Chat instructions changed. Review them and choose again."), { statusCode: 409 });
          }
          appliedChatInstructions = importedChatInstructions;
          if (!store.updateConversation(conversation.id, { instructions: importedChatInstructions })) {
            throw new Error("The destination Chat is no longer active");
          }
        }
        signal?.throwIfAborted();
        await branchHooks?.beforeAdmit?.(response);
        signal?.throwIfAborted();
        if(roleIntent)outputApps!.checkImport(roleIntent.reviewId,roleIntent.binding,creationOperationId);
        const commit=()=>{
          if(reviewedDestinationPolicy!==undefined&&stableJson(new CapabilityPolicyStore(store.sqlite).resolveForChat(conversation.id))!==reviewedDestinationPolicy)throw new Error('Destination access changed; review the import again');
          if(body.accessSettingsResolution){
            const policies=new CapabilityPolicyStore(store.sqlite);
            for(const node of importNodes)if(node.accessSettings&&(body.accessSettingsResolution.agentActions?.[node.ref]??body.accessSettingsResolution.action)==='use_source')policies.put({scopeKind:'agent',scopeId:created.get(node.ref)!.id,expectedRevision:0,restrictedCapabilityIds:node.accessSettings.restrictedCapabilityIds,actor:'operator',reason:'Human-reviewed portable nonsecret access settings'});
          }
          const completeImport=()=>store.updateAgentCreationOperation(creationOperationId!, {
            status: "completed", result: branchHooks?{...response,memoryPlan:(store.getAgentCreationOperation(creationOperationId!)?.result as {memoryPlan?:unknown[]}|undefined)?.memoryPlan}:response, lastError: null,
          });
          if(branchHooks?.holdForDisclosure){
            if(!branchHooks.stage||operationAgentIds.some(id=>!destinationAdmissionHeld(store.sqlite,id)))throw new Error('Disclosure hold requires exact staged identities');
            if(roleIntent||packageMemory.length||plannedArtifacts.length||liveWorkingRoots.length||retainedWorkingFiles)throw new Error('Deferred admission supports only artifact-free private organization state');
            store.updateAgentCreationOperation(creationOperationId!,{status:'canonical_committed',result:{...response,branchDestinationPrepared:true},lastError:null});
            const held:unknown=branchHooks.holdForDisclosure(response);
            if(held&&typeof held==='object'&&'then' in held)throw new Error('Disclosure hold must be synchronous');
          }else if(branchHooks?.admit){
            const result:unknown=branchHooks.admit(response,completeImport);
            if(result&&typeof result==='object'&&'then' in result)throw new Error('Historical admission must be synchronous');
            if(store.getAgentCreationOperation(creationOperationId!)?.status!=='completed'||operationAgentIds.some(id=>destinationAdmissionHeld(store.sqlite,id)))throw new Error('Historical admission did not publish readiness and import completion');
          }else{branchHooks?.commit(response);completeImport();}
        };
        if(branchHooks?.transaction)branchHooks.transaction(commit);else store.sqlite.transaction(commit)();
        for (const agentId of operationAgentIds) deletingAgentIds.delete(agentId);
        if(!branchHooks?.holdForDisclosure)finishRoles(creationOperationId);
      }
      try {
        appendWorkspace({
          type: "project_changed",
          projectId: project.id,
          action: "updated",
        });
      } catch {
        // Clients reconcile the durable import on their next refresh.
      }
      if (appliedChatInstructions !== undefined) {
        try {
          appendWorkspace({ type: "conversation_changed", projectId: project.id,
            conversationId: conversation.id, action: "updated" });
        } catch { /* Clients reconcile durable Chat metadata on refresh. */ }
      }
      return reply.code(201).send(response);
      } catch (error) {
        if(liveWorkingRoots.length)error=new Error(`${error instanceof Error?error.message:String(error)}; live working roots and displaced baselines retained at ${JSON.stringify(liveWorkingRoots)}`,{cause:error});
        if(retainedWorkingFiles)error=new Error(`${error instanceof Error?error.message:String(error)}; user working files retained at ${JSON.stringify(body.workingRootDestinations??body.workingFilesDestination)}`,{cause:error});
        if(creationOperationId&&['completed','canonical_committed'].includes(store.getAgentCreationOperation(creationOperationId)?.status??'')){
          return reply.code(409).send({error:'Imported resources committed; output role finalization needs recovery/review: '+(error as Error).message,operationId:creationOperationId});
        }
        let rollbackComplete = true;
        if(creationOperationId){
          store.updateAgentCreationOperation(creationOperationId,{status:'rolling_back'});
          try{const memoryPlan=(store.getAgentCreationOperation(creationOperationId)?.result as {memoryPlan?:unknown[]}|undefined)?.memoryPlan;if(memoryPlan?.length){const memory=localMemoryFor(app);if(!memory)throw new Error('Local memory configuration required for import rollback');await memory.rollbackImportMemory(creationOperationId);}}
          catch{rollbackComplete=false;}
        }
        if (appliedChatInstructions !== undefined) {
          try {
            if (store.getConversation(conversation.id)?.instructions === appliedChatInstructions) {
              store.updateConversation(conversation.id, { instructions: conversation.instructions ?? "" });
            }
          } catch { rollbackComplete = false; }
        }
        const authorityBlockedArtifactIds = new Set<string>();
        try {
          // Pending members are intentionally absent from the public directory.
          // Resolve and delete the entire owned organization in one preview.
          const liveIds=rollbackAgentIds.filter(id=>store.getAgent(id));
          if(liveIds.length){
            const preview=store.previewAgentDeletion(liveIds);
            if(preview.affectedAgents.some(agent=>!rollbackAgentIds.includes(agent.id)))throw new Error("Import rollback would affect an unowned Agent");
            store.deleteAgentSubtrees(liveIds,preview.previewHash,id=>coordinationV3.handleAgentDeletion(id));
          }
        } catch {
          // Exact cleanup authority remains durable for startup recovery.
          rollbackComplete=false;
        }
        const operationAgentsRemain = operationAgentIds.some((agentId) => store.getAgent(agentId));
        if (creationOperationId) {
          for (const identity of store.getAgentCreationOperation(creationOperationId)!
            .artifactIdentities) {
            try {
              if (operationAgentsRemain ||
                  !assets.removeCreationGeneratedArtifact(project.id, identity)) {
                authorityBlockedArtifactIds.add(identity.id);
                rollbackComplete = false;
              }
            } catch {
              authorityBlockedArtifactIds.add(identity.id);
              rollbackComplete = false;
            }
          }
        }
        for (const artifact of rollbackArtifacts) {
          if (authorityBlockedArtifactIds.has(artifact.destinationId)) continue;
          try {
            const catalogued = store.getProjectArtifact(project.id, artifact.destinationId);
            if (catalogued && (!catalogued.originAgentId ||
                !operationAgentIds.includes(catalogued.originAgentId))) {
              continue;
            }
            if (catalogued) {
              store.deleteProjectArtifact(project.id, artifact.destinationId, "Agent import rolled back");
            }
            if (store.getProjectArtifact(project.id, artifact.destinationId)) {
              rollbackComplete = false;
            } else {
              removeManagedArtifactContent(
                context.dataDir,
                project.id,
                artifact.destinationId,
                artifact.data.length,
                artifact.sha256,
              );
              if (readManagedArtifactContent(
                context.dataDir,
                project.id,
                artifact.destinationId,
                artifact.data.length,
                artifact.sha256,
              )) rollbackComplete = false;
            }
          } catch {
            rollbackComplete = false;
          }
        }
        if (operationAgentsRemain) rollbackComplete = false;
        if(rollbackComplete&&roleIntent)outputApps?.abandonReview(roleIntent.reviewId);
        if (creationOperationId) {
          store.updateAgentCreationOperation(creationOperationId, {
            status: rollbackComplete ? "rolled_back" : "rolling_back",
            ...(retainedWorkingFiles?{result:{...(store.getAgentCreationOperation(creationOperationId)?.result as object??{}),workingFilesDestination:body.workingFilesDestination,workingRootDestinations:body.workingRootDestinations}}:{}),
            lastError: error instanceof Error ? error.message : "Agent import failed",
          });
        }
        throw error;
      } finally {
        for (const agentId of operationAgentIds.length ? operationAgentIds : rollbackAgentIds) {
          if (!store.getAgent(agentId)) deletingAgentIds.delete(agentId);
        }
        releaseCreationLease();
      }
  });

  const importStagedPackage = async (
    request: FastifyRequest<{ Params: { id: string }; Headers: { "idempotency-key"?: string }; Body: StagedImportUpload }>,
    reply: FastifyReply,
    jsonEnvelope = false,
  ): Promise<unknown> => {
    try {
      const idempotencyKey = validIdempotencyKey(request.headers["idempotency-key"]);
      if (!idempotencyKey) return reply.code(400).send({ error: "a valid import idempotency key is required" });
      return await withAgentImportAdmission(async () => {
        if (await sha256File(request.body.pathname) !== request.body.sha256) throw new Error("Agent upload changed after admission");
        const { metadata, portable, canonicalPayloadHash } = await parsePortablePackageFile(request.body.pathname, { jsonEnvelope });
        if (jsonEnvelope && !canonicalPayloadHash) throw new Error("Agent import canonical identity is unavailable");
        if ((!jsonEnvelope && metadata.conversationId !== request.body.metadata?.conversationId) ||
            !resourceInProduct(store, "conversation", metadata.conversationId, requestProduct(request))) {
          return reply.code(404).send({ error: "The destination Chat is unavailable in this product" });
        }
        return importPackage(request.params.id, { ...metadata, package: portable }, reply, undefined, undefined, {
          idempotencyKey,
          // JSON callers retain their original canonical payload identity;
          // binary uploads retain their exact owned-upload identity.
          rawPayloadHash: jsonEnvelope ? canonicalPayloadHash : request.body.sha256,
        });
      });
    } catch (error) {
      return reply.code((error as {statusCode?:number})?.statusCode ?? 400).send({ error: error instanceof Error ? error.message : "invalid Ponderosa Agent package" });
    } finally {
      await cleanupUpload(request.body);
    }
  };

  // Scope the legacy JSON envelope to the existing owned staging and codec.
  // Ordinary JSON routes keep their parser and request budgets unchanged.
  void app.register(async scope => {
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser("application/json", stagedImportParser(true));
    scope.post<{ Params: { id: string }; Headers: { "idempotency-key"?: string }; Body: StagedImportUpload }>(
      "/api/projects/:id/import-agents",
      { bodyLimit: maximumJsonImportBytes, preHandler: claimUpload, onRequest: packageOperation,config:{agentPackageOperation:true} },
      (request, reply) => importStagedPackage(request, reply, true),
    );
  });

  const runBackgroundImport = async (operationId: string): Promise<void> =>
    withAgentImportAdmission(async () => {
    await operationHydration;
    if(syncFs.existsSync(importLifecyclePath(operationId)))return;
    let operation = await readOperation(operationId);
    if (!operation || operation.status !== "pending") return;
    const update = async (patch: Partial<AgentImportOperationDto>) => {
      operation = { ...operation!, ...patch, updatedAt: new Date().toISOString() };
      await writeOperation(operation);
      return operation;
    };
    const phase = async (next: AgentImportPhase) => {
      await update({ phase: next });
      try {
        createOperationalNotification({
          dedupeKey: `agent-import:${operationId}`,
          category: "system",
          severity: "info",
          title: "Agent import in progress",
          body: next.replaceAll("_", " "),
          projectId: operation!.projectId,
          conversationId:operation!.conversationId,
          action: { kind: "open_project", targetId: operation!.projectId },
        });
      } catch { /* phase state is durable; notification is best effort */ }
    };
    let committedResult: ImportAgentPackageResponse | undefined;
    let retainPayloadForRecovery = false;
    let committedCreationId:string|undefined;
    try {
      const durablePayloadPath = payloadPath(operationId);
      if (await sha256File(durablePayloadPath) !== operation.payloadHash) {
        throw new Error("Import payload no longer matches its durable operation");
      }
      const { metadata, portable } = await parsePortablePackageFile(durablePayloadPath);
      if(metadata.conversationId!==operation.conversationId||!resourceInProduct(store,'conversation',operation.conversationId,operation.product))throw new Error('Import destination no longer matches its admitted product');
      await update({ sourceLabel: portable.sourceLabel.slice(0, 240) });
      const creationOperation = store.beginAgentCreationOperation({
        projectId: operation.projectId,
        actorScope: "user:local-operator",
        kind: "import",
        idempotencyKey: operation.requestId,
        payloadHash: operation.payloadHash,
        conversationId: metadata.conversationId,
      }).operation;
      committedCreationId=creationOperation.id;
      if (creationOperation.status === "completed" && creationOperation.result) {
        const result = finishRoles(creationOperation.id);
        committedResult = result;
        await update({ phase: "completed", status: "completed", result });
        for (const agentId of creationOperation.agentIds) deletingAgentIds.delete(agentId);
        return;
      }
      if (creationOperation.agentIds.length) {
        throw new Error("A prior import attempt is still being recovered; retry after startup recovery completes");
      }
      let statusCode = 200;
      let responseBody: unknown;
      const backgroundReply = {
        code(code: number) {
          statusCode = code;
          return this;
        },
        send(value: unknown) {
          responseBody = value;
          return value;
        },
      } as unknown as FastifyReply;
      await importPackage(
        operation.projectId,
        { ...metadata, package: portable },
        backgroundReply,
        phase,
        creationOperation.id,
      );
      if (statusCode >= 400) {
        const record = responseBody && typeof responseBody === "object"
          ? responseBody as { error?: unknown }
          : undefined;
        throw new Error(typeof record?.error === "string" ? record.error : "Import failed");
      }
      const result = responseBody as ImportAgentPackageResponse;
      committedResult = result;
      await update({ phase: "completed", status: "completed", result });
      try {
        createOperationalNotification({
          dedupeKey: `agent-import:${operationId}`,
          category: "system",
          severity: "info",
          title: "Import complete",
          informational: true,
          body: `${operation.sourceLabel} was imported successfully. Reviewing its preserved history is optional; the Agent is ready to use.`,
          projectId: operation.projectId,
          conversationId:operation.conversationId,
          agentId: result.rootAgentId,
          action: { kind: "open_agent", targetId: result.rootAgentId },
        });
      } catch { /* completion remains authoritative */ }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Import failed";
      if(committedCreationId&&store.getAgentCreationOperation(committedCreationId)?.status==='completed'&&!committedResult){
        retainPayloadForRecovery=true;
        await update({phase:'finalizing',status:'pending',error:message.slice(0,1000),outputRoleRecoveryId:committedCreationId});
        try{createOperationalNotification({dedupeKey:'import-role-recovery:'+committedCreationId,category:'system',severity:'attention',title:'Imported output roles need review',body:message.slice(0,1000),projectId:operation.projectId,conversationId:operation.conversationId,action:{kind:'open_project',targetId:operation.projectId}});}catch{/* Durable role recovery remains visible on the import operation. */}
        return;
      }
      if (committedResult) {
        // The imported Agents are authoritative. If the acknowledgement write
        // failed, leave the durable operation pending so startup can replay it;
        // never rewrite a committed import as an ordinary failure.
        try {
          await update({ phase: "completed", status: "completed", result: committedResult });
        } catch {
          retainPayloadForRecovery = true;
          // Startup hydration and creation-operation replay recover the acknowledgement.
        }
        return;
      }
      try {
        await update({ phase: "failed", status: "failed", error: message.slice(0, 1_000) });
      } catch {
        retainPayloadForRecovery = true;
        return;
      }
      try {
        createOperationalNotification({
          dedupeKey: `agent-import:${operationId}`,
          category: "system",
          severity: "urgent",
          title: "Agent import failed",
          body: `${operation.sourceLabel}: ${message}`.slice(0, 1_000),
          projectId: operation.projectId,
          conversationId:operation.conversationId,
          action: { kind: "open_project", targetId: operation.projectId },
        });
      } catch { /* failure state is durable */ }
    } finally {
      if (!retainPayloadForRecovery) {
        const removed = await fs.unlink(payloadPath(operationId))
          .then(() => true)
          .catch(() => false);
        if (removed) {
          releaseStagedReservation(operationReservations.get(operationId));
          operationReservations.delete(operationId);
        }
      }
    }
  });

  app.post<{Params:{id:string;operationId:string};Body?:{reviewId?:string}}>('/api/projects/:id/agent-role-finalizations/:operationId',async(request,reply)=>{
    try{
      const op=store.getAgentCreationOperation(request.params.operationId),result=op?.result as RoleResult|undefined,intent=result?.outputRoleFinalization;
      if(!op||op.projectId!==request.params.id||!op.conversationId||!resourceInProduct(store,'conversation',op.conversationId,requestProduct(request))||op.status!=='completed'||!intent)return reply.code(404).send({error:'Committed role import unavailable'});
      const body=request.body??{};exactObjectFields(validatedObject(body,'Role confirmation'),['reviewId'],'Role confirmation');
      if(body.reviewId!==undefined&&typeof body.reviewId!=='string')throw new Error('Invalid role review');
      if(intent.done){for(const background of operationCache.values())if(background.projectId===op.projectId&&background.requestId===op.idempotencyKey)setImmediate(()=>void runBackgroundImport(background.id));return result;}
      if(!outputApps)throw new Error('Output role service unavailable');

      if(body.reviewId===undefined){
        try{const result=finishRoles(op.id);for(const background of operationCache.values())if(background.projectId===op.projectId&&background.requestId===op.idempotencyKey)setImmediate(()=>void runBackgroundImport(background.id));return result;}catch{/* A changed state needs an explicit new review. */}
        return outputApps.reReviewImport(intent.reviewId,intent.binding,op.id,intent.mapping);
      }
      if(typeof body.reviewId!=='string')throw new Error('Invalid role review');
      outputApps.claimImport(body.reviewId,intent.binding,op.id);
      const old=intent.reviewId;intent.reviewId=body.reviewId;store.updateAgentCreationOperation(op.id,{result});outputApps.abandonReview(old);
      const finalized=finishRoles(op.id);
      for(const background of operationCache.values())if(background.projectId===op.projectId&&background.requestId===op.idempotencyKey)setImmediate(()=>void runBackgroundImport(background.id));
      return finalized;
    }catch(error){return reply.code(409).send({error:(error as Error).message});}
  });
  app.post<{Params:{id:string};Body:StagedImportUpload}>('/api/projects/:id/agent-access-preview',{bodyLimit:maximumImportBytes,preHandler:claimUpload,onRequest:packageOperation,config:{agentPackageOperation:true}},async(request,reply)=>{
    try{
      if(await sha256File(request.body.pathname)!==request.body.sha256)throw new Error('Agent upload changed after admission');
      const {metadata,portable}=await parsePortablePackageFile(request.body.pathname);
      validatePortableAgentPackage(portable);
      const chat=store.getConversation(metadata.conversationId);
      if(!chat||chat.projectId!==request.params.id||!resourceInProduct(store,'conversation',chat.id,requestProduct(request)))return reply.code(404).send({error:'Import destination unavailable'});
      return await reviewAccess(portable,chat.id,metadata);
    }catch(error){return reply.code(409).send({error:(error as Error).message});}
    finally{await cleanupUpload(request.body);}
  });
  app.post<{Params:{id:string};Body:StagedImportUpload}>('/api/projects/:id/agent-role-preview',{bodyLimit:maximumImportBytes,preHandler:claimUpload,onRequest:packageOperation,config:{agentPackageOperation:true}},async(request,reply)=>{
    try{
      if(await sha256File(request.body.pathname)!==request.body.sha256)throw new Error('Agent upload changed after admission');
      const {metadata,portable}=await parsePortablePackageFile(request.body.pathname);
      validatePortableAgentPackage(portable);
      const chat=store.getConversation(metadata.conversationId);
      if(!chat||chat.projectId!==request.params.id||!resourceInProduct(store,'conversation',chat.id,requestProduct(request)))return reply.code(404).send({error:'Import destination unavailable'});
      if(!outputApps)throw new Error('Output role service unavailable');
      const binding=await portableImportPayloadHash({package:portable,destination:chat.id});
      return outputApps.reviewImport(portable.outputRoles??[],binding,Boolean(chat.branchId&&!chat.executionId));
    }catch(error){return reply.code(409).send({error:(error as Error).message});}
    finally{await cleanupUpload(request.body);}
  });
  app.post<{
    Params: { id: string };
    Headers: { "idempotency-key"?: string };
    Body: StagedImportUpload;
  }>(
    "/api/projects/:id/agent-import-operations",
    { bodyLimit: maximumImportBytes,preHandler:claimUpload,onRequest:packageOperation,config:{agentPackageOperation:true} },
    async (request, reply) => withProjectImportLock(request.params.id, async () => {
      const staged = request.body;
      let transferredReservation = false;
      try {
        await operationHydration;
        const requestId = validIdempotencyKey(request.headers["idempotency-key"]);
      if (!requestId) {
        return reply.code(400).send({ error: "a valid import idempotency key is required" });
      }
      const destination=store.getConversation(staged.metadata!.conversationId),product=requestProduct(request);
      if(!destination||destination.projectId!==request.params.id||!resourceInProduct(store,'conversation',destination.id,product))return reply.code(404).send({error:'The destination Chat is unavailable in this product'});
      const requestKey = requestOperationKey(request.params.id, requestId);
      const requestPayloadHash = staged.sha256;
      const existingId = operationByRequest.get(requestKey);
      if (existingId) {
        const existing = operationCache.get(existingId) ?? await readOperation(existingId);
        if (existing) {
          if(existing.conversationId!==destination.id||existing.product!==product)return reply.code(404).send({error:'import operation not found'});
          if (existing.payloadHash !== requestPayloadHash) {
            return reply.code(409).send({
              error: "Import idempotency key was reused with different input",
            });
          }
          return reply.code(existing.status === "pending" ? 202 : 200).send(existing);
        }
        operationByRequest.delete(requestKey);
      }
      if (!store.getProject(request.params.id)) {
        return reply.code(404).send({ error: "project not found" });
      }
      if (deletingProjectIds.has(request.params.id)) {
        return reply.code(409).send({ error: "Project deletion is already in progress" });
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      const operation: AgentImportOperationDto = {
        id,
        requestId,
        payloadHash: requestPayloadHash,
        projectId: request.params.id,
        conversationId:destination.id,
        product,
        sourceLabel: "Agent import",
        phase: "queued",
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };
      try {
        await fs.mkdir(importOperationDirectory, { recursive: true });
        await fs.rename(staged.pathname, payloadPath(id));
        operationReservations.set(id, staged.reservationId);
        transferredReservation = true;
        if (process.platform !== "win32") {
          const directory = await fs.open(importOperationDirectory, "r");
          try { await directory.sync(); } finally { await directory.close(); }
        }
        await writeOperation(operation);
      } catch (error) {
        operationByRequest.delete(requestKey);
        operationCache.delete(id);
        const removed = await fs.unlink(payloadPath(id))
          .then(() => true)
          .catch(() => false);
        if (removed) {
          releaseStagedReservation(operationReservations.get(id));
          operationReservations.delete(id);
        }
        throw error;
      }
      setImmediate(() => void runBackgroundImport(id));
      try {
        createOperationalNotification({
          dedupeKey: `agent-import:${id}`,
          category: "system",
          severity: "info",
          title: "Agent import queued",
          body: "The import continues in the background.",
          projectId: operation.projectId,
          conversationId:operation.conversationId,
          action: { kind: "open_project", targetId: operation.projectId },
        });
      } catch { /* the durable queue and scheduled worker remain authoritative */ }
      return reply.code(202).send(operation);
      } finally {
        if(!transferredReservation)await cleanupUpload(staged);
        else ownedUploads.delete(staged);
      }
    }),
  );

  app.get<{ Params: { id: string; operationId: string } }>(
    "/api/projects/:id/agent-import-operations/:operationId",
    async (request, reply) => {
      await operationHydration;
      const operation = operationCache.get(request.params.operationId)
        ?? await readOperation(request.params.operationId);
      if (!operation || operation.projectId !== request.params.id || operation.product!==requestProduct(request) || !resourceInProduct(store,'conversation',operation.conversationId,requestProduct(request))) {
        return reply.code(404).send({ error: "import operation not found" });
      }
      return operation;
    },
  );

  for(const group of [false,true]){
  const destinationRetirement=destinationLifecycle({dataDir:context.dataDir,store,coordination:coordinationV3,owner:context.custodyOwner,runtimeIdle:context.destinationRuntimeIdle,creationLeases:agentCreationConversationLeases},group);
  const retirementPath=group?'/api/lifecycle/destination-groups/:id':'/api/lifecycle/destinations/:id';
  app.get<{Params:{id:string}}>(retirementPath+'/review',async(request,reply)=>{
    try{await operationHydration;context.assertLifecycleEffectsSettled();return destinationRetirement.review(request.params.id);}catch(error){return reply.code(409).send({error:(error as Error).message});}
  });
  app.get<{Params:{id:string}}>(retirementPath+'/receipt',(request,reply)=>{
    try{return destinationRetirement.receipt(request.params.id)??reply.code(404).send({error:'Retirement receipt unavailable'});}catch(error){return reply.code(409).send({error:(error as Error).message});}
  });
  for(const action of ['approve','retire'] as const)app.post<{Params:{id:string};Body:import('@ponderosa/core').DestinationRetirementChoice}>(retirementPath+'/'+action,(request,reply)=>withAgentImportAdmission(async()=>{
    try{await operationHydration;context.assertLifecycleEffectsSettled();const body=validatedObject(request.body,'Destination retirement choice');exactObjectFields(body,['commandKey','expectedReviewHash','releaseSourcePins','authorizeDeletedOwner'],'Destination retirement choice');return destinationRetirement[action](request.params.id,request.body);}
    catch(error){return reply.code(409).send({error:(error as Error).message});}
  }));
  }
  void operationHydration.then(() => {
    for (const operation of operationCache.values()) {
      if (operation.status === "pending") {
        setImmediate(() => void app.ready().then(() => runBackgroundImport(operation.id)));
      }
    }
  }).catch(() => undefined);

  app.post<{
    Params: { id: string };
    Headers: { "idempotency-key"?: string };
    Body: StagedImportUpload;
  }>(
    "/api/projects/:id/import-agent-package",
    { bodyLimit: maximumImportBytes,preHandler:claimUpload,onRequest:packageOperation,config:{agentPackageOperation:true} },
    (request, reply) => importStagedPackage(request, reply),
  );

  app.post<{
    Params: { id: string };
    Headers: { "idempotency-key"?: string };
    Body: CopyAgentPackageRequest;
  }>(
    "/api/projects/:id/copy-agent",
    { bodyLimit: 64 * 1024, onRequest: packageOperation,config:{agentPackageOperation:true} },
    async (request, reply) => withAgentImportAdmission(async () => {
      await operationHydration;
      const idempotencyKey = validIdempotencyKey(request.headers["idempotency-key"]);
      if (!idempotencyKey) {
        return reply.code(400).send({ error: "a valid import idempotency key is required" });
      }
      if (!request.body || typeof request.body !== "object" || Array.isArray(request.body) ||
          Object.keys(request.body).some((key) => ![
            "sourceAgentId", "conversationId", "rootTitle", "mode", "organization",
            "acknowledgeElevatedManagementPermissions", "chatInstructionsResolution", "accessSettingsResolution", "workingCopyMode", "workingFilesDestination", "workingRootDestinations", "workingFilesActivation", "reviewedUserDataActivation", "reviewedMetadataActivation",
          ].includes(key)) ||
          !validChatInstructionsResolution(request.body.chatInstructionsResolution) ||
          typeof request.body.sourceAgentId !== "string" ||
          typeof request.body.conversationId !== "string") {
        return reply.code(400).send({ error: "copy request fields are invalid" });
      }
      if(request.body.reviewedMetadataActivation!==undefined){
        try{requireReviewedMetadataApplication(request.body.reviewedMetadataActivation);}catch(error){return reply.code(400).send({error:error instanceof Error?error.message:String(error)});}
      }
      const sourceAgentId = request.body.sourceAgentId.trim();
      const conversationId = request.body.conversationId.trim();
      const rootTitle = typeof request.body.rootTitle === "string"
        ? request.body.rootTitle.trim()
        : undefined;
      if (
        !sourceAgentId
        || !conversationId
        || (
          request.body.rootTitle !== undefined
          && (
            typeof request.body.rootTitle !== "string"
            || !rootTitle
            || rootTitle.length > 80
          )
        )
        || (
          request.body.mode !== undefined
          && request.body.mode !== "template"
          && request.body.mode !== "full"
        )
        || (
          request.body.organization !== undefined
          && typeof request.body.organization !== "boolean"
        )
        || (
          request.body.acknowledgeElevatedManagementPermissions !== undefined
          && typeof request.body.acknowledgeElevatedManagementPermissions
            !== "boolean"
        )
      ) {
        return reply.code(400).send({
          error: "copy request fields are invalid",
        });
      }
      const payloadHash = createHash("sha256").update(stableJson({
        sourceAgentId,
        conversationId,
        ...(request.body.accessSettingsResolution?{accessSettingsResolution:request.body.accessSettingsResolution}:{}),
        ...(request.body.workingCopyMode?{workingCopyMode:request.body.workingCopyMode}:{}),
        ...(request.body.reviewedUserDataActivation?{reviewedUserDataActivation:request.body.reviewedUserDataActivation}:{}),
            ...(request.body.reviewedMetadataActivation!==undefined?{reviewedMetadataActivation:request.body.reviewedMetadataActivation}:{}),
            ...(request.body.workingFilesActivation?{workingFilesActivation:request.body.workingFilesActivation}:{}),
        ...(request.body.workingRootDestinations?{workingRootDestinations:request.body.workingRootDestinations}:{}),
        ...(request.body.workingFilesDestination?{workingFilesDestination:request.body.workingFilesDestination}:{}),
        ...(request.body.chatInstructionsResolution ? { chatInstructionsResolution: request.body.chatInstructionsResolution } : {}),
        ...(rootTitle ? { rootTitle } : {}),
        mode: request.body.mode ?? "full",
        organization: request.body.organization ?? false,
        acknowledgeElevatedManagementPermissions:
          request.body.acknowledgeElevatedManagementPermissions ?? false,
      })).digest("hex");
      let creationOperation;
      try {
        creationOperation = store.beginAgentCreationOperation({
          projectId: request.params.id,
          actorScope: "user:local-operator",
          kind: "import",
          idempotencyKey,
          payloadHash,
          conversationId,
        }).operation;
      } catch (error) {
        return reply.code(409).send({
          error: error instanceof Error ? error.message : "Agent copy replay conflict",
        });
      }
      if (creationOperation.status === "completed" && creationOperation.result) {
        return reply.code(200).send(creationOperation.result);
      }
      if (creationOperation.status === "canonical_committed" ||
          creationOperation.status === "rolling_back" ||
          creationOperation.agentIds.length > 0) {
        return reply.code(409).send({
          error: "A prior copy attempt is still being recovered; retry after recovery completes",
          operationId: creationOperation.id,
        });
      }
      if (activeCopyOperations.has(creationOperation.id)) {
        return reply.code(409).send({
          error: "Agent copy is still in progress; retry with the same idempotency key",
          operationId: creationOperation.id,
        });
      }
      activeCopyOperations.add(creationOperation.id);
      const abandonMutationFreeCopy = (reason: string): boolean => {
        const current = store.getAgentCreationOperation(creationOperation.id);
        if (!current || current.agentIds.length > 0) return false;
        store.updateAgentCreationOperation(current.id, {
          status: "rolled_back",
          lastError: reason,
        });
        return true;
      };
      let portable: AgentPortablePackageDto;
      try {
        const savedSnapshot = preparedCopySnapshot(creationOperation.result);
        let prepared = await readCopySnapshot(
          creationOperation.id,
          savedSnapshot?.snapshotSha256,
        );
        if (!prepared) {
          if (savedSnapshot) {
            throw new Error("Agent copy snapshot is unavailable");
          }
          const source = store.getAgent(sourceAgentId);
          if (!source) {
            activeCopyOperations.delete(creationOperation.id);
            if (!abandonMutationFreeCopy("agent not found")) {
              return reply.code(409).send({
                error: "A prior copy attempt is still being recovered; retry after recovery completes",
                operationId: creationOperation.id,
              });
            }
            return reply.code(404).send({ error: "agent not found" });
          }
          prepared = await installCopySnapshot(
            creationOperation.id,
            await buildPortablePackage(
              source.id,
              request.body.mode ?? "full",
              request.body.organization === true,
            ),
          );
        }
        delete prepared.portable.outputRoles; // Copy is not a reviewed output-role import.
        portable = rootTitle
          ? {
              ...prepared.portable,
              agents: prepared.portable.agents.map((node) =>
                node.ref === prepared.portable.rootRef
                  ? { ...node, title: rootTitle }
                  : node),
            }
          : prepared.portable;
        if (!savedSnapshot) {
          store.updateAgentCreationOperation(creationOperation.id, {
            result: {
              phase: "prepared_copy",
              snapshotSha256: prepared.sha256,
            } satisfies PreparedCopySnapshot,
          });
        }
      } catch (error) {
        activeCopyOperations.delete(creationOperation.id);
        if (!abandonMutationFreeCopy(
          error instanceof Error ? error.message : "Agent copy could not be prepared",
        )) {
          return reply.code(409).send({
            error: "A prior copy attempt is still being recovered; retry after recovery completes",
            operationId: creationOperation.id,
          });
        }
        throw error;
      }
      const engineMapping = Object.fromEntries(
        [...new Set(portable.agents.map((node) => node.engine))]
          .map((engineId) => [engineId, engineId]),
      );
      return importPackage(
        request.params.id,
        {
          package: portable,
          conversationId,
          engineMapping,
          ...(request.body.accessSettingsResolution?{accessSettingsResolution:request.body.accessSettingsResolution}:{}),
          ...(request.body.workingCopyMode?{workingCopyMode:request.body.workingCopyMode}:{}),
          ...(request.body.reviewedUserDataActivation?{reviewedUserDataActivation:request.body.reviewedUserDataActivation}:{}),
            ...(request.body.reviewedMetadataActivation!==undefined?{reviewedMetadataActivation:request.body.reviewedMetadataActivation}:{}),
            ...(request.body.workingFilesActivation?{workingFilesActivation:request.body.workingFilesActivation}:{}),
        ...(request.body.workingRootDestinations?{workingRootDestinations:request.body.workingRootDestinations}:{}),
        ...(request.body.workingFilesDestination?{workingFilesDestination:request.body.workingFilesDestination}:{}),
          ...(request.body.chatInstructionsResolution ? { chatInstructionsResolution: request.body.chatInstructionsResolution } : {}),
          ...(request.body.acknowledgeElevatedManagementPermissions === true
            ? { acknowledgeElevatedManagementPermissions: true }
            : {}),
        },
        reply,
        undefined,
        creationOperation.id,
      ).finally(async () => {
        activeCopyOperations.delete(creationOperation.id);
        if (store.getAgentCreationOperation(creationOperation.id)?.status === "completed") {
          await removeCopySnapshot(creationOperation.id);
        }
      });
    }),
  );
  app.addHook('onReady',async()=>{
    for(const row of store.sqlite.prepare("SELECT id FROM agent_creation_operations WHERE status='completed' AND json_type(result_json,'$.outputRoleFinalization')='object' AND COALESCE(json_extract(result_json,'$.outputRoleFinalization.done'),0)=0 LIMIT 64").all() as Array<{id:string}>){
      try{finishRoles(row.id);}catch(error){try{createOperationalNotification({dedupeKey:'import-role-recovery:'+row.id,category:'system',severity:'attention',title:'Imported output roles need review',body:(error as Error).message,projectId:store.getAgentCreationOperation(row.id)!.projectId,conversationId:store.getAgentCreationOperation(row.id)!.conversationId,action:{kind:'open_agent',targetId:(store.getAgentCreationOperation(row.id)!.result as ImportAgentPackageResponse).rootAgentId}});}catch{/* Durable receipt remains pending role recovery. */}}
    }
  });
  return {packageEngine:{
    inspectCheckpoint:source=>checkpointCustody.inspect(source),
    captureCheckpoint:(source,seal)=>withAgentImportAdmission(async()=>{
      const frozen={...source,agentIds:[...source.agentIds],intent:{...source.intent}};
      const status=await checkpointCustody.inspect(frozen);
      if(status.state==='retained'){if(seal)throw new Error('Issued capture needs its committed Branch receipt; retained bytes alone cannot reseal a later cut');return status.receipt;}
      if(status.state!=='missing')throw new Error(`Checkpoint custody ${status.state}; cannot recapture this intent`);
      const memory=localMemoryFor(app);
      const memoryDatabases=memory?await memory.checkpointSourceDatabases():[];
      const token=beginSourceCapture(store.sqlite,...memoryDatabases);
      const admit=()=>{
        const chat=store.getConversation(frozen.sourceChatId);
        if(!chat||!activeChatResourceOwner(store,'chat',chat.id))throw new Error('Checkpoint source Chat unavailable');
        assertCheckpointMembership(frozen.sourceChatId,frozen.agentIds,store.listAgents(chat.projectId,{includePendingCreation:true}));
        for(const id of frozen.agentIds){const agent=store.getAgent(id);if(!agent||!activeChatResourceOwner(store,'agent',id)||store.agentCreationPending(id)||deletingAgentIds.has(id)||deletingConversationIds.has(agent.conversationId)||deletingProjectIds.has(agent.projectId))throw new Error('Checkpoint source membership unavailable');}
        memory?.assertCheckpointSourceSettled();
      };
      try{return await checkpointCustody.capture(frozen,token.boundaryId,async()=>{
        admit();
        const inputs:AgentPackageCompositionInput[]=[];
        let capturedBytes=0;
        for(const id of frozen.agentIds){
          const agent=store.getAgent(id);
          if(!agent||agent.conversationId!==frozen.sourceChatId||store.agentCreationPending(id)||deletingAgentIds.has(id)||deletingConversationIds.has(agent.conversationId)||deletingProjectIds.has(agent.projectId))throw new Error('Checkpoint source membership unavailable');
          const portable=await buildPortablePackage(id,'full',false);
          capturedBytes+=agentPackageJsonUtf8Bytes(portable);
          if(capturedBytes>AGENT_PACKAGE_MAX_BYTES)throw new Error('Checkpoint source packages exceed package byte limit');
          inputs.push({ref:id,...(agent.managerAgentId&&frozen.agentIds.includes(agent.managerAgentId)?{managerRef:agent.managerAgentId}:{}),package:portable});
        }
        return (await composeAgentPackages(inputs)).package;
      },(publish,receipt)=>commitSourceCapture(token,()=>{admit();const result:unknown=seal?.(receipt);if(result&&typeof result==='object'&&'then' in result)throw new Error('Checkpoint sealing must be synchronous');publish();}));}finally{releaseSourceCapture(token);}
    }),
    readCheckpoint:receipt=>checkpointCustody.read(receipt),
    readCheckpointBytes:receipt=>checkpointCustody.readBytes(receipt),
    verifyCheckpointNow:receipt=>checkpointCustody.verifyNow(receipt),
    finishDestinationImport(operationId,compose){
      const operation=store.getAgentCreationOperation(operationId),result=operation?.result as ImportAgentPackageResponse&{branchDestinationPrepared?:boolean};
      if(!store.sqlite.inTransaction||operation?.status!=='canonical_committed'||operation.kind!=='import'||!result?.branchDestinationPrepared
        ||operation.agentIds.some(id=>!destinationAdmissionHeld(store.sqlite,id)))throw new Error('Exact prepared destination import required');
      const composed:unknown=compose(result,()=>{store.updateAgentCreationOperation(operationId,{status:'completed',lastError:null});});
      if(composed&&typeof composed==='object'&&'then' in composed||store.getAgentCreationOperation(operationId)?.status!=='completed'||operation.agentIds.some(id=>destinationAdmissionHeld(store.sqlite,id)))throw new Error('Destination composition did not commit exact import readiness');
      // This set is a process-local quarantine. SQLite remains the readiness authority.
      for(const id of operation.agentIds)deletingAgentIds.delete(id);
    },
    releaseCheckpoint:receipt=>checkpointCustody.release(receipt),
    composeAgents:composeAgentPackages,
    reviewAccess,
    setOutputApps(owner:OutputAgentApps){outputApps=owner;},
    validateAgent(pkg,mapping) {
      if(pkg.memory?.length){const memory=localMemoryFor(app);if(!memory)throw new Error('Package contains memory; configure destination local memory before importing');for(const entry of pkg.memory)validateMemorySnapshot(entry.snapshot,memory.core.database.raw.signature);}
      for (const node of validatePortableAgentPackage(pkg).package.agents) {
        const target=mapping[node.engine]?.trim(), registration=target?engines.get(target):undefined;
        if(!registration)throw new Error(`Choose an available Engine for ${node.engine}`);
        const error=runtimeSelectionError(registration.adapter,node.model?.trim()||undefined,node.effort?.trim()||undefined,cachedModelOptions(registration.adapter)) ?? runtimeSpeedSelectionError(registration.adapter,node.model?.trim()||undefined,node.speed,cachedModelOptions(registration.adapter));
        if(error)throw new Error(`${node.title}: ${error}`);
      }
    },
    exportMemory:async(chatId,agentIds)=>{const memory=localMemoryFor(app);if(!memory)throw new Error('Configure destination local memory before reviewing memory updates');return memory.exportPackageMemory(chatId,agentIds);},
    verifyStagedMemory:async(id,pkg)=>{if(pkg.memory?.length){const memory=localMemoryFor(app);if(!memory)throw new Error('Local memory configuration required for staged import verification');await memory.verifyStagedMemory(id,pkg);}},
    rollbackStagedMemory:async id=>{const memory=localMemoryFor(app);const plan=(store.getAgentCreationOperation(id)?.result as {memoryPlan?:unknown[]}|undefined)?.memoryPlan;if(plan?.length){if(!memory)throw new Error('Local memory configuration required for staged import cleanup');await memory.rollbackImportMemory(id);}},
    exportAgent:(id,mode,options)=>withAgentImportAdmission(()=>buildPortablePackage(id,mode,options?.organization??false,options?.selectedWorkingFiles??[],options?.wholeWorkingFolder??false,options?.organizationWorkingFolders??false,options?.reviewedUserData,options?.gitStorageBindings)),
    importAgent:(projectId,chatId,pkg,engineMapping,key,options)=>withAgentImportAdmission(async()=>{
      let status=200,body:unknown;
      const response={code(value:number){status=value;return this;},send(value:unknown){body=value;return value;}} as unknown as FastifyReply;
      await importPackage(projectId,{package:pkg,conversationId:chatId,engineMapping,acknowledgeElevatedManagementPermissions:true,...(options?.workingFilesDestination?{workingFilesDestination:options.workingFilesDestination}:{}),...(options?.reviewedUserDataActivation?{reviewedUserDataActivation:options.reviewedUserDataActivation}:{}),...(options?.reviewedMetadataActivation!==undefined?{reviewedMetadataActivation:options.reviewedMetadataActivation}:{}),...(options?.workingFilesActivation?{workingFilesActivation:options.workingFilesActivation}:{}),...(options?.workingRootDestinations?{workingRootDestinations:options.workingRootDestinations}:{}),...(options?.accessSettingsResolution?{accessSettingsResolution:options.accessSettingsResolution}:{})},response,undefined,undefined,{idempotencyKey:key},options?.branchHooks,options?.signal);
      if(status>=400){
        const accessSettingsReview=status===409&&typeof body==='object'&&body&&'reviewSha256' in body
          ? {reviewSha256:(body as AgentAccessImportReviewDto).reviewSha256,source:(body as AgentAccessImportReviewDto).source,destination:(body as AgentAccessImportReviewDto).destination}:undefined;
        throw Object.assign(new Error(typeof body==='object'&&body&&'error' in body?String(body.error):'Agent import failed'),{statusCode:status,provisionRejected:status===400||status===404,...(accessSettingsReview?{accessSettingsReview}:{})});
      }
      return body as ImportAgentPackageResponse;
    }),
  }};

}

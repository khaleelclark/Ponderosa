// One-time content restore. Source formats stop at this offline boundary; the
// running application only receives current authored records and empty runtime.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "@ponderosa/native-host/fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { AgentDto, ProjectDto, ConversationDto, CommunicationEvent, CommunicationProjection, ConversationMessageDto, ChatFolderDto, PortableAgentHistoryMessageDto, ArtifactDto, AssetDto, CommunicationAttachmentDto, CommunicationDocumentReference } from "@ponderosa/core";
import { ASSET_MEDIA_TYPES, deriveCommunicationBehavior, isCommunicationEvent } from "@ponderosa/core";
import { AgentStore } from "./store.js";
import { WorkspaceStore } from "./workspace-store.js";
import { artifactSequencePath, retainedArtifactHighWater } from "./artifact-sequence.js";
import { writeJson } from "./store-filesystem.js";
import { managedArtifactStorageFilename } from "./paths.js";
import { appendFsyncedJsonl } from "./append-jsonl.js";
import type { ManagedArtifactAccess, ManagedArtifactEvent } from "./store-types.js";
interface IndexedFile {
  path: string;
  bytes: number;
  sha256: string;
}
interface BackupProject {
  project: ProjectDto;
  agents: AgentDto[];
  conversations: ConversationDto[];
}
interface BackupManifest {
  channel: "prod" | "dev";
  projects: BackupProject[];
  conversationCount: number;
  agentCount: number;
  packages?: Array<{
    path: string;
  }>;
  backupScope?: {
    retainedChatIds: string[];
  };
}
interface ChatArchive {
  historyCompleteAtRead: boolean;
  originalChat: ConversationDto & {
    workingDirectory?: string;
    instructions?: string;
  };
  detail?: {
    conversation: ConversationDto & {
      workingDirectory?: string;
      instructions?: string;
    };
  };
  messages: ConversationMessageDto[];
  collaborationMessages?: ConversationMessageDto[];
}
interface PortableAgent {
  ref: string;
  initialInstructions?: string;
  history?: PortableAgentHistoryMessageDto[];
  artifacts?: Array<{
    ref: string;
    kind: ArtifactDto["kind"];
    path: string;
    sourcePath?: string;
    summary: string;
    createdAt: string;
    mediaType?: string;
    visibility?: "project" | "published";
    pinned?: boolean;
    dataBase64: string;
  }>;
}
interface ContentProject extends BackupProject {
  communicationEvents: CommunicationEvent[];
  communicationRevisions: Array<Record<string, unknown> & {
    eventId: string;
  }>;
  communicationProjections: CommunicationProjection[];
}
interface SidecarArtifact extends ArtifactDto {
  projectId: string;
  originAgentId: string;
  sidecarPath: string;
  actualBytes: number;
  actualSha256: string;
}
export interface ContentRestoreSource {
  directory: string;
  channel: "prod" | "dev";
  indexSha256: string;
}
export type RestoredGeneratedArtifact = ArtifactDto & {
  projectId: string;
  originAgentId: string;
  kind: "generated_file";
  mediaType: string;
  summary: string;
  size: number;
  sha256: string;
};
export interface RestoredDocumentArtifact {
  id: string; projectId: string; role: "document"; title: string;
  mediaType: "text/markdown"; blobPath: string; blobHash: string; byteLength: number;
  createdAt: string; originAgentId?: string; executionId?: string;
}
export interface ContentRestoreOptions {
  sources: ContentRestoreSource[];
  output: string;
  registerGeneratedArtifacts?: (dataDirectory: string, artifacts: readonly RestoredGeneratedArtifact[]) => void;
  registerDocumentArtifacts?: (dataDirectory: string, artifacts: readonly RestoredDocumentArtifact[]) => void;
  encodePngPreview?: (original: Uint8Array) => Uint8Array;
  validateRecoveredUploads?: (dataDirectory: string, uploads: readonly { projectId: string; agentId: string; id: string }[]) => void;
  documentSupplement?: {
    directory: string;
    manifestSha256: string;
  };
  uploadSupplement?: {
    directory: string;
    manifestSha256: string;
  };
}
interface Namespace {
  source: Source;
  original: BackupProject;
  chat: ChatArchive;
  id: string;
  agents: AgentDto[];
  events: CommunicationEvent[];
  revisions: Array<Record<string, unknown> & {
    eventId: string;
  }>;
  projections: CommunicationProjection[];
}
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition)
    throw new Error(message);
}
function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function safeRelative(value: string): string {
  requireValue(typeof value === "string" && value.length > 0 && !isAbsolute(value) && !value.includes("\\") && !value.includes("\0") && value.split("/").every(part => part !== ".." && part !== "." && part !== ""), "unsafe backup path");
  return value;
}
function safeId(value: string): string {
  requireValue(value.length > 0 && value.length <= 200 && !/[\\/\0]/u.test(value) && value !== "." && value !== "..", "unsafe record identity");
  return value;
}
function checkedPath(root: string, relative: string): string {
  const parts = safeRelative(relative).split("/");
  let result = root;
  for (const [index, part] of parts.entries()) {
    result = join(result, part);
    const info = lstatSync(result);
    requireValue(!info.isSymbolicLink() && (index === parts.length - 1 ? info.isFile() && info.nlink === 1 : info.isDirectory()), "backup entry must be an ordinary owned file");
  }
  return result;
}
function hashFile(file: string): {
  bytes: number;
  sha256: string;
} {
  const fd = openSync(file, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(1024 * 1024);
  let bytes = 0;
  try {
    let count: number;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, count));
      bytes += count;
    }
    requireValue(fstatSync(fd).size === bytes, "source changed during verification");
  }
  finally {
    closeSync(fd);
  }
  return {
    bytes,
    sha256: hash.digest("hex")
  };
}
class Source {
  readonly root: string;
  readonly manifest: BackupManifest;
  readonly files = new Map<string, IndexedFile>();
  readonly portable = new Map<string, PortableAgent>();
  constructor(readonly input: ContentRestoreSource) {
    this.root = resolve(input.directory);
    requireValue(lstatSync(this.root).isDirectory() && !lstatSync(this.root).isSymbolicLink(), "backup root must be an ordinary directory");
    requireValue(/^[a-f0-9]{64}$/u.test(input.indexSha256), "an independently verified index hash is required");
    const indexFile = checkedPath(this.root, "file-index.json");
    requireValue(hashFile(indexFile).sha256 === input.indexSha256, "backup index checksum mismatch");
    const index = JSON.parse(readFileSync(indexFile, "utf8")) as {
      channel: string;
      files: IndexedFile[];
    };
    requireValue(index.channel === input.channel && Array.isArray(index.files), "backup channel mismatch");
    for (const entry of index.files) {
      safeRelative(entry.path);
      requireValue(!this.files.has(entry.path) && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && /^[a-f0-9]{64}$/u.test(entry.sha256), "invalid or duplicate backup index entry");
      const actual = hashFile(checkedPath(this.root, entry.path));
      requireValue(actual.bytes === entry.bytes && actual.sha256 === entry.sha256, `backup checksum mismatch: ${entry.path}`);
      this.files.set(entry.path, entry);
    }
    this.manifest = this.read<BackupManifest>("manifest.json");
    requireValue(this.manifest.channel === input.channel && Array.isArray(this.manifest.projects), "backup manifest mismatch");
    const packages = input.channel === "prod" ? this.manifest.packages ?? [] : this.manifest.projects.flatMap(project => project.agents.map(agent => ({
      path: `derived-packages/${agent.id}.history.ponderosa.json`
    })));
    for (const item of packages) {
      const pack = this.read<{
        schema: string;
        mode: string;
        agents: PortableAgent[];
      }>(item.path);
      requireValue(pack.schema === "ponderosa.agent-package.v1" && pack.mode === "full", "full native history package required");
      for (const agent of pack.agents) {
        requireValue(!this.portable.has(agent.ref), "duplicate exported Agent identity");
        this.portable.set(agent.ref, agent);
      }
    }
  }
  file(path: string): string {
    requireValue(this.files.has(path), `source file is not indexed: ${path}`);
    return checkedPath(this.root, path);
  }
  read<T>(path: string): T {
    return JSON.parse(readFileSync(this.file(path), "utf8")) as T;
  }
}
function namespaceId(channel: string, project: string, chat: string): string {
  const h = digest(Buffer.from(`ponderosa-content-restore\0${channel}\0${project}\0${chat}`));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function assetReference<T extends CommunicationAttachmentDto>(asset: T, projectId: string): T {
  if (![asset.url, asset.previewUrl, asset.downloadUrl].some(url => url?.startsWith("/api/projects/")))
    return asset;
  const root = `/api/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(asset.id)}`;
  return {
    ...asset,
    url: `${root}/preview`,
    previewUrl: `${root}/preview`,
    downloadUrl: `${root}/download`
  };
}
function currentEventReferences(event: CommunicationEvent): CommunicationEvent {
  const document = event.document as CommunicationDocumentReference | undefined;
  let record: CommunicationEvent["document"];
  if (document) {
    const { previewUrl: _preview, downloadUrl: _download, ...authored } = document;
    record = authored;
  }
  return {
    ...event,
    ...(event.attachments ? {
      attachments: event.attachments.map(asset => assetReference(asset, event.projectId))
    } : {}),
    ...(record ? {
      document: record
    } : {})
  } as CommunicationEvent;
}
function normalizeAudience(event: CommunicationEvent, projectId: string): CommunicationEvent {
  return {
    ...event,
    schemaVersion: 2,
    projectId,
    ...(event.intent === "broadcast" ? {
      audience: {
        kind: "organization",
        organizationId: projectId
      }
    } : {})
  } as CommunicationEvent;
}
function projectedMessage(message: ConversationMessageDto, eventId: string, surface: CommunicationProjection["surface"], chatId: string): CommunicationProjection {
  return {
    eventId,
    surface,
    projectionKey: chatId,
    projectedAt: message.createdAt,
    revision: 2,
    message: {
      messageId: message.id,
      role: message.role,
      renderedText: message.text,
      createdAt: message.createdAt,
      ...(message.canonicalOrderKey ? {
        orderKey: message.canonicalOrderKey
      } : {}),
      ...(message.authorAgentId ? {
        authorAgentId: message.authorAgentId
      } : {}),
      ...(message.attachments?.length ? {
        attachments: message.attachments,
        attachmentIds: message.attachments.map(asset => asset.id)
      } : {})
    }
  };
}
function prodEvent(message: ConversationMessageDto, projectId: string, conversationId: string): CommunicationEvent {
  const eventId = message.communicationEventId ?? message.id;
  requireValue(message.communicationIntent === "broadcast" || message.communicationIntent === "user_dm" || message.communicationIntent === "collaboration", "shared message lacks explicit communication intent");
  const sender = message.authorAgentId ? {
    kind: "agent" as const,
    agentId: message.authorAgentId,
    ...(message.executionId ? {
      executionId: message.executionId
    } : {})
  } : message.role === "system" ? {
    kind: "system" as const,
    component: "restored-authored-notice"
  } : {
    kind: "user" as const,
    userId: "local-operator"
  };
  const base = {
    schemaVersion: 2 as const,
    eventId,
    projectId,
    conversationId,
    sender,
    text: message.text,
    createdAt: message.createdAt,
    ...(message.attachments?.length ? {
      attachments: message.attachments.map(asset => {
        requireValue(new Set<string>(ASSET_MEDIA_TYPES).has(asset.mediaType), "unsupported source upload media type");
        return {
          ...asset,
          mediaType: asset.mediaType as AssetDto["mediaType"],
          unavailable: true
        };
      })
    } : {}),
    ...(message.document ? {
      document: message.document
    } : {}),
    ...(message.citations?.length ? {
      citations: message.citations
    } : {})
  };
  if (message.communicationIntent === "broadcast")
    return {
      ...base,
      intent: "broadcast",
      audience: {
        kind: "organization",
        organizationId: projectId
      }
    };
  requireValue(message.communicationIntent === "user_dm", "production Collaboration export lacks a canonical audience; refuse to infer it");
  const ids = (message.directMessageAgents ?? []).map(agent => agent.id);
  requireValue(ids.length > 0 || sender.kind === "system", "DM recipient identity missing");
  return {
    ...base,
    intent: "user_dm",
    audience: ids.length === 0 ? {
      kind: "user",
      userId: "local-operator"
    } : ids.length === 1 ? {
      kind: "user_agent",
      userId: "local-operator",
      agentId: ids[0]!
    } : {
      kind: "user_agents",
      userId: "local-operator",
      agentIds: ids as [
        string,
        ...string[]
      ]
    }
  };
}
function planNamespaces(sources: Source[]): Namespace[] {
  const chats = new Set<string>(), agents = new Set<string>(), namespaces = new Set<string>();
  const result: Namespace[] = [];
  for (const source of sources) {
    let sourceChats = 0, sourceAgents = 0;
    for (const project of source.manifest.projects) {
      const content = source.input.channel === "dev" ? source.read<ContentProject>(`projects/${safeId(project.project.id)}/project-content.json`) : undefined;
      for (const recorded of project.conversations) {
        safeId(recorded.id);
        requireValue(!chats.has(recorded.id), "Chat identity collision");
        chats.add(recorded.id);
        sourceChats++;
        const chat = source.read<ChatArchive>(`chats/${recorded.id}/chat-archive.json`);
        requireValue(chat.historyCompleteAtRead && chat.originalChat.id === recorded.id && chat.originalChat.projectId === project.project.id, "Chat archive scope/integrity mismatch");
        const id = project.conversations.length === 1 ? project.project.id : namespaceId(source.input.channel, project.project.id, recorded.id);
        safeId(id);
        requireValue(!namespaces.has(id), "namespace identity collision");
        namespaces.add(id);
        const owned = project.agents.filter(agent => agent.conversationId === recorded.id);
        for (const agent of owned) {
          safeId(agent.id);
          requireValue(!agents.has(agent.id) && agent.projectId === project.project.id && source.portable.has(agent.id), "Agent collision, scope mismatch, or incomplete history package");
          agents.add(agent.id);
          sourceAgents++;
        }
        const ownedIds = new Set(owned.map(agent => agent.id));
        for (const agent of owned)
          requireValue(!agent.managerAgentId || ownedIds.has(agent.managerAgentId), "manager relationship crosses retained Chat scope");
        let events: CommunicationEvent[], revisions: Namespace["revisions"], projections: CommunicationProjection[];
        if (content) {
          events = content.communicationEvents.filter(event => event.conversationId === recorded.id || (!event.conversationId && project.conversations.length === 1)).map(event => ({
            ...normalizeAudience(event, id),
            conversationId: recorded.id
          }));
          const eventIds = new Set(events.map(event => event.eventId));
          revisions = content.communicationRevisions.filter(revision => eventIds.has(revision.eventId));
          projections = content.communicationProjections.filter(projection => eventIds.has(projection.eventId));
          requireValue(events.every(isCommunicationEvent), "invalid canonical communication record");
        }
        else {
          const messages = [...chat.messages, ...(chat.collaborationMessages ?? [])];
          events = messages.map(message => prodEvent(message, id, recorded.id));
          revisions = [];
          projections = messages.flatMap(message => {
            const event = events.find(candidate => candidate.eventId === (message.communicationEventId ?? message.id))!;
            return deriveCommunicationBehavior(event).projectionTargets
              .filter(target => !["direct_agent_audit", "agent_inbox"].includes(target.surface) || ownedIds.has(target.projectionKey))
              .map(target => projectedMessage(message, event.eventId, target.surface, target.projectionKey));
          });
        }
        const uniqueEvents = new Map<string, CommunicationEvent>();
        for (const event of events) {
          const prior = uniqueEvents.get(event.eventId);
          requireValue(!prior || JSON.stringify(prior) === JSON.stringify(event), "conflicting authored event identity");
          uniqueEvents.set(event.eventId, event);
        }
        projections = projections.map(projection => ({
          ...projection,
          ...(projection.message?.attachments ? {
            message: {
              ...projection.message,
              attachments: projection.message.attachments.map(asset => assetReference(asset, id))
            }
          } : {})
        }));
        result.push({
          source,
          original: project,
          chat,
          id,
          agents: owned,
          events: [...uniqueEvents.values()].map(currentEventReferences),
          revisions,
          projections
        });
      }
    }
    requireValue(sourceChats === source.manifest.conversationCount && sourceAgents === source.manifest.agentCount && source.portable.size === sourceAgents, "backup scope or package coverage count mismatch");
    if (source.manifest.backupScope)
      requireValue([...source.manifest.backupScope.retainedChatIds].sort().join() === source.manifest.projects.flatMap(project => project.conversations.map(chat => chat.id)).sort().join(), "retained folder scope differs from archived Chats");
  }
  return result;
}
function folderPlan(namespaces: Namespace[]): ChatFolderDto[] {
  const byName = new Map<string, ChatFolderDto>();
  const add = (folder: ChatFolderDto) => {
    const prior = byName.get(folder.name);
    if (prior) {
      prior.conversationIds = [...new Set([...prior.conversationIds, ...folder.conversationIds])];
      prior.starred ||= folder.starred;
    }
    else
      byName.set(folder.name, {
        ...folder,
        conversationIds: [...folder.conversationIds]
      });
  };
  for (const source of new Set(namespaces.map(item => item.source))) {
    if (source.input.channel === "dev")
      for (const folder of source.read<{
        folders: ChatFolderDto[];
      }>("folder-scope.json").folders)
        add(folder);
    else
      for (const project of source.manifest.projects)
        add({
          id: namespaceId("folder", project.project.id, project.project.label),
          name: project.project.label,
          conversationIds: project.conversations.map(chat => chat.id),
          expanded: true
        });
  }
  const retained = new Set(namespaces.map(item => item.chat.originalChat.id));
  const filed = [...byName.values()].flatMap(folder => folder.conversationIds);
  // Unfiled Chats are valid. Folder membership must still be unique and stay
  // inside the independently verified retained Chat scope.
  requireValue(new Set(filed).size === filed.length && filed.every(id => retained.has(id)), "folder membership differs from restored Chat scope");
  return [...byName.values()];
}
function copyIndexed(source: Source, path: string, target: string): void {
  mkdirSync(dirname(target), {
    recursive: true
  });
  copyFileSync(source.file(path), target);
  const expected = source.files.get(path)!;
  requireValue(hashFile(target).sha256 === expected.sha256, "copied asset checksum mismatch");
}
function normalizeAccess(access: ManagedArtifactAccess | undefined, artifactId: string, namespace: Namespace): ManagedArtifactAccess {
  requireValue(access, `artifact access is not recorded: ${artifactId}`);
  return {
    ...access,
    audience: access.audience.kind === "organization" ? {
      kind: "organization",
      organizationId: namespace.id
    } : access.audience
  };
}
export function restoreContent(options: ContentRestoreOptions): Record<string, unknown> {
  requireValue(options.sources.length > 0 && options.sources.length <= 2 && new Set(options.sources.map(source => source.channel)).size === options.sources.length, "one backup per environment is required");
  const output = resolve(options.output);
  requireValue(!existsSync(output) && lstatSync(dirname(output)).isDirectory(), "restore target must be nonexistent with an existing parent");
  const sources = options.sources.map(source => new Source(source));
  const namespaces = planNamespaces(sources), folders = folderPlan(namespaces);
  requireValue(sources.every(source => !output.startsWith(source.root + sep) && !source.root.startsWith(output + sep)), "target overlaps a backup");
  const supplemental: Array<{
    namespace: Namespace;
    path: string;
    event: Extract<ManagedArtifactEvent, {
      type: "created";
    }>;
  }> = [];
  if (options.documentSupplement) {
    const root = resolve(options.documentSupplement.directory), file = checkedPath(root, "manifest.json");
    requireValue(hashFile(file).sha256 === options.documentSupplement.manifestSha256, "document supplement checksum mismatch");
    const manifest = JSON.parse(readFileSync(file, "utf8")) as {
      files: Array<IndexedFile & {
        id: string;
        projectId: string;
        canonicalCreatedRecords: Array<Extract<ManagedArtifactEvent, {
          type: "created";
        }>>;
      }>;
    };
    for (const item of manifest.files) {
      const path = checkedPath(root, item.path), actual = hashFile(path);
      requireValue(actual.bytes === item.bytes && actual.sha256 === item.sha256 && item.canonicalCreatedRecords.length === 1, "document supplement entry mismatch");
      const event = item.canonicalCreatedRecords[0]!, namespace = namespaces.find(candidate => candidate.source.input.channel === "dev" && candidate.original.project.id === item.projectId && candidate.events.some(record => record.document?.artifactId === item.id));
      requireValue(namespace && event.artifact.id === item.id && event.artifact.sha256 === item.sha256, "supplement document is outside retained authored scope");
      supplemental.push({
        namespace,
        path,
        event
      });
    }
  }
  const recoveredUploads = new Map<string, {
    namespace: Namespace;
    asset: AssetDto;
    path: string;
    associatedAt: string;
  }>();
  if (options.uploadSupplement) {
    const root = resolve(options.uploadSupplement.directory), file = checkedPath(root, "manifest.json");
    requireValue(hashFile(file).sha256 === options.uploadSupplement.manifestSha256, "upload supplement checksum mismatch");
    const manifest = JSON.parse(readFileSync(file, "utf8")) as {
      files: Array<IndexedFile & {
        id?: string;
        assetId?: string;
      }>;
    };
    for (const item of manifest.files) {
      const id = item.id ?? item.assetId;
      requireValue(id && !recoveredUploads.has(id), "duplicate or missing recovered upload identity");
      const references = namespaces.filter(namespace => namespace.source.input.channel === "prod").flatMap(namespace => namespace.chat.messages.flatMap(message => (message.attachments ?? []).filter(asset => asset.id === id).map(asset => ({
        namespace,
        asset,
        associatedAt: message.createdAt
      }))));
      const reference = references[0];
      requireValue(reference && references.every(item => item.namespace === reference.namespace && item.asset.sha256 === reference.asset.sha256 && item.asset.size === reference.asset.size), "recovered upload has ambiguous source scope");
      const path = checkedPath(root, item.path), actual = hashFile(path);
      requireValue(actual.bytes === item.bytes && actual.sha256 === item.sha256 && actual.bytes === reference.asset.size && actual.sha256 === reference.asset.sha256, "recovered upload checksum differs from original authored reference");
      requireValue((reference.asset.mediaType === "image/png" || reference.asset.mediaType === "image/jpeg") && reference.namespace.agents.some(agent => agent.id === reference.asset.agentId), "recovered upload owner is not retained");
      recoveredUploads.set(id, {
        ...reference,
        asset: reference.asset as AssetDto,
        path
      });
    }
    for (const namespace of namespaces) {
      if (namespace.source.input.channel !== "prod") continue;
      namespace.events = namespace.events.map(event => ({
        ...event,
        ...(event.attachments ? {
          attachments: event.attachments.map(asset => ({
            ...asset,
            unavailable: !recoveredUploads.has(asset.id)
          }))
        } : {})
      } as CommunicationEvent));
      namespace.projections = namespace.projections.map(projection => ({
        ...projection,
        ...(projection.message?.attachments ? {
          message: {
            ...projection.message,
            attachments: projection.message.attachments.map(asset => ({
              ...asset,
              unavailable: !recoveredUploads.has(asset.id)
            }))
          }
        } : {})
      }));
    }
  }
  // Bootstrap the empty current root first. No source SQLite, schema marker,
  // scheduler receipt, browser permission, session or credential is copied.
  const stage = join(dirname(output), `.${randomUUID()}.content-restore`);
  mkdirSync(stage, {
    mode: 0o700
  });
  const empty = new AgentStore(stage);
  empty.close();
  const retainedArtifactIds = new Map<string, string[]>();
  let artifactCount = 0, artifactBytes = 0, privateHistoryCount = 0;
  const generatedArtifacts: RestoredGeneratedArtifact[] = [];
  const documentArtifacts: RestoredDocumentArtifact[] = [];
  const recoveredUploadMetadata: Array<Record<string, unknown>> = [];
  const metadataNormalizations: Array<Record<string, string>> = [];
  const missingUploads: Array<Record<string, unknown>> = [];
  for (const namespace of namespaces) {
    const { source, original, id, chat } = namespace, conversation = chat.detail?.conversation ?? chat.originalChat, projectRoot = join(stage, "projects", id);
    writeJson(join(projectRoot, "project.json"), {
      id,
      ownerConversationId: conversation.id,
      label: conversation.title,
      hostPath: conversation.workingDirectory ?? original.project.hostPath,
      createdAt: original.project.createdAt,
      defaultEngine: conversation.defaultEngine ?? original.project.defaultEngine,
      lastConversationId: conversation.id
    });
    writeJson(join(projectRoot, "conversations", conversation.id, "conversation.json"), {
      id: conversation.id,
      projectId: id,
      title: conversation.title,
      workingDirectory: conversation.workingDirectory ?? original.project.hostPath,
      instructions: conversation.instructions ?? "",
      defaultEngine: conversation.defaultEngine ?? original.project.defaultEngine,
      defaultModel: conversation.defaultModel,
      defaultEffort: conversation.defaultEffort,
      defaultSpeed: conversation.defaultSpeed,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt
    });
    for (const agent of namespace.agents) {
      const portable = source.portable.get(agent.id)!, dir = join(projectRoot, "agents", agent.id), workingCopy = agent.workingCopy?.mode === "shared" ? {
        ...agent.workingCopy,
        id: `shared:${id}`,
        rootPath: conversation.workingDirectory ?? original.project.hostPath
      } : agent.workingCopy;
      writeJson(join(dir, "agent.json"), {
        id: agent.id,
        projectId: id,
        conversationId: conversation.id,
        title: agent.title,
        handle: agent.handle,
        activeEngine: agent.activeEngine,
        model: agent.model,
        effort: agent.effort,
        speed: agent.speed,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
        managementPermissions: agent.managementPermissions,
        presetSnapshot: agent.presetSnapshot,
        workingCopy
      });
      const messages = portable.history ?? [];
      privateHistoryCount += messages.length;
      writeJson(join(dir, "imported-history.json"), {
        source: `Restored ${source.input.channel} private reference history; original routing is only in canonical communication`,
        importedAt: new Date().toISOString(),
        messages,
        ...(portable.initialInstructions ? {
          initialInstructions: portable.initialInstructions
        } : {})
      });
      if (source.input.channel === "dev") {
        const prefix = `canonical-state/projects/${original.project.id}/agents/${agent.id}/attachments/`;
        for (const path of source.files.keys())
          if (path.startsWith(prefix))
            copyIndexed(source, path, join(dir, "attachments", safeRelative(path.slice(prefix.length))));
      }
      appendFsyncedJsonl(join(projectRoot, "agent-organization.jsonl"), [
        {
          type: "manager_changed",
          eventId: `restore-manager:${source.input.channel}:${agent.id}`,
          projectId: id,
          agentId: agent.id,
          managerAgentId: agent.managerAgentId ?? null,
          createdAt: agent.updatedAt
        }
      ]);
    }
    for (const [assetId, recovered] of recoveredUploads)
      if (recovered.namespace === namespace) {
        const dir = join(projectRoot, "agents", safeId(recovered.asset.agentId), "attachments");
        mkdirSync(dir, {
          recursive: true
        });
        copyFileSync(recovered.path, join(dir, `${safeId(assetId)}.bin`));
        const previewFile = `${assetId}.preview.png`;
        const originalBytes = readFileSync(recovered.path);
        const previewBytes = recovered.asset.mediaType === "image/jpeg"
          ? (() => {
            requireValue(options.encodePngPreview, "JPEG uploads require the current PNG preview encoder");
            return options.encodePngPreview(originalBytes);
          })() : originalBytes;
        requireValue(Buffer.from(previewBytes).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "upload preview must contain PNG bytes");
        writeFileSync(join(dir, previewFile), previewBytes);
        const name = recovered.asset.mediaType === "image/jpeg" && !/\.jpe?g$/iu.test(recovered.asset.name)
          ? recovered.asset.name.replace(/\.[^.]+$/u, "") + ".jpg" : recovered.asset.name;
        const base = `/api/agents/${encodeURIComponent(recovered.asset.agentId)}/assets/${assetId}`;
        requireValue(Number.isFinite(Date.parse(recovered.associatedAt)), "upload lacks an explicit authored association time");
        writeJson(join(dir, `${assetId}.json`), {
          id: assetId, projectId: id, agentId: recovered.asset.agentId,
          name, mediaType: recovered.asset.mediaType, size: recovered.asset.size,
          width: recovered.asset.width, height: recovered.asset.height,
          sha256: recovered.asset.sha256, createdAt: recovered.asset.createdAt ?? recovered.associatedAt,
          state: "associated", associatedAt: recovered.associatedAt,
          originalFile: `${assetId}.bin`, previewFile,
          url: `/api/agents/${encodeURIComponent(recovered.asset.agentId)}/attachments/${assetId}`,
          downloadUrl: `${base}/download`, previewUrl: `${base}/preview`
        });
        recoveredUploadMetadata.push({ id: assetId, projectId: id, agentId: recovered.asset.agentId,
          originalName: recovered.asset.name, currentName: name,
          associatedAt: recovered.associatedAt, previewSha256: digest(previewBytes), previewBytes: previewBytes.length });
      }
    appendFsyncedJsonl(join(projectRoot, "communication-events.jsonl"), namespace.events);
    appendFsyncedJsonl(join(projectRoot, "communication-revisions.jsonl"), namespace.revisions);
    appendFsyncedJsonl(join(projectRoot, "communication-projections.jsonl"), namespace.projections);
    const seenArtifacts = new Set<string>();
    const publish = (artifact: ArtifactDto & {
      projectId: string;
      originAgentId: string;
    }, access: ManagedArtifactAccess, bytes?: Uint8Array, from?: string) => {
      safeId(artifact.id);
      requireValue(!seenArtifacts.has(artifact.id), "artifact identity collision");
      seenArtifacts.add(artifact.id);
      const target = join(projectRoot, "artifacts", "content", managedArtifactStorageFilename(artifact.id));
      mkdirSync(dirname(target), {
        recursive: true
      });
      if (from)
        copyFileSync(from, target);
      else
        writeFileSync(target, bytes!);
      const actual = hashFile(target);
      requireValue(actual.sha256 === artifact.sha256 && actual.bytes === artifact.size, "restored artifact checksum mismatch");
      const { previewUrl: _preview, downloadUrl: _download, ...current } = artifact;
      if (current.kind === "generated_file") {
        if (current.path.endsWith(".log") && current.summary?.endsWith(".log") &&
            current.mediaType === "application/octet-stream") {
          new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(target));
          metadataNormalizations.push({ projectId: id, artifactId: current.id,
            field: "mediaType", original: current.mediaType, current: "text/plain" });
          current.mediaType = "text/plain";
        }
        requireValue(current.mediaType && current.summary && current.size !== undefined && current.sha256,
          "generated artifact lacks required current registry metadata");
        generatedArtifacts.push({ ...current, projectId: id } as RestoredGeneratedArtifact);
      }
      const authoredDocument = namespace.events.find(event => event.document?.artifactId === current.id);
      if (authoredDocument?.document) {
        const document = authoredDocument.document;
        const authorValid = authoredDocument.sender.kind === "agent"
          ? document.authorAgentId === authoredDocument.sender.agentId && document.executionId === authoredDocument.sender.executionId && !document.authorUserId
          : authoredDocument.sender.kind === "user" && document.authorUserId === authoredDocument.sender.userId && !document.authorAgentId && !document.executionId;
        if (document.authorAgentId && current.executionId === undefined &&
            current.originAgentId === document.authorAgentId && current.agentId === document.authorAgentId) {
          current.executionId = document.executionId;
          metadataNormalizations.push({ projectId: id, artifactId: current.id,
            field: "executionId", original: "absent from portable artifact", current: document.executionId! });
        }
        requireValue(authorValid && /^text-[a-f0-9]{64}$/u.test(document.id) && document.artifactId === document.id &&
          current.kind === "document" && current.path === `communication/${document.id}.md` && current.summary === document.title &&
          current.mediaType === "text/markdown" && document.mediaType === "text/markdown" && current.size === document.byteLength &&
          (document.authorAgentId ? current.originAgentId === document.authorAgentId && current.agentId === document.authorAgentId && current.executionId === document.executionId : current.agentId === current.originAgentId && !current.executionId),
          `communication document metadata disagrees with its explicit author or managed bytes: ${current.id}`);
        const expectedAccess = { ownerKind: "communication", ownerId: authoredDocument.eventId,
          audience: authoredDocument.audience, ...(authoredDocument.sender.kind === "agent" ? { senderAgentId: authoredDocument.sender.agentId } : {}) };
        requireValue(JSON.stringify(access) === JSON.stringify(expectedAccess), "communication document audience differs from authored event");
        documentArtifacts.push({ id: document.id, projectId: id, role: "document", title: document.title,
          mediaType: "text/markdown", blobPath: document.id, blobHash: actual.sha256, byteLength: actual.bytes,
          createdAt: document.createdAt, ...(document.authorAgentId ? { originAgentId: document.authorAgentId, executionId: document.executionId } : {}) });
      }
      appendFsyncedJsonl(join(projectRoot, "artifacts", "artifacts.jsonl"), [{
          type: "created",
          artifact: {
            ...current,
            projectId: id
          },
          access
        }]);
      const originIds = retainedArtifactIds.get(artifact.originAgentId) ?? [];
      originIds.push(artifact.id);
      retainedArtifactIds.set(artifact.originAgentId, originIds);
      artifactCount++;
      artifactBytes += actual.bytes;
    };
    if (source.input.channel === "dev") {
      const metadata = source.read<SidecarArtifact[]>("artifact-inventory.json");
      const recordsPath = `canonical-state/projects/${original.project.id}/artifacts/artifacts.jsonl`;
      const records = readFileSync(source.file(recordsPath), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Extract<ManagedArtifactEvent, {
        type: "created";
      }>);
      const byId = new Map(records.map(record => [record.artifact.id, record]));
      for (const artifact of metadata.filter(item => item.projectId === original.project.id && namespace.agents.some(agent => agent.id === item.originAgentId))) {
        const record = byId.get(artifact.id);
        requireValue(record?.type === "created", "managed artifact canonical metadata missing");
        publish({
          ...record.artifact,
          projectId: id
        }, normalizeAccess(record.access, artifact.id, namespace), undefined, source.file(artifact.sidecarPath));
      }
    }
    else
      for (const agent of namespace.agents)
        for (const artifact of source.portable.get(agent.id)!.artifacts ?? []) {
          if (seenArtifacts.has(artifact.ref))
            continue;
          const bytes = Buffer.from(artifact.dataBase64, "base64");
          publish({
            id: artifact.ref,
            projectId: id,
            agentId: agent.id,
            originAgentId: agent.id,
            kind: artifact.kind,
            path: artifact.path,
          sourcePath: artifact.sourcePath,
            summary: artifact.summary,
            createdAt: artifact.createdAt,
            mediaType: artifact.mediaType ?? "application/octet-stream",
            visibility: artifact.visibility ?? "project",
            pinned: artifact.pinned ?? false,
            size: bytes.length,
            sha256: digest(bytes)
          }, (() => {
            const authored = namespace.events.find(event => event.document?.artifactId === artifact.ref || event.attachments?.some(asset => asset.id === artifact.ref));
            return authored ? {
              ownerKind: "communication" as const,
              ownerId: authored.eventId,
              audience: authored.audience,
              ...(authored.sender.kind === "agent" ? {
                senderAgentId: authored.sender.agentId
              } : {})
            } : {
              ownerKind: "project" as const,
              ownerId: artifact.ref,
              audience: {
                kind: "agents" as const,
                agentIds: [agent.id]
              }
            };
          })(), bytes);
        }
    for (const item of supplemental.filter(item => item.namespace === namespace))
      publish({
        ...item.event.artifact,
        projectId: id
      }, normalizeAccess(item.event.access, item.event.artifact.id, namespace), undefined, item.path);
    if (source.input.channel === "prod")
      for (const message of chat.messages)
        for (const asset of message.attachments ?? [])
          if (!recoveredUploads.has(asset.id))
            missingUploads.push({
              source: "prod",
              conversationId: conversation.id,
              messageId: message.id,
              ...asset,
              unavailable: true
            });
  }
  for (const namespace of namespaces) for (const agent of namespace.agents) {
    const offset = retainedArtifactHighWater(agent.id, retainedArtifactIds.get(agent.id) ?? []);
    if (offset) writeJson(artifactSequencePath(stage, namespace.id, agent.id), { fromSeq: 1, offset });
  }
  const restored = new AgentStore(stage);
  try {
    if (generatedArtifacts.length) {
      requireValue(options.registerGeneratedArtifacts, "generated artifact registry writer is required before publication");
      restored.sqlite.transaction(() => {
        options.registerGeneratedArtifacts!(stage, generatedArtifacts);
        const registered = restored.sqlite.prepare("SELECT count(*) AS count FROM generated_artifact_authority").get() as { count: number };
        requireValue(registered.count === generatedArtifacts.length, "generated artifact registry coverage mismatch");
      }).immediate();
    }
    if (documentArtifacts.length) {
      requireValue(options.registerDocumentArtifacts, "document artifact registry writer is required before publication");
      restored.sqlite.transaction(() => {
        options.registerDocumentArtifacts!(stage, documentArtifacts);
        const registered = restored.sqlite.prepare("SELECT count(*) AS count FROM runtime_artifact_authority").get() as { count: number };
        requireValue(registered.count === documentArtifacts.length, "document artifact registry coverage mismatch");
      }).immediate();
    }
    if (recoveredUploads.size) {
      requireValue(options.validateRecoveredUploads, "current recovered upload validator is required before publication");
      options.validateRecoveredUploads(stage, [...recoveredUploads].map(([id, upload]) => ({
        id, projectId: upload.namespace.id, agentId: upload.asset.agentId
      })));
    }
    requireValue(restored.startupProfile().recoveryIssues.length === 0 && restored.listProjects().length === namespaces.length, "restored projection has recovery issues");
    for (const namespace of namespaces) {
      requireValue(restored.reconcileCommunicationEvents(namespace.id).ok, "restored authored projections are inconsistent");
      requireValue(restored.listAgents(namespace.id).length === namespace.agents.length, "Agent projection coverage mismatch");
      for (const agent of restored.listAgents(namespace.id))
        requireValue(Object.keys(agent.state).length === 0, "restored Agent has runtime authority");
      for (const [channel, messages] of [["main", namespace.chat.messages], ["collaboration", namespace.chat.collaborationMessages ?? []]] as const) {
        const actual = new Map(restored.getConversationMessages(namespace.chat.originalChat.id, channel).map(message => [message.id, message]));
        for (const expected of messages) {
          const message = actual.get(expected.id);
          requireValue(message && message.text === expected.text && message.authorAgentId === expected.authorAgentId, `authored Chat timeline changed: ${namespace.chat.originalChat.id}/${expected.id}`);
        }
      }
    }
    for (const table of [
      "scheduler_runs", "scheduler_run_activations", "agent_activations", "coordination_requests", "coordination_request_updates", "provider_inputs", "provider_operation_outbox", "activation_outbox", "communication_v4_next_run_deliveries", "communication_v4_next_run_recipients", "generated_artifact_import_receipts"
    ]) {
      requireValue((restored.sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {
        count: number;
      }).count === 0, `restored runtime table is not empty: ${table}`);
    }
    requireValue(!restored.sqlite.prepare("SELECT 1 FROM agents WHERE active_session_id IS NOT NULL LIMIT 1").get(), "restored provider session authority");
  }
  finally {
    restored.close();
  }
  const workspace = new WorkspaceStore(stage);
  try {
    workspace.updatePreferences({
      chatFolders: folders,
      chatOrder: namespaces.map(item => item.chat.originalChat.id)
    });
  }
  finally {
    workspace.close();
  }
  const receipt = {
    schema: "ponderosa.content-restore-receipt.v1",
    createdAt: new Date().toISOString(),
    sources: options.sources.map(source => ({
      channel: source.channel,
      indexSha256: source.indexSha256
    })),
    supplements: {
      documentManifestSha256: options.documentSupplement?.manifestSha256,
      uploadManifestSha256: options.uploadSupplement?.manifestSha256
    },
    chatCount: namespaces.length,
    agentCount: namespaces.reduce((sum, item) => sum + item.agents.length, 0),
    privateHistoryCount,
    artifactCount,
    artifactBytes,
    generatedArtifactRegistryCount: generatedArtifacts.length,
    documentArtifactRegistryCount: documentArtifacts.length,
    recoveredUploadMetadata,
    metadataNormalizations,
    recoveredUploadCount: recoveredUploads.size,
    folders,
    namespaces: namespaces.map(item => ({
      source: item.source.input.channel,
      originalProjectId: item.original.project.id,
      projectId: item.id,
      conversationId: item.chat.originalChat.id,
      agentIds: item.agents.map(agent => agent.id)
    })),
    missingUploads,
    runtimeAuthorityRestored: false,
    limitations: [
      "Private portable history retains recorded role/text/time; absent original private routing is not invented.", "Production shared revisions retain the latest exported text; absent earlier edits are not invented.", "Production upload bytes omitted by the native exporter remain unavailable references."
    ]
  };
  writeJson(join(stage, "content-restore-receipt.json"), receipt);
  requireValue(!existsSync(output), "target appeared during restore");
  renameSync(stage, output);
  return receipt;
}

import { createHash } from "node:crypto";
import type { CommunicationEvent } from "@ponderosa/core";
import {
  LONG_TEXT_MAX_UTF8_BYTES,
  canonicalizeProviderText,
  shouldBackTextWithArtifact,
} from "@ponderosa/core";
import {
  publishManagedArtifactContentAsync,
  type AgentStore,
  type CoordinationV3Store,
  type ManagedArtifactAccess,
} from "@ponderosa/agents";
import { AssetError, type AssetStore } from "./assets.js";
import { boundedUtf8Preview } from "./static-content.js";
import type { PreparedCommunicationArtifact } from "./routes/conversation-deliveries.js";

const OPERATOR_MESSAGE_PREVIEW_UTF8_BYTES = 4_000;

interface CommunicationArtifactContext {
  dataDir: string;
  assets: AssetStore;
  store: AgentStore;
}

export function createCommunicationArtifactAuthority(context: CommunicationArtifactContext) {
  const { dataDir, assets, store } = context;

  const runtimeArtifactMetadata = (artifact: PreparedCommunicationArtifact) => ({
    id: artifact.id,
    role: artifact.role,
    title: artifact.title,
    mediaType: artifact.mediaType,
    blobPath: artifact.blobPath,
    blobHash: artifact.blobHash,
    byteLength: artifact.byteLength,
    ...(artifact.originAgentId ? { originAgentId: artifact.originAgentId } : {}),
    ...(artifact.executionId ? { executionId: artifact.executionId } : {}),
  });

  const communicationArtifactAccess = (
    communication: CommunicationEvent,
  ): ManagedArtifactAccess => ({
    ownerKind: "communication",
    ownerId: communication.eventId,
    audience: communication.audience,
    ...(communication.sender.kind === "agent"
      ? { senderAgentId: communication.sender.agentId }
      : {}),
  });

  const requestArtifactAccess = (
    ownerId: string,
    request: NonNullable<ReturnType<CoordinationV3Store["getRequest"]>>,
  ): ManagedArtifactAccess => ({
    ownerKind: "request_update",
    ownerId,
    audience: {
      kind: "request_agents",
      agentIds: [
        ...new Set([
          ...(request.requesterAgentId ? [request.requesterAgentId] : []),
          request.recipientAgentId,
        ]),
      ].sort(),
      ...(!request.requesterAgentId ? { userId: "local-operator" } : {}),
    },
  });

  const stageCommunicationArtifact = async (input: {
    projectId: string;
    communicationId: string;
    role: PreparedCommunicationArtifact["role"];
    title: string;
    content: string;
    originAgentId?: string;
    executionId?: string;
    createdAt: string;
  }): Promise<PreparedCommunicationArtifact> => {
    const content = Buffer.from(input.content, "utf8");
    if (content.length > LONG_TEXT_MAX_UTF8_BYTES) {
      throw new AssetError(413, "long text exceeds the 8 MiB limit");
    }
    const id = `text-${createHash("sha256")
      .update(`${input.communicationId}\0${input.role}`)
      .digest("hex")}`;
    const published = await publishManagedArtifactContentAsync(
      dataDir,
      input.projectId,
      id,
      content,
    );
    const blobHash = published.sha256;
    const artifact: PreparedCommunicationArtifact = {
      id,
      role: input.role,
      title: input.title,
      mediaType: "text/markdown",
      blobPath: id,
      blobHash,
      byteLength: content.length,
      createdAt: input.createdAt,
      ...(input.originAgentId ? { originAgentId: input.originAgentId } : {}),
      ...(input.executionId ? { executionId: input.executionId } : {}),
    };
    const registered = assets.registerRuntimeArtifact({
      ...artifact,
      projectId: input.projectId,
    });
    return { ...artifact, createdAt: registered.createdAt };
  };

  const projectCommunicationArtifact = (
    projectId: string,
    fallbackAgentId: string,
    artifact: PreparedCommunicationArtifact,
    access: ManagedArtifactAccess,
  ): void => {
    const authoritative = assets.authoritativeRuntimeArtifact(
      projectId,
      runtimeArtifactMetadata(artifact),
    );
    if (
      !authoritative ||
      authoritative.contentHash !== artifact.blobHash ||
      authoritative.byteLength !== artifact.byteLength
    ) {
      throw new Error("runtime artifact changed after scheduler admission");
    }
    if (store.getProjectArtifact(projectId, artifact.id)) return;
    store.recordProjectArtifact(
      {
        id: artifact.id,
        projectId,
        agentId: artifact.originAgentId ?? fallbackAgentId,
        originAgentId: artifact.originAgentId ?? fallbackAgentId,
        ...(artifact.executionId ? { executionId: artifact.executionId } : {}),
        kind: "document",
        path: `communication/${artifact.id}.md`,
        summary: artifact.title,
        createdAt: artifact.createdAt,
        mediaType: artifact.mediaType,
        visibility: "project",
        pinned: false,
        size: artifact.byteLength,
        sha256: artifact.blobHash,
      },
      access,
    );
  };

  const prepareUserCommunicationText = async (input: {
    projectId: string;
    communicationId: string;
    text: string;
    createdAt: string;
  }): Promise<{
    canonicalText: string;
    publishedText: string;
    artifact?: PreparedCommunicationArtifact;
    document?: CommunicationEvent["document"];
  }> => {
    const canonicalText = canonicalizeProviderText(input.text).trim();
    if (Buffer.byteLength(canonicalText, "utf8") > LONG_TEXT_MAX_UTF8_BYTES) {
      throw new AssetError(413, "text exceeds the 8 MiB limit");
    }
    if (!shouldBackTextWithArtifact(canonicalText)) {
      return { canonicalText, publishedText: canonicalText };
    }
    const artifact = await stageCommunicationArtifact({
      projectId: input.projectId,
      communicationId: input.communicationId,
      role: "long_text",
      title: "Pasted text",
      content: canonicalText,
      createdAt: input.createdAt,
    });
    const preview = boundedUtf8Preview(
      Buffer.from(canonicalText, "utf8"),
      OPERATOR_MESSAGE_PREVIEW_UTF8_BYTES,
    )?.toString("utf8") ?? "";
    return {
      canonicalText,
      publishedText: `Message preview (first ${OPERATOR_MESSAGE_PREVIEW_UTF8_BYTES.toLocaleString("en-US")} UTF-8 bytes):\n${preview}\n\nFull message: ponderosa://artifact/${artifact.id}`,
      artifact,
      document: {
        id: artifact.id,
        artifactId: artifact.id,
        title: artifact.title,
        mediaType: "text/markdown",
        byteLength: artifact.byteLength,
        authorUserId: "local-operator",
        createdAt: input.createdAt,
      },
    };
  };

  return {
    communicationArtifactAccess,
    prepareUserCommunicationText,
    projectCommunicationArtifact,
    requestArtifactAccess,
    runtimeArtifactMetadata,
    stageCommunicationArtifact,
  };
}

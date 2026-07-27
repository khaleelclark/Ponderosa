import { Readable } from "node:stream";
import {
  openManagedArtifactContent,
  type AgentStore,
  type ManagedArtifactAsyncReadFaults,
  type ManagedArtifactContentHandle,
  type RuntimeArtifactInputV3,
  type StoredLogEvent,
} from "@ponderosa/agents";
import type { ArtifactDto } from "@ponderosa/core";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  type AssetStore,
  contentDisposition,
  managedArtifactDownloadName,
} from "../assets.js";
import {
  MAX_FILE_BYTES,
} from "../project-files.js";
import {
  readWorkspaceArtifactFile,
  type WorkspaceArtifactReadFaults,
} from "../project-file-access.js";
import {
  boundedUtf8Preview,
  contentTypeForArtifact,
} from "../static-content.js";
import {
  PROJECT_FILE_DOWNLOAD_WEIGHT,
  PROJECT_FILE_PREVIEW_WEIGHT,
  type ProjectFileAuthority,
} from "./project-files.js";

interface ArtifactRoutesContext {
  store: AgentStore;
  assets: AssetStore;
  dataDir: string;
  projectFileAuthority: ProjectFileAuthority;
  workspaceArtifactReadFaults?: WorkspaceArtifactReadFaults;
  managedArtifactReadFaults?: ManagedArtifactAsyncReadFaults;
  publish(agentId: string, event: StoredLogEvent): void;
  managedProjectArtifactAgreesWithRuntime(
    managed: ArtifactDto,
    runtime: RuntimeArtifactInputV3,
  ): boolean;
}

type GeneratedFile = {
  body?: Buffer;
  managed?: ManagedArtifactContentHandle;
  name: string;
  mediaType: string;
  size: number;
};

export function registerArtifactRoutes(
  app: FastifyInstance,
  context: ArtifactRoutesContext,
): void {
  const {
    store,
    assets,
    dataDir,
    projectFileAuthority,
    workspaceArtifactReadFaults,
    managedArtifactReadFaults,
    publish,
    managedProjectArtifactAgreesWithRuntime,
  } = context;

  app.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string } }>(
    "/api/agents/:id/artifacts",
    async (request, reply) => {
      if (!store.getAgent(request.params.id)) return reply.code(404).send({ error: "agent not found" });
      const limit = Math.min(500, Math.max(1, Number(request.query.limit ?? 100) || 100));
      try {
        return store.getArtifactPage(request.params.id, { limit, cursor: request.query.cursor });
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : "invalid history cursor",
        });
      }
    },
  );

  app.patch<{
    Params: { id: string; aid: string };
    Body: { pinned?: boolean; visibility?: "project" | "published" };
  }>(
    "/api/agents/:id/artifacts/:aid",
    async (request, reply) => {
      const artifact = store.getArtifact(request.params.id, request.params.aid);
      if (!artifact || artifact.kind !== "generated_file") {
        return reply.code(404).send({ error: "generated artifact not found" });
      }
      if (
        request.body.visibility !== undefined
        && !["project", "published"].includes(request.body.visibility)
      ) return reply.code(400).send({ error: "invalid visibility" });
      if (request.body.pinned !== undefined && typeof request.body.pinned !== "boolean") {
        return reply.code(400).send({ error: "pinned must be boolean" });
      }
      const stored = store.appendEvent(request.params.id, {
        type: "artifact_visibility",
        artifactId: artifact.id,
        visibility: request.body.visibility ?? artifact.visibility ?? "project",
        pinned: request.body.pinned ?? artifact.pinned ?? false,
      });
      publish(request.params.id, stored);
      const agent = store.getAgent(request.params.id);
      if (agent && store.getProjectArtifact(agent.projectId, artifact.id)) {
        store.updateProjectArtifactVisibility(
          agent.projectId,
          artifact.id,
          request.body.visibility ?? artifact.visibility ?? "project",
          request.body.pinned ?? artifact.pinned ?? false,
        );
      }
      return store.getArtifact(request.params.id, artifact.id)!;
    },
  );

  app.get<{
    Params: { projectId: string };
    Querystring: { limit?: string; cursor?: string };
  }>("/api/projects/:projectId/artifacts", async (request, reply) => {
    if (!store.getProject(request.params.projectId)) {
      return reply.code(404).send({ error: "project not found" });
    }
    const limit = Math.min(500, Math.max(1, Number(request.query.limit ?? 100) || 100));
    try {
      return store.getProjectArtifactPage(request.params.projectId, {
        limit,
        cursor: request.query.cursor,
      });
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "invalid history cursor",
      });
    }
  });

  app.patch<{
    Params: { projectId: string; aid: string };
    Body: { pinned?: boolean; visibility?: "project" | "published" };
  }>(
    "/api/projects/:projectId/artifacts/:aid",
    async (request, reply) => {
      const artifact = store.getProjectArtifact(request.params.projectId, request.params.aid);
      if (
        !artifact
        || !store.projectArtifactIsOrganizationVisible(request.params.projectId, request.params.aid)
      ) {
        return reply.code(404).send({ error: "generated artifact not found" });
      }
      if (
        request.body.visibility !== undefined
        && !["project", "published"].includes(request.body.visibility)
      ) return reply.code(400).send({ error: "invalid visibility" });
      if (request.body.pinned !== undefined && typeof request.body.pinned !== "boolean") {
        return reply.code(400).send({ error: "pinned must be boolean" });
      }
      return store.updateProjectArtifactVisibility(
        request.params.projectId,
        request.params.aid,
        request.body.visibility ?? artifact.visibility ?? "project",
        request.body.pinned ?? artifact.pinned ?? false,
      )!;
    },
  );

  async function generatedFile(
    projectId: string,
    agentId: string,
    artifactId: string,
    signal?: AbortSignal,
  ): Promise<GeneratedFile | undefined> {
    const project = store.getProject(projectId);
    const generatedPdfSource = async (): Promise<GeneratedFile | undefined> => {
      const agent = store.getAgentDetail(agentId, 1, false)?.agent;
      if (!project || !agent || agent.projectId !== project.id) return undefined;
      const generatedPath = store.getGeneratedPdfPath(agent.id, artifactId);
      if (!generatedPath) return undefined;
      const source = readWorkspaceArtifactFile({
        rootPath: project.hostPath,
        requestedPath: generatedPath,
        purpose: "legacy_pdf",
        maxBytes: 32 * 1024 * 1024,
        faults: workspaceArtifactReadFaults,
      });
      return source
        ? {
          body: source.body,
          name: source.name,
          mediaType: "application/pdf",
          size: source.body.length,
        }
        : undefined;
    };
    const managed = store.getProjectArtifact(projectId, artifactId);
    if (project && managed) {
      if ((managed.originAgentId ?? managed.agentId) !== agentId) return undefined;
      if (managed.kind === "diff" && managed.sourcePath?.toLowerCase().endsWith(".pdf")) {
        return generatedPdfSource();
      }
      const runtime = assets.authoritativeRuntimeArtifactMetadataById(projectId, artifactId);
      if (runtime && !managedProjectArtifactAgreesWithRuntime(managed, runtime)) return undefined;
      if (managed.size === undefined || !managed.mediaType || !managed.sha256) return undefined;
      if (
        managed.kind === "generated_file"
        && !assets.authoritativeGeneratedArtifactMetadata(projectId, managed)
      ) return undefined;
      const authoritative = await openManagedArtifactContent(
        dataDir,
        projectId,
        managed.id,
        managed.size,
        managed.sha256,
        { signal, faults: managedArtifactReadFaults },
      );
      return authoritative
        ? {
          managed: authoritative,
          name: managedArtifactDownloadName(managed),
          mediaType: managed.mediaType,
          size: authoritative.size,
        }
        : undefined;
    }
    return generatedPdfSource();
  }

  async function sendGeneratedPreview(
    reply: FastifyReply,
    file: GeneratedFile,
    signal?: AbortSignal,
  ) {
    const activeDocument = file.mediaType === "text/html" || file.mediaType === "image/svg+xml";
    const textual = file.mediaType.startsWith("text/") || file.mediaType === "application/json";
    // The web app frames previews from this authenticated same-origin route;
    // the iframe/CSP sandbox supplies the untrusted document's opaque origin.
    reply.header("X-Frame-Options", "SAMEORIGIN");
    if (activeDocument) {
      reply
        // Scripts may power an exported visualization, but the omitted
        // allow-same-origin token gives it an opaque origin. Network, forms,
        // embedding, and top-level navigation remain unavailable.
        .header(
          "Content-Security-Policy",
          "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'",
        )
        .header("Cache-Control", "private, no-store")
        .header("Referrer-Policy", "no-referrer")
        .header("X-Content-Type-Options", "nosniff");
    }
    if (!textual && file.managed) {
      const body = file.managed.createReadStream(signal);
      return {
        body,
        response: reply
          .type(file.mediaType)
          .header("Content-Length", String(file.size))
          .header(
            "Content-Disposition",
            contentDisposition(file.name).replace(/^attachment/, "inline"),
          ),
      };
    }
    const source = file.body ?? await file.managed!.readRange(MAX_FILE_BYTES + 4, signal);
    await file.managed?.close();
    const utf8Body = textual ? boundedUtf8Preview(source, MAX_FILE_BYTES) : undefined;
    const binaryFallback = textual && utf8Body === undefined;
    const body = textual
      ? utf8Body ?? source.subarray(0, Math.min(source.length, MAX_FILE_BYTES))
      : source;
    if (body.length < file.size) {
      reply
        .header("X-Ponderosa-Preview-Truncated", "true")
        .header("X-Ponderosa-Artifact-Bytes", String(file.size));
    }
    return {
      body,
      response: reply
        .type(binaryFallback ? "application/octet-stream" : file.mediaType)
        .header(
          "Content-Disposition",
          contentDisposition(file.name).replace(/^attachment/, "inline"),
        ),
    };
  }

  function beginArtifactTransfer(
    projectId: string,
    weight: number,
    request: { raw: NodeJS.EventEmitter },
    reply: { raw: NodeJS.EventEmitter },
  ): { signal: AbortSignal; finish: () => void } | undefined {
    const release = projectFileAuthority.acquire(projectId, weight);
    if (!release) return undefined;
    const controller = new AbortController();
    let finished = false;
    const abort = (): void => controller.abort(new Error("managed artifact request disconnected"));
    request.raw.once("aborted", abort);
    reply.raw.once("close", abort);
    return {
      signal: controller.signal,
      finish: () => {
        if (finished) return;
        finished = true;
        request.raw.removeListener("aborted", abort);
        reply.raw.removeListener("close", abort);
        release();
      },
    };
  }

  async function serveGeneratedPreview(
    request: { raw: NodeJS.EventEmitter },
    reply: FastifyReply,
    projectId: string,
    agentId: string,
    artifactId: string,
  ) {
    if (!store.getProject(projectId)) return reply.code(404).send({ error: "project not found" });
    const transfer = beginArtifactTransfer(
      projectId,
      PROJECT_FILE_PREVIEW_WEIGHT,
      request,
      reply,
    );
    if (!transfer) {
      return reply
        .code(429)
        .header("Retry-After", "1")
        .send({ error: "artifact preview capacity exceeded" });
    }
    let file: Awaited<ReturnType<typeof generatedFile>>;
    try {
      file = await generatedFile(projectId, agentId, artifactId, transfer.signal);
      if (!file) {
        transfer.finish();
        return reply.code(404).send({ error: "generated artifact not found" });
      }
      const prepared = await sendGeneratedPreview(reply, file, transfer.signal);
      if (prepared.body instanceof Readable) {
        projectFileAuthority.bindLifecycle(request, reply, prepared.body, transfer.finish);
      } else {
        transfer.finish();
      }
      return prepared.response.send(prepared.body);
    } catch (error) {
      await file?.managed?.close();
      transfer.finish();
      if (transfer.signal.aborted) return reply;
      throw error;
    }
  }

  async function serveGeneratedDownload(
    request: { raw: NodeJS.EventEmitter },
    reply: FastifyReply,
    projectId: string,
    agentId: string,
    artifactId: string,
  ) {
    if (!store.getProject(projectId)) return reply.code(404).send({ error: "project not found" });
    const transfer = beginArtifactTransfer(
      projectId,
      PROJECT_FILE_DOWNLOAD_WEIGHT,
      request,
      reply,
    );
    if (!transfer) {
      return reply
        .code(429)
        .header("Retry-After", "1")
        .send({ error: "artifact download capacity exceeded" });
    }
    let file: Awaited<ReturnType<typeof generatedFile>>;
    try {
      file = await generatedFile(projectId, agentId, artifactId, transfer.signal);
      if (!file) {
        transfer.finish();
        return reply.code(404).send({ error: "generated artifact not found" });
      }
      const response = reply
        .type(file.mediaType)
        .header("Content-Length", String(file.size))
        // The declared media type is the only truthful statement about these
        // bytes; nothing downstream should re-decide it from the file name.
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Disposition", contentDisposition(file.name));
      if (file.managed) {
        const body = file.managed.createReadStream(transfer.signal);
        projectFileAuthority.bindLifecycle(request, reply, body, transfer.finish);
        return response.send(body);
      }
      transfer.finish();
      return response.send(file.body!);
    } catch (error) {
      await file?.managed?.close();
      transfer.finish();
      if (transfer.signal.aborted) return reply;
      throw error;
    }
  }

  app.get<{ Params: { projectId: string; aid: string } }>(
    "/api/projects/:projectId/artifacts/:aid/preview",
    async (request, reply) => {
      const artifact = store.getProjectArtifact(request.params.projectId, request.params.aid);
      if (
        !artifact
        || !store.operatorCanReadProjectArtifact(request.params.projectId, request.params.aid)
      ) {
        return reply.code(404).send({ error: "generated artifact not found" });
      }
      return serveGeneratedPreview(
        request,
        reply,
        request.params.projectId,
        artifact.originAgentId ?? artifact.agentId,
        artifact.id,
      );
    },
  );

  app.get<{ Params: { projectId: string; aid: string } }>(
    "/api/projects/:projectId/artifacts/:aid/download",
    async (request, reply) => {
      const artifact = store.getProjectArtifact(request.params.projectId, request.params.aid);
      if (
        !artifact
        || !store.operatorCanReadProjectArtifact(request.params.projectId, request.params.aid)
      ) {
        return reply.code(404).send({ error: "generated artifact not found" });
      }
      return serveGeneratedDownload(
        request,
        reply,
        request.params.projectId,
        artifact.originAgentId ?? artifact.agentId,
        artifact.id,
      );
    },
  );

  app.get<{ Params: { projectId: string; id: string; aid: string } }>(
    "/api/projects/:projectId/agents/:id/generated-artifacts/:aid/preview",
    async (request, reply) => serveGeneratedPreview(
      request,
      reply,
      request.params.projectId,
      request.params.id,
      request.params.aid,
    ),
  );

  app.get<{ Params: { projectId: string; id: string; aid: string } }>(
    "/api/projects/:projectId/agents/:id/generated-artifacts/:aid/download",
    async (request, reply) => serveGeneratedDownload(
      request,
      reply,
      request.params.projectId,
      request.params.id,
      request.params.aid,
    ),
  );

  app.get<{
    Params: { projectId: string; id: string; aid: string };
    Querystring: { download?: string };
  }>(
    "/api/projects/:projectId/agents/:id/browser-artifacts/:aid",
    async (request, reply) => {
      const agent = store.getAgentDetail(request.params.id, 1, false)?.agent;
      if (!agent || agent.projectId !== request.params.projectId) {
        return reply.code(404).send({ error: "agent not found" });
      }
      const artifact = store.getArtifact(agent.id, request.params.aid);
      if (!artifact || artifact.kind !== "screenshot") {
        return reply.code(404).send({ error: "browser screenshot not found" });
      }
      const transfer = beginArtifactTransfer(
        agent.projectId,
        request.query.download === "1"
          ? PROJECT_FILE_DOWNLOAD_WEIGHT
          : PROJECT_FILE_PREVIEW_WEIGHT,
        request,
        reply,
      );
      if (!transfer) {
        return reply
          .code(429)
          .header("Retry-After", "1")
          .send({ error: "browser artifact capacity exceeded" });
      }
      let file: Awaited<ReturnType<typeof generatedFile>>;
      try {
        file = await generatedFile(agent.projectId, agent.id, artifact.id, transfer.signal);
        if (!file || file.mediaType !== "image/png") {
          await file?.managed?.close();
          transfer.finish();
          return reply.code(404).send({ error: "browser screenshot not found" });
        }
        const response = reply
          .type("image/png")
          .header("Content-Length", String(file.size))
          .header("cache-control", "private, no-store");
        if (request.query.download === "1") {
          response.header("Content-Disposition", contentDisposition(file.name));
        }
        if (file.managed) {
          const body = file.managed.createReadStream(transfer.signal);
          projectFileAuthority.bindLifecycle(request, reply, body, transfer.finish);
          return response.send(body);
        }
        transfer.finish();
        return response.send(file.body!);
      } catch (error) {
        await file?.managed?.close();
        transfer.finish();
        if (transfer.signal.aborted) return reply;
        throw error;
      }
    },
  );

  app.get<{ Params: { id: string; aid: string } }>(
    "/api/agents/:id/artifacts/:aid",
    async (request, reply) => {
      const agent = store.getAgentDetail(request.params.id, 1, false)?.agent;
      if (!agent) return reply.code(404).send({ error: "agent not found" });
      const artifact = store.getArtifact(agent.id, request.params.aid);
      if (!artifact) return reply.code(404).send({ error: "artifact not found" });
      const managed = store.getProjectArtifact(agent.projectId, artifact.id);
      if (!managed?.size || !managed.sha256) {
        return reply.code(404).send({ error: "artifact content not found" });
      }
      const transfer = beginArtifactTransfer(
        agent.projectId,
        PROJECT_FILE_PREVIEW_WEIGHT,
        request,
        reply,
      );
      if (!transfer) {
        return reply
          .code(429)
          .header("Retry-After", "1")
          .send({ error: "artifact viewer capacity exceeded" });
      }
      let file: ManagedArtifactContentHandle | undefined;
      try {
        file = await openManagedArtifactContent(
          dataDir,
          agent.projectId,
          managed.id,
          managed.size,
          managed.sha256,
          { signal: transfer.signal, faults: managedArtifactReadFaults },
        );
        if (!file) return reply.code(404).send({ error: "artifact content not found" });
        const source = await file.readRange(MAX_FILE_BYTES + 4, transfer.signal);
        const preview = boundedUtf8Preview(source, MAX_FILE_BYTES);
        const previewEnd = preview?.length ?? 0;
        const content = preview?.toString("utf8") ?? "";
        return {
          ...managed,
          content,
          contentType: preview ? contentTypeForArtifact(managed.path) : "application/octet-stream",
          truncated: previewEnd < file.size,
          totalBytes: file.size,
        };
      } catch (error) {
        if (transfer.signal.aborted) return reply;
        throw error;
      } finally {
        await file?.close();
        transfer.finish();
      }
    },
  );
}

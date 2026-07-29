import { isUtf8 } from "node:buffer";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { AgentStore } from "@ponderosa/agents";
import type { WorkspaceFileViewDto } from "@ponderosa/core";
import { listSecureDirectory, readSecureFile } from "@ponderosa/native-host";
import type { FastifyInstance } from "fastify";
import { contentDisposition } from "../assets.js";
import {
  MAX_FILE_BYTES,
  isProjectFileReferenceAllowed,
  safeRelativePath,
} from "../project-files.js";
import { contentTypeForStatic } from "../static-content.js";

export const PROJECT_FILE_PREVIEW_WEIGHT = 1;
export const PROJECT_FILE_DOWNLOAD_WEIGHT = 2;

const PROJECT_PREVIEW_MAX_BYTES = 16 * 1024 * 1024;
const PROJECT_DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;
const PROJECT_FILE_GLOBAL_CAPACITY = 12;
const PROJECT_FILE_PROJECT_CAPACITY = 4;
const PROJECT_FILE_RATE_WINDOW_MS = 60_000;
const PROJECT_FILE_RATE_CAPACITY = 60;
const PROJECT_FILE_RATE_BUCKET_LIMIT = 512;

interface ProjectFileReadFaults {
  afterResolve?(resolvedPath: string): Promise<void> | void;
}

export class ProjectFileAuthority {
  private globalInFlight = 0;
  private readonly inFlight = new Map<string, number>();
  private readonly requests = new Map<
    string,
    { requests: Array<{ at: number; weight: number }>; lastSeen: number }
  >();
  private readonly previewMediaTypes = new Set([
    "image/png",
    "image/jpeg",
    "image/webp",
    "application/pdf",
  ]);

  constructor(
    private readonly store: Pick<AgentStore, "getProject">,
    private readonly faults?: ProjectFileReadFaults,
  ) {}

  acquire(projectId: string, weight: number): (() => void) | undefined {
    const now = Date.now();
    for (const [key, bucket] of this.requests) {
      const requests = bucket.requests.filter(
        (entry) => entry.at > now - PROJECT_FILE_RATE_WINDOW_MS,
      );
      if (requests.length === 0 && !this.inFlight.has(key)) {
        this.requests.delete(key);
      } else if (requests.length !== bucket.requests.length) {
        this.requests.set(key, { requests, lastSeen: bucket.lastSeen });
      }
    }
    while (
      !this.requests.has(projectId) &&
      this.requests.size >= PROJECT_FILE_RATE_BUCKET_LIMIT
    ) {
      const oldest = [...this.requests.entries()]
        .filter(([key]) => !this.inFlight.has(key))
        .sort((left, right) => left[1].lastSeen - right[1].lastSeen)[0];
      if (!oldest) return undefined;
      this.requests.delete(oldest[0]);
    }
    const bucket = this.requests.get(projectId) ?? {
      requests: [],
      lastSeen: now,
    };
    const rateUsed = bucket.requests.reduce(
      (total, entry) => total + entry.weight,
      0,
    );
    if (
      rateUsed + weight > PROJECT_FILE_RATE_CAPACITY ||
      this.globalInFlight + weight > PROJECT_FILE_GLOBAL_CAPACITY ||
      (this.inFlight.get(projectId) ?? 0) + weight >
        PROJECT_FILE_PROJECT_CAPACITY
    ) {
      this.requests.set(projectId, { ...bucket, lastSeen: now });
      return undefined;
    }
    bucket.requests.push({ at: now, weight });
    this.requests.set(projectId, {
      requests: bucket.requests,
      lastSeen: now,
    });
    this.globalInFlight += weight;
    this.inFlight.set(
      projectId,
      (this.inFlight.get(projectId) ?? 0) + weight,
    );
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.globalInFlight = Math.max(0, this.globalInFlight - weight);
      const next = Math.max(
        0,
        (this.inFlight.get(projectId) ?? weight) - weight,
      );
      if (next === 0) this.inFlight.delete(projectId);
      else this.inFlight.set(projectId, next);
    };
  }

  bindLifecycle(
    request: { raw: NodeJS.EventEmitter },
    reply: { raw: NodeJS.EventEmitter },
    body: Readable,
    release: () => void,
  ): void {
    let settled = false;
    const cleanup = (destroy: boolean) => {
      if (settled) return;
      settled = true;
      request.raw.removeListener("aborted", aborted);
      reply.raw.removeListener("close", closed);
      if (destroy && !body.destroyed) body.destroy();
      release();
    };
    const aborted = () => cleanup(true);
    const closed = () => cleanup(!body.readableEnded);
    request.raw.once("aborted", aborted);
    reply.raw.once("close", closed);
    body
      .once("end", () => cleanup(false))
      .once("close", () => cleanup(false))
      .once("error", () => cleanup(false));
  }

  mediaType(input: string | undefined): string | undefined {
    if (!input?.trim()) return undefined;
    try {
      const requested = input.startsWith("file://")
        ? decodeURIComponent(new URL(input).pathname)
        : input;
      return contentTypeForStatic(requested.toLowerCase());
    } catch {
      return undefined;
    }
  }

  supportsPreview(mediaType: string): boolean {
    return this.previewMediaTypes.has(mediaType);
  }

  private workspaceFileContentType(file: string): string {
    const extension = path.extname(file).toLowerCase();
    return (
      {
        ".md": "text/markdown",
        ".mdown": "text/markdown",
        ".txt": "text/plain",
        ".csv": "text/csv",
        ".tsv": "text/tab-separated-values",
        ".xml": "application/xml",
        ".yaml": "text/yaml",
        ".yml": "text/yaml",
        ".log": "text/plain",
      } as Record<string, string>
    )[extension] ?? contentTypeForStatic(file.toLowerCase()).split(";", 1)[0]!;
  }

  private validPreviewMagic(mediaType: string, header: Buffer): boolean {
    if (mediaType === "image/png") {
      return header
        .subarray(0, 8)
        .equals(Buffer.from("89504e470d0a1a0a", "hex"));
    }
    if (mediaType === "image/jpeg") {
      return (
        header.length >= 3 &&
        header[0] === 0xff &&
        header[1] === 0xd8 &&
        header[2] === 0xff
      );
    }
    if (mediaType === "image/webp") {
      return (
        header.subarray(0, 4).toString("ascii") === "RIFF" &&
        header.subarray(8, 12).toString("ascii") === "WEBP"
      );
    }
    if (mediaType === "application/pdf") {
      return header.subarray(0, 5).toString("ascii") === "%PDF-";
    }
    return false;
  }

  private async nativeRelativePath(
    rootPath: string,
    input: string,
  ): Promise<{ root: string; relative: string; resolved: string } | undefined> {
    const root = await fs.realpath(rootPath);
    const requested = input.startsWith("file://")
      ? fileURLToPath(input)
      : input;
    const candidate = path.isAbsolute(requested)
      ? path.resolve(requested)
      : path.resolve(root, safeRelativePath(requested));
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
      return undefined;
    }
    const relative = path.relative(root, candidate).replaceAll(path.sep, "/");
    if (!relative || !isProjectFileReferenceAllowed(relative)) return undefined;
    return { root, relative, resolved: path.join(root, relative) };
  }

  async fileForBrowser(
    projectId: string,
    input: string | undefined,
    options: { maxBytes: number; previewMediaType?: string },
  ): Promise<
    { body: Readable; name: string; mediaType: string; size: number } | undefined
  > {
    const project = this.store.getProject(projectId);
    if (!project || !input?.trim()) return undefined;
    if (process.platform !== "linux") {
      try {
        const target = await this.nativeRelativePath(project.hostPath, input);
        if (!target) return undefined;
        await this.faults?.afterResolve?.(target.resolved);
        const body = readSecureFile({
          root: project.hostPath,
          relativePath: target.relative,
          maxBytes: options.maxBytes,
        });
        if (!body) return undefined;
        const mediaType = options.previewMediaType ??
          contentTypeForStatic(target.relative.toLowerCase());
        if (options.previewMediaType &&
            !this.validPreviewMagic(options.previewMediaType, body.subarray(0, 16))) {
          return undefined;
        }
        return {
          body: Readable.from([body]),
          name: path.basename(target.relative),
          mediaType,
          size: body.length,
        };
      } catch {
        return undefined;
      }
    }
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      const root = await fs.realpath(project.hostPath);
      const requested = input.startsWith("file://")
        ? decodeURIComponent(new URL(input).pathname)
        : input;
      const candidate = path.isAbsolute(requested)
        ? requested
        : path.resolve(root, safeRelativePath(requested));
      const resolved = await fs.realpath(candidate);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        return undefined;
      }
      const relative = path.relative(root, resolved).replaceAll(path.sep, "/");
      if (!relative || !isProjectFileReferenceAllowed(relative)) {
        return undefined;
      }
      await this.faults?.afterResolve?.(resolved);
      handle = await fs.open(
        resolved,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      const openedPath = await fs.realpath(`/proc/self/fd/${handle.fd}`);
      if (
        openedPath !== root &&
        !openedPath.startsWith(`${root}${path.sep}`)
      ) {
        return undefined;
      }
      const info = await handle.stat();
      if (!info.isFile() || info.size > options.maxBytes) return undefined;
      const mediaType =
        options.previewMediaType ?? contentTypeForStatic(resolved.toLowerCase());
      if (options.previewMediaType) {
        const header = Buffer.alloc(16);
        const { bytesRead } = await handle.read(
          header,
          0,
          header.length,
          0,
        );
        if (
          !this.validPreviewMagic(
            options.previewMediaType,
            header.subarray(0, bytesRead),
          )
        ) {
          return undefined;
        }
      }
      const openHandle = handle;
      handle = undefined;
      const body = Readable.from(
        (async function* streamBoundedProjectFile() {
          let position = 0;
          try {
            while (position < info.size) {
              const requestedBytes = Math.min(64 * 1024, info.size - position);
              const buffer = Buffer.allocUnsafe(requestedBytes);
              const { bytesRead } = await openHandle.read(
                buffer,
                0,
                requestedBytes,
                position,
              );
              if (bytesRead === 0) break;
              position += bytesRead;
              yield buffer.subarray(0, bytesRead);
            }
          } finally {
            await openHandle.close().catch(() => undefined);
          }
        })(),
      );
      return {
        body,
        name: path.basename(resolved),
        mediaType,
        size: info.size,
      };
    } catch {
      return undefined;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async view(
    projectId: string,
    input: string | undefined,
  ): Promise<WorkspaceFileViewDto | undefined> {
    const project = this.store.getProject(projectId);
    if (!project || !input?.trim()) return undefined;
    if (process.platform !== "linux") {
      try {
        const target = await this.nativeRelativePath(project.hostPath, input);
        if (!target) return undefined;
        const segments = target.relative.split("/");
        const leaf = segments.pop()!;
        const parent = segments.join("/");
        const entry = listSecureDirectory({
          root: project.hostPath,
          relativePath: parent,
        })?.find((candidate) =>
          candidate.name === leaf && candidate.kind === "file");
        if (!entry || entry.size === undefined) return undefined;
        const mediaType = this.workspaceFileContentType(target.relative);
        const previewCandidate =
          this.previewMediaTypes.has(mediaType) &&
          entry.size <= PROJECT_PREVIEW_MAX_BYTES;
        const textMedia =
          mediaType.startsWith("text/") ||
          ["application/json", "application/javascript", "application/xml"].includes(mediaType);
        const readLimit = previewCandidate
          ? PROJECT_PREVIEW_MAX_BYTES
          : textMedia && entry.size <= MAX_FILE_BYTES
            ? MAX_FILE_BYTES
            : 0;
        const body = readLimit > 0
          ? readSecureFile({
            root: project.hostPath,
            relativePath: target.relative,
            maxBytes: readLimit,
          })
          : undefined;
        const previewable = previewCandidate && Boolean(body) &&
          this.validPreviewMagic(mediaType, body!.subarray(0, 16));
        let text: string | undefined;
        if (textMedia && body && isUtf8(body)) text = body.toString("utf8");
        const encodedPath = encodeURIComponent(target.relative);
        return {
          projectId,
          path: target.relative,
          name: leaf,
          mediaType,
          size: entry.size,
          previewable,
          ...(text !== undefined ? { text } : {}),
          truncated:
            (textMedia && text === undefined) ||
            entry.size > PROJECT_DOWNLOAD_MAX_BYTES,
          ...(previewable ? {
            previewUrl: `/api/projects/${encodeURIComponent(projectId)}/workspace-files/preview?path=${encodedPath}`,
          } : {}),
          ...(entry.size <= PROJECT_DOWNLOAD_MAX_BYTES ? {
            downloadUrl: `/api/projects/${encodeURIComponent(projectId)}/workspace-files/download?path=${encodedPath}`,
          } : {}),
        };
      } catch {
        return undefined;
      }
    }
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      const root = await fs.realpath(project.hostPath);
      const requested = input.startsWith("file://")
        ? decodeURIComponent(new URL(input).pathname)
        : input;
      const candidate = path.isAbsolute(requested)
        ? requested
        : path.resolve(root, safeRelativePath(requested));
      const resolved = await fs.realpath(candidate);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        return undefined;
      }
      const relative = path.relative(root, resolved).replaceAll(path.sep, "/");
      if (!relative || !isProjectFileReferenceAllowed(relative)) {
        return undefined;
      }
      handle = await fs.open(
        resolved,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      const openedPath = await fs.realpath(`/proc/self/fd/${handle.fd}`);
      if (
        openedPath !== root &&
        !openedPath.startsWith(`${root}${path.sep}`)
      ) {
        return undefined;
      }
      const info = await handle.stat();
      if (!info.isFile()) return undefined;
      const mediaType = this.workspaceFileContentType(resolved);
      let previewable =
        this.previewMediaTypes.has(mediaType) &&
        info.size <= PROJECT_PREVIEW_MAX_BYTES;
      if (previewable) {
        const header = Buffer.alloc(16);
        const { bytesRead } = await handle.read(
          header,
          0,
          header.length,
          0,
        );
        previewable = this.validPreviewMagic(
          mediaType,
          header.subarray(0, bytesRead),
        );
      }
      const textMedia =
        mediaType.startsWith("text/") ||
        [
          "application/json",
          "application/javascript",
          "application/xml",
        ].includes(mediaType);
      let text: string | undefined;
      if (textMedia && info.size <= MAX_FILE_BYTES) {
        const body = await handle.readFile();
        if (isUtf8(body)) text = body.toString("utf8");
      }
      const encodedPath = encodeURIComponent(relative);
      return {
        projectId,
        path: relative,
        name: path.basename(resolved),
        mediaType,
        size: info.size,
        previewable,
        ...(text !== undefined ? { text } : {}),
        truncated:
          (textMedia && text === undefined) ||
          info.size > PROJECT_DOWNLOAD_MAX_BYTES,
        ...(previewable
          ? {
              previewUrl: `/api/projects/${encodeURIComponent(projectId)}/workspace-files/preview?path=${encodedPath}`,
            }
          : {}),
        ...(info.size <= PROJECT_DOWNLOAD_MAX_BYTES
          ? {
              downloadUrl: `/api/projects/${encodeURIComponent(projectId)}/workspace-files/download?path=${encodedPath}`,
            }
          : {}),
      };
    } catch {
      return undefined;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}

export function registerProjectFileRoutes(
  app: FastifyInstance,
  authority: ProjectFileAuthority,
  store: Pick<AgentStore, "getProject">,
): void {
  app.get<{
    Params: { projectId: string };
    Querystring: { path?: string };
  }>(
    "/api/projects/:projectId/workspace-files/view-info",
    async (request, reply) => {
      if (!store.getProject(request.params.projectId)) {
        return reply.code(404).send({ error: "project not found" });
      }
      const file = await authority.view(
        request.params.projectId,
        request.query.path,
      );
      if (!file) {
        return reply
          .code(404)
          .send({ error: "project file is missing or unavailable" });
      }
      return reply.header("Cache-Control", "private, no-store").send(file);
    },
  );

  app.get<{
    Params: { projectId: string };
    Querystring: { path?: string };
  }>(
    "/api/projects/:projectId/workspace-files/preview",
    async (request, reply) => {
      if (!store.getProject(request.params.projectId)) {
        return reply.code(404).send({ error: "project not found" });
      }
      const mediaType = authority.mediaType(request.query.path);
      if (!mediaType || !authority.supportsPreview(mediaType)) {
        return reply
          .code(415)
          .send({
            error: "this project file does not support an inline preview",
          });
      }
      const release = authority.acquire(
        request.params.projectId,
        PROJECT_FILE_PREVIEW_WEIGHT,
      );
      if (!release) {
        return reply
          .code(429)
          .header("Retry-After", "1")
          .send({ error: "project preview capacity exceeded" });
      }
      const file = await authority.fileForBrowser(
        request.params.projectId,
        request.query.path,
        {
          maxBytes: PROJECT_PREVIEW_MAX_BYTES,
          previewMediaType: mediaType,
        },
      );
      if (!file) {
        release();
        return reply.code(404).send({ error: "project file not found" });
      }
      authority.bindLifecycle(request, reply, file.body, release);
      return reply
        .type(file.mediaType)
        .header("Content-Length", String(file.size))
        .header(
          "Content-Disposition",
          contentDisposition(file.name).replace(/^attachment/, "inline"),
        )
        .header("Cache-Control", "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .send(file.body);
    },
  );

  app.get<{
    Params: { projectId: string };
    Querystring: { path?: string };
  }>(
    "/api/projects/:projectId/workspace-files/download",
    async (request, reply) => {
      if (!store.getProject(request.params.projectId)) {
        return reply.code(404).send({ error: "project not found" });
      }
      const release = authority.acquire(
        request.params.projectId,
        PROJECT_FILE_DOWNLOAD_WEIGHT,
      );
      if (!release) {
        return reply
          .code(429)
          .header("Retry-After", "1")
          .send({ error: "project file capacity exceeded" });
      }
      const file = await authority.fileForBrowser(
        request.params.projectId,
        request.query.path,
        { maxBytes: PROJECT_DOWNLOAD_MAX_BYTES },
      );
      if (!file) {
        release();
        return reply.code(404).send({ error: "project file not found" });
      }
      authority.bindLifecycle(request, reply, file.body, release);
      return reply
        .type("application/octet-stream")
        .header("Content-Length", String(file.size))
        .header("Content-Disposition", contentDisposition(file.name))
        .header("Cache-Control", "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .send(file.body);
    },
  );
}

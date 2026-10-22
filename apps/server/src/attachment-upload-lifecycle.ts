import type { IncomingMessage } from "node:http";
import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";

interface Upload {
  requestId: string;
  phase: "admitted" | "receiving" | "ready" | "processing" | "retired";
  stopped?: string;
  cancelParsing?: () => void;
  stop(reason: string): void;
  retire(): void;
}
const uploads = new WeakMap<IncomingMessage, Upload>();

/** Called by the three upload handlers after their storage/lease finally blocks,
 * independently of response delivery (Fastify replies are thenables). */
export function retireAttachmentUpload(request: FastifyRequest): void {
  uploads.get(request.raw)?.retire();
}

export function stopAttachmentUpload(request: FastifyRequest, reason: string): void {
  uploads.get(request.raw)?.stop(reason);
}

const uploadRoute = (method: string, url: string): boolean => method === "POST" && (
  /^\/api\/agents\/[^/]+\/attachments$/u.test(url.split("?", 1)[0] ?? "")
  || /^\/api\/conversations\/[^/]+\/(?:draft-attachments|attachments)$/u.test(url.split("?", 1)[0] ?? "")
);

/** Preserve the large-attachment media type's one server-wide two-slot lane,
 * with explicit parser and handler retirement. Other body parsers stay unchanged.
 * Socket closure is a cancellation signal, never proof that storage work ended. */
export function registerAttachmentUploadLifecycle(app: FastifyInstance, maxBytes: number): () => Promise<void> {
  const active = new Set<Upload>();
  const drained = new Set<() => void>();
  let closing = false;
  let lastBusyLog = 0;
  app.addHook("preParsing", (request, reply, payload, done) => {
    const requestId = request.id.slice(0, 128);
    const largeType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase()
      === "application/x-ponderosa-attachment";
    if (!largeType) return done(null, payload);
    if (!uploadRoute(request.method, request.url)) {
      // A callback hook that sends without calling done is terminal. Returning
      // an empty stream here would continue parsing after the rejection.
      void reply.code(415).header("connection", "close").send({ error: "This content type is only for attachment uploads" });
      return;
    }
    // The browser encodes filename metadata so HTTP headers stay ASCII.
    const filename = request.headers["x-ponderosa-filename"];
    try {
      if (typeof filename === "string") {
        request.headers["x-ponderosa-filename"] = decodeURIComponent(filename);
      }
    } catch {
      done(Object.assign(new Error("Attachment filename encoding is invalid"), { statusCode: 400 }));
      return;
    }
    if (closing || active.size >= 2) {
      if (!closing && Date.now() - lastBusyLog >= 1_000) {
        lastBusyLog = Date.now();
        request.log.warn({ event: "attachment_upload_busy", requestId,
          activeUploads: active.size, uploads: [...active].map(item => ({ requestId: item.requestId, phase: item.phase })) },
        "attachment upload capacity is occupied by active work");
      }
      void reply.code(503).header("retry-after", "1").header("connection", "close").send({
        code: "attachment_upload_busy",
        error: closing ? "Attachment uploads are shutting down." : "Two attachments are uploading. Try again in a moment.",
      });
      return;
    }
    const raw = request.raw;
    const onAbort = () => upload.stop("body_aborted");
    const onRawClose = () => { if (!raw.complete) upload.stop("body_closed"); };
    const onResponseClose = () => { if (!reply.raw.writableFinished) upload.stop("disconnected"); };
    const upload: Upload = {
      requestId,
      phase: "admitted",
      stop(reason) {
        if (upload.phase === "retired" || upload.stopped) return;
        upload.stopped = reason;
        // A deadline has already sent its one 504. A lost transport has no
        // response to deliver. Suppress only these terminal upload responses.
        if (reason !== "deadline" && reason !== "response" && reason !== "error") {
          reply.hijack();
          reply.send = () => reply;
        }
        if (upload.phase === "processing") {
          request.log.info({ event: "attachment_upload_stopped_processing", requestId,
            reason, activeUploads: active.size }, "attachment upload still holds capacity until processing retires");
        } else if (upload.cancelParsing) {
          upload.cancelParsing();
        } else if (upload.phase === "ready" || upload.phase === "admitted") {
          upload.retire();
        }
      },
      retire() {
        if (upload.phase === "retired") return;
        // Only the parser's cleanup, a pre-handler terminal outcome, or the
        // handler's own finally may retire work; close/timeout cannot retire a
        // running handler. Drop the large body before making capacity available.
        upload.phase = "retired";
        upload.cancelParsing = undefined;
        request.body = undefined;
        raw.off("aborted", onAbort);
        raw.off("close", onRawClose);
        reply.raw.off("close", onResponseClose);
        uploads.delete(raw);
        active.delete(upload);
        request.log.info({ event: "attachment_upload_retired", requestId,
          reason: upload.stopped ?? "settled", activeUploads: active.size }, "attachment upload retired and released capacity");
        if (active.size === 0) {
          for (const resolve of drained) resolve();
          drained.clear();
        }
      },
    };
    uploads.set(raw, upload);
    active.add(upload);
    raw.once("aborted", onAbort);
    raw.once("close", onRawClose);
    reply.raw.once("close", onResponseClose);
    done(null, payload);
  });

  // Own the buffer collector so partial-body cancellation clears its listeners
  // and chunks before releasing capacity, even if Fastify cannot send an error.
  app.addContentTypeParser("application/x-ponderosa-attachment", (request, payload, done) => {
    const upload = uploads.get(request.raw);
    if (!upload) {
      done(Object.assign(new Error("attachment upload was not admitted"), { statusCode: 415 }));
      return;
    }
    upload.phase = "receiving";
    const stream = payload as Readable & { receivedEncodedLength?: number };
    const limit = Math.min(maxBytes, request.routeOptions.bodyLimit);
    const contentLength = Number(request.headers["content-length"]);
    let chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const failure = (code: string, statusCode: number, message: string) => Object.assign(new Error(message), { code, statusCode });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.off("close", onClose);
      upload.cancelParsing = undefined;
      let body: Buffer | undefined;
      try {
        if (!error) body = Buffer.concat(chunks, size);
      } catch (caught) {
        error = caught instanceof Error ? caught : new Error("attachment body allocation failed");
      }
      chunks = [];
      upload.phase = "ready";
      if (error || upload.stopped) {
        upload.retire();
        if (upload.stopped) {
          // IncomingMessage may emit its pending abort error after this collector
          // retires. Consume that terminal error without retaining its buffers.
          stream.once("error", () => undefined);
          stream.destroy();
        } else stream.resume(); // Discard unread bytes; preserve the parser error response.
        done(error ?? failure("attachment_upload_cancelled", 400, "attachment upload cancelled"));
      } else {
        done(null, body);
      }
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit || (stream.receivedEncodedLength ?? 0) > limit) {
        finish(failure("FST_ERR_CTP_BODY_TOO_LARGE", 413, "Request body is too large"));
      } else chunks.push(chunk);
    };
    const onEnd = () => {
      if (!Number.isNaN(contentLength) && (stream.receivedEncodedLength || size) !== contentLength) {
        finish(failure("FST_ERR_CTP_INVALID_CONTENT_LENGTH", 400, "Request body size did not match Content-Length"));
      } else finish();
    };
    const onError = (error: Error & { statusCode?: number }) => {
      if (!(typeof error.statusCode === "number" && error.statusCode >= 400)) error.statusCode = 400;
      finish(error);
    };
    const onClose = () => { if (!settled) finish(failure("attachment_upload_cancelled", 400, "attachment upload cancelled")); };
    upload.cancelParsing = () => finish(failure("attachment_upload_cancelled", 400, "attachment upload cancelled"));
    if (upload.stopped) return upload.cancelParsing();
    if (contentLength > limit) return finish(failure("FST_ERR_CTP_BODY_TOO_LARGE", 413, "Request body is too large"));
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    stream.once("close", onClose);
    stream.resume();
  });

  app.addHook("onRoute", route => {
    if (!uploadRoute(String(route.method), route.url)) return;
    const handler = route.handler;
    route.handler = async function(request, reply) {
      // Body reception keeps its idle limit; preparation uses the bounded request budget.
      request.raw.socket.setTimeout?.(app.server.requestTimeout || 120_000);
      const upload = uploads.get(request.raw);
      if (!upload) return handler.call(this, request, reply);
      if (upload.stopped || reply.sent || reply.raw.destroyed) {
        upload.stop("disconnected");
        upload.retire();
        return reply;
      }
      upload.phase = "processing";
      try {
        return await handler.call(this, request, reply);
      } catch (error) {
        if (!upload.stopped) throw error;
        request.log.warn({ event: "attachment_upload_failed_after_stop", requestId: upload.requestId },
          "attachment upload failed after its response became unavailable");
        return reply;
      }
    };
  });
  app.addHook("onResponse", async request => stopAttachmentUpload(request, "response"));
  app.addHook("onError", async request => stopAttachmentUpload(request, "error"));
  app.addHook("onTimeout", async request => stopAttachmentUpload(request, "timeout"));
  app.addHook("onRequestAbort", async request => stopAttachmentUpload(request, "body_aborted"));
  const drain = async (): Promise<void> => {
    closing = true;
    for (const upload of active) upload.stop("shutdown");
    // No timeout/reset: hung processing remains pending and blocks orderly
    // storage shutdown/replacement rather than falsely claiming retirement.
    if (active.size > 0) await new Promise<void>(resolve => drained.add(resolve));
  };
  app.addHook("preClose", drain);
  // Fastify's timed preClose runner is not the final storage barrier. The
  // application must also await this same drain during strict shutdown/retry.
  return drain;
}

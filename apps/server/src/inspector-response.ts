import { gzipSync } from "node:zlib";
import type { FastifyReply } from "fastify";
import { acceptsGzip } from "./static-content.js";

function sendInspectorJson(reply: FastifyReply, acceptEncoding: string | string[] | undefined, value: unknown): FastifyReply {
  const body = JSON.stringify(value);
  reply.type("application/json").header("vary", "Accept-Encoding");
  return acceptsGzip(acceptEncoding)
    ? reply.header("content-encoding", "gzip").send(gzipSync(body))
    : reply.send(body);
}

export {
  sendInspectorJson,
};

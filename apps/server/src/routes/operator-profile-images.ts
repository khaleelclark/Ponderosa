import type { FastifyInstance } from "fastify";
import {
  MAX_OPERATOR_AVATAR_BYTES,
  OperatorProfileImageError,
  readOperatorProfileImage,
  storeOperatorProfileImage,
} from "../operator-profile-images.js";

/**
 * Unlike the read-only domains this registrar takes `ServerContext`'s sibling
 * capability: `POST` writes, links, and unlinks avatar files under `dataDir`.
 * The write capability is declared here rather than reached through a context
 * documented as read-only.
 */
export function registerOperatorProfileImageRoutes(
  app: FastifyInstance,
  opts: { readonly dataDir: string },
): void {
  app.post<{ Body: Buffer }>("/api/workspace/profile-images", { bodyLimit: MAX_OPERATOR_AVATAR_BYTES }, async (request, reply) => {
    if (!Buffer.isBuffer(request.body)) return reply.code(400).send({ error: "profile image body is required" });
    try {
      const uploaded = await storeOperatorProfileImage(opts.dataDir, request.body, request.headers["content-type"]);
      return reply.code(201).send(uploaded);
    } catch (error) {
      if (error instanceof OperatorProfileImageError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.get<{ Params: { avatarId: string } }>("/api/workspace/profile-images/:avatarId", async (request, reply) => {
    const image = await readOperatorProfileImage(opts.dataDir, request.params.avatarId);
    if (!image) return reply.code(404).send({ error: "profile image not found" });
    return reply.type(image.mediaType)
      .header("cache-control", "private, max-age=31536000, immutable")
      .header("content-disposition", "inline")
      .send(image.body);
  });
}

// @ponderosa/server — Fastify daemon (source of truth). Chunk A hello-world:
// only /api/health. The full API surface (SPEC §8), SSE, and session manager
// land in Chunk F.
import Fastify from "fastify";

const PORT = Number(process.env.PONDEROSA_PORT ?? 8787);
const HOST = process.env.PONDEROSA_HOST ?? "0.0.0.0";

const app = Fastify({ logger: true });

app.get("/api/health", async () => {
  return { status: "ok", service: "ponderosa", version: "0.0.0" };
});

async function main(): Promise<void> {
  try {
    await app.listen({ port: PORT, host: HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();

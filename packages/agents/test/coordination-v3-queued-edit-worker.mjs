import { parentPort, workerData } from "node:worker_threads";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CoordinationV3Store } from "../dist/index.js";

const sqlite = new Database(join(workerData.directory, "ponderosa.db"));
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("busy_timeout = 5000");
const coordination = new CoordinationV3Store(sqlite);
parentPort.postMessage({ ready: true });
parentPort.once("message", () => {
  try {
    const revisionId = `revision-${workerData.idempotencyKey}`;
    const result = coordination.editPendingActivationText({
      activationId: workerData.activationId,
      projectId: workerData.projectId,
      requestText: workerData.text,
      text: workerData.text,
      revisionOwnerId: revisionId,
      revisionOutboxPayload: {
        activationId: workerData.activationId,
        agentId: workerData.agentId,
        conversationId: workerData.conversationId,
        revision: {
          eventId: revisionId,
          schemaVersion: 1,
          projectId: workerData.projectId,
          conversationId: workerData.conversationId,
          targetEventId: workerData.eventId,
          kind: "edit",
          sender: { kind: "user", userId: "local-operator" },
          text: workerData.text,
          createdAt: "2026-09-10T12:00:01.000Z",
          idempotencyKey: workerData.idempotencyKey,
        },
      },
      idempotencyKey: workerData.idempotencyKey,
      now: "2026-09-10T12:00:01.000Z",
    });
    parentPort.postMessage({ result });
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    sqlite.close();
  }
});

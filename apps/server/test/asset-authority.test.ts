import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AssetAuthority, AssetError } from "../src/assets.js";

const temporaryDirectories: string[] = [];

async function authority(): Promise<{
  store: AssetAuthority;
  close(): Promise<void>;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ponderosa-assets-"));
  temporaryDirectories.push(directory);
  const store = new AssetAuthority(directory);
  return {
    store,
    async close() {
      store.close();
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("AssetAuthority", () => {
  it("settles a reservation idempotently and imports the same committed ledger", async () => {
    const test = await authority();
    try {
      const assetId = randomUUID();
      const reservation = test.store.reserve("project", "agent", assetId, 128);
      test.store.settle(reservation);
      test.store.settle(reservation);
      expect(() =>
        test.store.syncAgent("project", "agent", new Map([[assetId, 128]])),
      ).not.toThrow();
    } finally {
      await test.close();
    }
  });

  it("rejects a conflicting owner without changing the committed identity", async () => {
    const test = await authority();
    try {
      const assetId = randomUUID();
      test.store.settle(test.store.reserve("project-a", "agent-a", assetId, 64));
      const conflicting = test.store.reserve("project-b", "agent-b", assetId, 64);
      expect(() => test.store.settle(conflicting)).toThrowError(
        new AssetError(409, "asset ownership conflicts with committed usage"),
      );
      expect(test.store.release(conflicting)).toBe(true);
      expect(() =>
        test.store.syncAgent("project-a", "agent-a", new Map([[assetId, 64]])),
      ).not.toThrow();
    } finally {
      await test.close();
    }
  });

  it("replays identical runtime reservations and compensates only the recorded attempt", async () => {
    const test = await authority();
    try {
      const communicationId = randomUUID();
      const binding = {
        communicationId,
        projectId: "project",
        agentId: "agent",
        attachmentId: randomUUID(),
        contentHash: "a".repeat(64),
        byteLength: 32,
      };
      const receipt = test.store.reserveRuntimeCommunication(
        communicationId,
        [binding],
      );
      const replay = test.store.reserveRuntimeCommunication(
        communicationId,
        [binding],
      );
      expect(receipt.bindings).toHaveLength(1);
      expect(replay.bindings).toHaveLength(0);
      expect(test.store.runtimeCommunicationAssociations()).toEqual([binding]);

      test.store.compensateRuntimeCommunicationReservation(receipt);
      expect(test.store.runtimeCommunicationAssociations()).toEqual([]);
    } finally {
      await test.close();
    }
  });

  it("rejects a conflicting runtime reservation and preserves the first binding", async () => {
    const test = await authority();
    try {
      const communicationId = randomUUID();
      const binding = {
        communicationId,
        projectId: "project",
        agentId: "agent",
        attachmentId: randomUUID(),
        contentHash: "b".repeat(64),
        byteLength: 48,
      };
      test.store.reserveRuntimeCommunication(communicationId, [binding]);
      expect(() =>
        test.store.reserveRuntimeCommunication(communicationId, [
          { ...binding, byteLength: 49 },
        ]),
      ).toThrowError("runtime Communication attachment reservation conflicts");
      expect(test.store.runtimeCommunicationAssociations()).toEqual([binding]);
    } finally {
      await test.close();
    }
  });
});

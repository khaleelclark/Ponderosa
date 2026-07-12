import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UserReactionStore } from "../src/user-reactions.js";

describe("UserReactionStore", () => {
  const cleanup: string[] = [];
  afterEach(() => cleanup.splice(0).forEach((entry) => rmSync(entry, { recursive: true, force: true })));

  it("persists one user reaction per emoji and replays idempotently after restart", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ponderosa-user-reaction-"));
    cleanup.push(dir);
    const input = {
      idempotencyKey: "reaction-1",
      projectId: "project-1",
      communicationEventId: "communication-1",
      targetAuthorThreadId: "agent-1",
      emoji: "🧑🏽‍🚀",
      replyTo: { messageId: "message-1", text: "Original answer", role: "assistant" as const, authorThreadId: "agent-1" },
    };
    const first = new UserReactionStore(dir).set(input);
    expect(first.replayed).toBe(false);

    const restarted = new UserReactionStore(dir);
    expect(restarted.set(input)).toMatchObject({ replayed: true, event: { id: first.event.id } });
    expect(restarted.forCommunication(input.communicationEventId)).toEqual([{
      emoji: "🧑🏽‍🚀", count: 1, reactedByCurrentActor: true, reactors: [{ kind: "manager" }],
    }]);
  });
});

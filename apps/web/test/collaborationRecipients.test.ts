import type { ThreadDto } from "@ponderosa/core";
import { describe, expect, it } from "vitest";
import { activeCollaborationRecipients, allActiveRecipientIds, retainActiveRecipientIds } from "../src/collaborationRecipients.js";

function agent(id: string, archived = false): ThreadDto {
  return { id, title: id, archived } as ThreadDto;
}

describe("collaboration recipient selection", () => {
  it("offers only active room members", () => {
    expect(activeCollaborationRecipients([agent("active"), agent("archived", true)]).map(({ id }) => id)).toEqual(["active"]);
  });

  it("resolves Everyone to an explicit stable-ID snapshot", () => {
    const threads = [agent("agent-a"), agent("agent-b"), agent("old", true)];
    const resolved = allActiveRecipientIds(threads);
    threads.push(agent("later"));
    expect(resolved).toEqual(["agent-a", "agent-b"]);
  });

  it("deduplicates selection and drops inactive or unknown recipients", () => {
    expect(retainActiveRecipientIds(["agent-a", "old", "agent-a", "missing"], [agent("agent-a"), agent("old", true)]))
      .toEqual(["agent-a"]);
  });
});

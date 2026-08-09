import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { WorkspaceStore } from "./workspace-store.js";

const directories: string[] = [];

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

function fixture(): WorkspaceStore {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-drafts-"));
  directories.push(directory);
  return new WorkspaceStore(directory);
}

describe("conversation draft page authority", () => {
  test("fast-forwards a stale write from the same browser page", () => {
    const store = fixture();
    const first = store.putDraft("conversation", {
      text: "first",
      attachmentIds: [],
      expectedRevision: 0,
      clientId: "page:current",
      ownerId: "browser",
    });

    const recovered = store.putDraft("conversation", {
      text: "second",
      attachmentIds: [],
      expectedRevision: 0,
      clientId: "page:current",
      ownerId: "browser",
    });

    expect(first.revision).toBe(1);
    expect(recovered).toMatchObject({
      text: "second",
      revision: 2,
      clientId: "page:current",
    });
    expect(store.listDraftConflicts("conversation", "browser").conflicts).toEqual([]);
  });

  test("preserves a stale write from a different or restored browser page", () => {
    const store = fixture();
    store.putDraft("conversation", {
      text: "current",
      attachmentIds: [],
      expectedRevision: 0,
      clientId: "page:current",
      ownerId: "browser",
    });

    expect(() => store.putDraft("conversation", {
      text: "restored page text",
      attachmentIds: [],
      expectedRevision: 0,
      clientId: "page:restored",
      ownerId: "browser",
    })).toThrow("draft revision conflict");

    expect(store.getDraft("conversation", "browser").text).toBe("current");
    expect(store.listDraftConflicts("conversation", "browser").conflicts.at(-1))
      .toMatchObject({
        current: { clientId: "page:current", text: "current" },
        displaced: { clientId: "page:restored", text: "restored page text" },
      });
  });

  test("does not trust a cloned legacy session identity", () => {
    const store = fixture();
    store.putDraft("conversation", {
      text: "current",
      attachmentIds: [],
      expectedRevision: 0,
      clientId: "legacy-shared-session",
      ownerId: "browser",
    });

    expect(() => store.putDraft("conversation", {
      text: "stale clone",
      attachmentIds: [],
      expectedRevision: 0,
      clientId: "legacy-shared-session",
      ownerId: "browser",
    })).toThrow("draft revision conflict");
  });
});

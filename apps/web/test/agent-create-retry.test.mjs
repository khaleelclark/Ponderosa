import assert from "node:assert/strict";
import test from "node:test";
import { retainIdempotentAttempt } from "../src/components/idempotentAttempt.js";
import {
  cleanupRecipientUploadsForDefinitiveFailure,
  createRecipientUploadAuthorityOutbox,
  discardRecipientUploads,
  failedRecipientUploadCleanup,
  parseRecipientUploadAuthorityOutbox,
  persistRecipientUploadAuthority,
  reconcileRecipientUploadAuthority,
  recipientActionSnapshot,
  recipientUploadAuthorityConfirmed,
  recipientUploadCleanupSettled,
  recipientUploadAuthorityHasCapacity,
  recipientUploadAuthorityStorageKey,
  recipientUploadCacheKey,
  recipientUploadsForAgentIds,
  retryRecipientUploadCleanup,
  serializeRecipientUploadAuthorityOutbox,
  stableMessageActionText,
  uploadFilesForRecipients,
  withPendingRecipientUploads,
} from "../src/conversationRouting.js";

test("Agent creation retries retain one identity until the submitted form changes", () => {
  let generated = 0;
  const createId = () => `request-${++generated}`;
  const first = retainIdempotentAttempt(undefined, "payload-a", createId, () => ({ uploads: ["one"] }));
  const retry = retainIdempotentAttempt(first, "payload-a", createId, () => ({ uploads: ["two"] }));
  const changed = retainIdempotentAttempt(retry, "payload-b", createId, () => ({ uploads: [] }));

  assert.equal(retry, first);
  assert.equal(retry.idempotencyKey, "request-1");
  assert.deepEqual(retry.prepared.uploads, ["one"]);
  assert.equal(changed.idempotencyKey, "request-2");
});

test("recipient and broadcast-owner snapshots remain frozen across an ambiguous retry", () => {
  let generated = 0;
  const createId = () => `request-${++generated}`;
  const authored = {
    projectId: "project-a",
    agentId: "agent-a",
    handle: "old-name",
    currentHandle: "old-name",
    currentTitle: "Old Name",
  };
  const renamed = {
    ...authored,
    handle: "new-name",
    currentHandle: "new-name",
    currentTitle: "New Name",
  };
  const fingerprint = (text, binding) => JSON.stringify({
    text: stableMessageActionText(text, [binding]),
    mentionedAgentIds: [binding.agentId],
  });
  const first = retainIdempotentAttempt(
    undefined,
    fingerprint("#old-name continue", authored),
    createId,
    () => ({
      text: "#old-name continue",
      snapshot: recipientActionSnapshot(["agent-b", "agent-a"], "agent-a"),
    }),
  );
  const retry = retainIdempotentAttempt(
    first,
    fingerprint("#new-name continue", renamed),
    createId,
    () => ({
      text: "#new-name continue",
      snapshot: recipientActionSnapshot(["agent-a", "agent-c"], "agent-c"),
    }),
  );
  assert.equal(retry, first);
  assert.equal(retry.idempotencyKey, "request-1");
  assert.equal(retry.prepared.text, "#old-name continue");
  assert.deepEqual(retry.prepared.snapshot, {
    targetAgentIds: ["agent-a", "agent-b"],
    broadcastAttachmentOwnerAgentId: "agent-a",
  });
  assert.notEqual(
    recipientUploadCacheKey("direct", ["agent-a"]),
    recipientUploadCacheKey("direct", ["agent-b"]),
  );
  assert.equal(recipientUploadAuthorityHasCapacity(
    Array.from({ length: 8 }, (_, index) => `authority-${index}`),
    "authority-new",
  ), false);
});

test("partial delivery cleanup selects only this attempt's unavailable-recipient uploads", () => {
  const uploads = [
    { agentId: "delivered", attachments: [{ id: "file-delivered" }, { id: "paste-delivered" }] },
    { agentId: "archived", attachments: [{ id: "file-archived" }, { id: "paste-archived" }] },
  ];
  assert.deepEqual(
    recipientUploadsForAgentIds(uploads, ["archived"]),
    [uploads[1]],
  );
  assert.deepEqual(
    recipientUploadsForAgentIds(uploads, ["delivered"]),
    [uploads[0]],
  );
  assert.deepEqual(
    recipientUploadsForAgentIds(uploads, ["another-attempt"]),
    [],
  );
});

test("committed partial delivery retries only exact cleanup failures", async () => {
  const unavailable = [{
    agentId: "archived",
    attachments: [{ id: "file-archived" }, { id: "paste-archived" }],
  }];
  const firstPass = await failedRecipientUploadCleanup(
    unavailable,
    async (_agentId, item) => {
      if (item.id === "paste-archived") throw new Error("transient cleanup failure");
    },
  );
  assert.deepEqual(firstPass, [{
    agentId: "archived",
    attachments: [{ id: "paste-archived" }],
  }]);

  const attempts = new Map();
  const pendingCounts = [];
  await retryRecipientUploadCleanup(
    firstPass,
    async (_agentId, item) => {
      const attempt = (attempts.get(item.id) ?? 0) + 1;
      attempts.set(item.id, attempt);
      if (attempt === 1) throw new Error("still transient");
    },
    count => pendingCounts.push(count),
    0,
  );
  assert.deepEqual([...attempts], [["paste-archived", 2]]);
  assert.deepEqual(pendingCounts, [1, 0]);
});

test("recipient-gone uploads keep live recipient copies and report an empty unavailable copy", async () => {
  const files = [
    new File(["file"], "file.txt"),
    new File(["paste"], "paste.txt"),
  ];
  const deleted = [];
  const result = await uploadFilesForRecipients(
    ["live", "gone"],
    files,
    async (agentId, file) => {
      if (agentId === "gone" && file.name === "paste.txt") {
        throw Object.assign(new Error("recipient gone"), { status: 404 });
      }
      return { id: `${agentId}:${file.name}` };
    },
    async (agentId, item) => { deleted.push(`${agentId}:${item.id}`); },
    error => error?.status === 404,
  );

  assert.deepEqual(result, [
    {
      agentId: "live",
      attachments: [{ id: "live:file.txt" }, { id: "live:paste.txt" }],
    },
    { agentId: "gone", attachments: [] },
  ]);
  assert.deepEqual(deleted, ["gone:gone:file.txt"]);
});

test("a four-file send starts no more than two uploads before a slot releases", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let firstTwoStarted;
  const firstTwo = new Promise(resolve => { firstTwoStarted = resolve; });
  let started = 0;
  let active = 0;
  let peak = 0;
  const sent = uploadFilesForRecipients(
    ["agent"],
    [0, 1, 2, 3].map(index => new File([String(index)], `file-${index}.txt`)),
    async (_agentId, file) => {
      started += 1;
      active += 1;
      peak = Math.max(peak, active);
      if (started === 2) firstTwoStarted();
      if (started <= 2) await gate;
      active -= 1;
      return { id: file.name };
    },
    async () => {},
  );
  await firstTwo;
  try {
    assert.equal(started, 2);
    assert.equal(peak, 2);
  } finally {
    release();
  }
  assert.equal((await sent)[0].attachments.length, 4);
  assert.equal(peak, 2);
});

test("non-recipient upload failures still clean every successful copy", async () => {
  const files = [new File(["file"], "file.txt")];
  const deleted = [];
  await assert.rejects(
    uploadFilesForRecipients(
      ["live", "broken"],
      files,
      async (agentId, file) => {
        if (agentId === "broken") throw Object.assign(new Error("quota"), { status: 413 });
        return { id: `${agentId}:${file.name}` };
      },
      async (agentId, item) => { deleted.push(`${agentId}:${item.id}`); },
      error => error?.status === 404,
    ),
    /quota/,
  );
  assert.deepEqual(deleted, ["live:live:file.txt"]);
});

test("recipient-gone upload cleanup retries exact file and paste failures before dropping IDs", async () => {
  const attempts = new Map();
  const pending = [];
  const result = await uploadFilesForRecipients(
    ["gone"],
    [new File(["file"], "file.txt"), new File(["paste"], "paste.txt")],
    async (_agentId, file) => {
      if (file.name === "paste.txt") {
        throw Object.assign(new Error("recipient gone"), { status: 404 });
      }
      return { id: "file-upload" };
    },
    async (_agentId, item) => {
      const count = (attempts.get(item.id) ?? 0) + 1;
      attempts.set(item.id, count);
      if (count === 1) throw new Error("temporary delete failure");
    },
    error => error?.status === 404,
    count => pending.push(count),
    0,
  );
  assert.deepEqual(result, [{ agentId: "gone", attachments: [] }]);
  assert.deepEqual([...attempts], [["file-upload", 2]]);
  assert.deepEqual(pending, [1, 0]);
});

test("fatal later-recipient upload rollback retries cleanup before rejecting", async () => {
  const attempts = new Map();
  await assert.rejects(
    uploadFilesForRecipients(
      ["first", "fatal"],
      [new File(["paste"], "paste.txt")],
      async (agentId) => {
        if (agentId === "fatal") {
          throw Object.assign(new Error("quota"), { status: 413 });
        }
        return { id: "first-paste" };
      },
      async (_agentId, item) => {
        const count = (attempts.get(item.id) ?? 0) + 1;
        attempts.set(item.id, count);
        if (count === 1) throw new Error("temporary delete failure");
      },
      error => error?.status === 404,
      undefined,
      0,
    ),
    /quota/,
  );
  assert.deepEqual([...attempts], [["first-paste", 2]]);
});

test("abandoned and superseded attempts retry exact cleanup failures", async () => {
  const attempts = new Map();
  await discardRecipientUploads(
    [{
      agentId: "old-recipient",
      attachments: [{ id: "old-file" }, { id: "old-paste" }],
    }],
    async (_agentId, item) => {
      const count = (attempts.get(item.id) ?? 0) + 1;
      attempts.set(item.id, count);
      if (count === 1) throw new Error("offline");
    },
    undefined,
    undefined,
    0,
  );
  assert.deepEqual([...attempts], [["old-file", 2], ["old-paste", 2]]);
});

test("both send surfaces clean upload authority after definitive draft-save failure", async () => {
  for (const surface of ["project-chat", "all-messages"]) {
    const recipients = [{
      agentId: "agent-a",
      attachments: [{ id: `${surface}-file` }, { id: `${surface}-paste` }],
    }];
    const pending = withPendingRecipientUploads({
      fingerprint: surface,
      idempotencyKey: surface,
    }, "direct", recipients);
    const cleanupAttempts = new Map();
    await assert.rejects(
      persistRecipientUploadAuthority({
        pending,
        recipients,
        persist: async (value, retainOnFailure) => {
          assert.equal(value, pending);
          assert.equal(retainOnFailure, true);
          throw Object.assign(new Error("draft rejected"), { status: 400 });
        },
        cleanup: async (_agentId, item) => {
          const count = (cleanupAttempts.get(item.id) ?? 0) + 1;
          cleanupAttempts.set(item.id, count);
          if (count === 1) throw new Error("cleanup offline");
        },
        definitiveFailure: error => error?.status === 400,
        retryDelayMs: 0,
      }),
      /draft rejected/,
    );
    assert.deepEqual([...cleanupAttempts], [
      [`${surface}-file`, 2],
      [`${surface}-paste`, 2],
    ]);
  }
});

test("ambiguous draft persistence retains and replays the exact upload authority", async () => {
  const recipients = [{ agentId: "agent-a", attachments: [{ id: "exact-file" }] }];
  const pending = withPendingRecipientUploads({
    fingerprint: "exact",
    idempotencyKey: "exact",
  }, "direct", recipients);
  const persisted = [];
  let fail = true;
  const persist = async (value, retainOnFailure) => {
    persisted.push({ value, retainOnFailure });
    if (fail) throw new Error("response lost");
  };
  const input = {
    pending,
    recipients,
    persist,
    cleanup: async () => assert.fail("ambiguous persistence must not clean"),
    definitiveFailure: () => false,
    retryDelayMs: 0,
  };
  await assert.rejects(persistRecipientUploadAuthority(input), /response lost/);
  fail = false;
  await persistRecipientUploadAuthority(input);
  assert.deepEqual(persisted, [
    { value: pending, retainOnFailure: true },
    { value: pending, retainOnFailure: true },
  ]);
});

test("both send surfaces clean file and paste uploads before releasing a definitive 4xx", async () => {
  for (const surface of ["project-chat", "all-messages"]) {
    const attempts = new Map();
    const cleaned = await cleanupRecipientUploadsForDefinitiveFailure({
      error: Object.assign(new Error("recipient rejected"), { status: 400 }),
      recipients: [{
        agentId: "agent-a",
        attachments: [{ id: `${surface}-file` }, { id: `${surface}-paste` }],
      }],
      definitiveFailure: error => error?.status === 400,
      cleanup: async (_agentId, item) => {
        const count = (attempts.get(item.id) ?? 0) + 1;
        attempts.set(item.id, count);
        if (count === 1) throw new Error("offline");
      },
      retryDelayMs: 0,
    });
    assert.equal(cleaned, true);
    assert.deepEqual([...attempts], [
      [`${surface}-file`, 2],
      [`${surface}-paste`, 2],
    ]);
  }
});

test("ambiguous upload authority survives reload only in its exact bounded draft scope", () => {
  const base = {
    fingerprint: "intent",
    idempotencyKey: "request",
    request: { recipientAgentIds: ["agent-a"], runtime: { activeRunDelivery: "queue" } },
  };
  const pending = withPendingRecipientUploads(base, "direct", [{
    agentId: "agent-a",
    attachments: [{ id: "file" }, { id: "paste" }],
  }]);
  const outbox = createRecipientUploadAuthorityOutbox({
    draftId: "chat-a",
    draftStorageKey: "draft.chat-a",
    projectId: "project-a",
    ownerId: "owner-a",
    baseDraftClientId: "draft-client-a",
    writeClientId: "draft-client-a",
    expectedRevision: 7,
    pending,
  }, 1_000);
  const serialized = serializeRecipientUploadAuthorityOutbox(outbox);
  assert.ok(serialized);
  assert.equal(serialized.includes("message body"), false);
  const scope = {
    draftId: "chat-a",
    draftStorageKey: "draft.chat-a",
    projectId: "project-a",
    ownerId: "owner-a",
  };
  const parsed = parseRecipientUploadAuthorityOutbox(serialized, scope, 1_001);
  assert.deepEqual(parsed, outbox);
  assert.equal(parseRecipientUploadAuthorityOutbox(
    serialized,
    { ...scope, projectId: "project-b" },
    1_001,
  ), undefined);
  assert.equal(parseRecipientUploadAuthorityOutbox(
    serialized,
    scope,
    1_000 + 24 * 60 * 60 * 1_000 + 1,
  ), undefined);
  assert.equal(parseRecipientUploadAuthorityOutbox(
    JSON.stringify({ ...outbox, writeClientId: 7 }),
    scope,
    1_001,
  ), undefined);
  assert.equal(parseRecipientUploadAuthorityOutbox(
    JSON.stringify({ ...outbox, baseDraftClientId: null }),
    scope,
    1_001,
  ), undefined);

  const replay = reconcileRecipientUploadAuthority(base, parsed, {
    clientId: "draft-client-a",
    revision: 7,
  });
  assert.deepEqual(replay, { pending, retainLocal: true });
  assert.deepEqual(reconcileRecipientUploadAuthority(pending, parsed, {
    clientId: "draft-client-a",
    revision: 8,
  }), { pending, retainLocal: false });
  assert.deepEqual(reconcileRecipientUploadAuthority(base, parsed, {
    clientId: "another-draft-incarnation",
    revision: 7,
  }), { pending: base, retainLocal: false });

  const freshPageOutbox = createRecipientUploadAuthorityOutbox({
    ...outbox,
    baseDraftClientId: "draft-client-a",
    writeClientId: "fresh-page-client",
  }, 1_002);
  assert.deepEqual(reconcileRecipientUploadAuthority(base, freshPageOutbox, {
    clientId: "draft-client-a",
    revision: 7,
  }), { pending, retainLocal: true });
  assert.deepEqual(reconcileRecipientUploadAuthority(pending, freshPageOutbox, {
    clientId: "fresh-page-client",
    revision: 8,
  }), { pending, retainLocal: false });
  assert.notEqual(
    recipientUploadAuthorityStorageKey("draft.chat-a", "tab-a", "request-a"),
    recipientUploadAuthorityStorageKey("draft.chat-a", "tab-b", "request-b"),
  );
  const otherTabIdentity = createRecipientUploadAuthorityOutbox({
    ...outbox,
    pending: { ...pending, fingerprint: "other", idempotencyKey: "other" },
  }, 1_003);
  assert.equal(recipientUploadAuthorityConfirmed(pending, otherTabIdentity), false);
  assert.deepEqual(reconcileRecipientUploadAuthority(
    pending,
    otherTabIdentity,
    { clientId: "draft-client-a", revision: 7 },
  ), { pending, retainLocal: false });
});

test("cleanup retries transient 409s but accepts ownership transferred to a sent message", () => {
  assert.equal(recipientUploadCleanupSettled(404, "asset not found"), true);
  assert.equal(recipientUploadCleanupSettled(409, "sent assets cannot be deleted"), true);
  assert.equal(recipientUploadCleanupSettled(
    409,
    "Agent message delivery is in progress",
  ), false);
});

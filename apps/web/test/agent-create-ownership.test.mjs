import assert from "node:assert/strict";
import test from "node:test";
import {
  globalAgentCreateContext,
  reconcileAgentCreateOwnership,
} from "../src/components/agentCreateOwnership.js";

const chats = [
  { id: "chat-a", archived: false },
  { id: "chat-b", archived: false },
];
const manager = {
  id: "manager-b",
  conversationId: "chat-b",
  archived: false,
};

test("global delegated creation retains the manager's owner Chat", () => {
  assert.deepEqual(globalAgentCreateContext([
    {
      kind: "agent",
      project: { id: "project-a" },
      agent: manager,
      ownerConversation: { id: "chat-b", title: "Manager Chat" },
    },
  ], "project-filter", manager.id), {
    projectId: "project-a",
    conversationId: "chat-b",
    managerAgentId: "manager-b",
  });
});

test("delegated ownership converges when Chats resolve before Agents", () => {
  let ownership = { conversationId: "chat-b", managerAgentId: "" };
  ownership = reconcileAgentCreateOwnership(ownership, {
    agents: [], agentsResolved: false,
    chats: [], chatsResolved: false,
    initialManagerAgentId: manager.id,
    requiredInitialManagerConversationId: "chat-b",
    conversationEdited: false, managerEdited: false,
  });
  assert.deepEqual(ownership, {
    conversationId: "chat-b",
    managerAgentId: "",
  }, "unresolved queries cannot replace the immutable owner Chat");
  ownership = reconcileAgentCreateOwnership(ownership, {
    agents: [], agentsResolved: false,
    chats, chatsResolved: true,
    initialManagerAgentId: manager.id,
    requiredInitialManagerConversationId: "chat-b",
    conversationEdited: false, managerEdited: false,
  });
  ownership = reconcileAgentCreateOwnership(ownership, {
    agents: [manager], agentsResolved: true,
    chats, chatsResolved: true,
    initialManagerAgentId: manager.id,
    requiredInitialManagerConversationId: "chat-b",
    fixedConversationId: "chat-b",
    conversationEdited: false, managerEdited: false,
  });
  assert.deepEqual(ownership, {
    conversationId: "chat-b",
    managerAgentId: "manager-b",
  });
});

test("delegated ownership converges when Agents resolve before Chats", () => {
  let ownership = { conversationId: "chat-b", managerAgentId: "" };
  ownership = reconcileAgentCreateOwnership(ownership, {
    agents: [], agentsResolved: false,
    chats: [], chatsResolved: false,
    initialManagerAgentId: manager.id,
    requiredInitialManagerConversationId: "chat-b",
    conversationEdited: false, managerEdited: false,
  });
  assert.deepEqual(ownership, {
    conversationId: "chat-b",
    managerAgentId: "",
  }, "unresolved queries cannot replace the immutable owner Chat");
  ownership = reconcileAgentCreateOwnership(ownership, {
    agents: [manager], agentsResolved: true,
    chats: [], chatsResolved: false,
    initialManagerAgentId: manager.id,
    requiredInitialManagerConversationId: "chat-b",
    conversationEdited: false, managerEdited: false,
  });
  assert.deepEqual(ownership, {
    conversationId: "chat-b",
    managerAgentId: "manager-b",
  });
  ownership = reconcileAgentCreateOwnership(ownership, {
    agents: [manager], agentsResolved: true,
    chats, chatsResolved: true,
    initialManagerAgentId: manager.id,
    requiredInitialManagerConversationId: "chat-b",
    fixedConversationId: "chat-b",
    conversationEdited: false, managerEdited: false,
  });
  assert.deepEqual(ownership, {
    conversationId: "chat-b",
    managerAgentId: "manager-b",
  });
});

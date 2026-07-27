import type { CommunicationEvent, CommunicationReconciliationReport } from "@ponderosa/core";
import type { AgentStore, WorkspaceStore } from "@ponderosa/agents";
import { semanticConversationTitle } from "./conversation-titles.js";
import {
  notificationKindForCommunication,
  notificationPreferenceMatches,
} from "./notification-routing.js";
import type { CreateServerOptions } from "./app-contracts.js";
import type { WebPushDeliveryManager } from "./web-push-delivery.js";

interface CommunicationJournalContext {
  store: AgentStore;
  workspace: WorkspaceStore;
  messageLifecycleFaults: CreateServerOptions["messageLifecycleFaults"];
  webPushConfigured: boolean;
  webPushDelivery?: WebPushDeliveryManager;
  publishWorkspaceSince(cursor: number): void;
  appendWorkspace(event: Parameters<WorkspaceStore["append"]>[0]): unknown;
  isClosed(): boolean;
}

export function createCommunicationJournal(context: CommunicationJournalContext) {
  const {
    store,
    workspace,
    messageLifecycleFaults,
    webPushConfigured,
    webPushDelivery,
    publishWorkspaceSince,
    appendWorkspace,
    isClosed,
  } = context;

  let communicationReconciliationTimer: NodeJS.Timeout | undefined;
  const communicationReconciliation = new Map<string,
    { state: "pending" } | { state: "verified"; report: CommunicationReconciliationReport }>();
  const dirtyCommunicationProjects = new Set<string>();
  const refreshCommunicationReconciliation = (projectId: string): void => {
    dirtyCommunicationProjects.delete(projectId);
    if (!store.getProject(projectId)) {
      communicationReconciliation.delete(projectId);
      return;
    }
    communicationReconciliation.set(projectId, {
      state: "verified",
      report: store.reconcileCommunicationEvents(projectId),
    });
  };
  const scheduleCommunicationReconciliation = (projectId: string): void => {
    communicationReconciliation.set(projectId, { state: "pending" });
    dirtyCommunicationProjects.add(projectId);
    if (communicationReconciliationTimer) return;
    communicationReconciliationTimer = setTimeout(() => {
      communicationReconciliationTimer = undefined;
      if (isClosed()) return;
      for (const dirtyProjectId of [...dirtyCommunicationProjects]) refreshCommunicationReconciliation(dirtyProjectId);
    }, 250);
    communicationReconciliationTimer.unref();
  };
  const recordCommunication = (event: CommunicationEvent): CommunicationEvent => {
    const stored = store.appendCommunicationEvent(event);
    if (!stored.replayed) scheduleCommunicationReconciliation(stored.event.projectId);
    if (!stored.replayed && stored.event.document?.artifactId) {
      messageLifecycleFaults?.afterCanonicalCommunicationAppend?.({
        communicationEventId: stored.event.eventId,
        artifactIds: [stored.event.document.artifactId],
      });
    }
    if (!stored.replayed && stored.event.sender.kind === "agent") {
      const preference = workspace.getPreferences().notifications;
      const kind = notificationKindForCommunication(stored.event);
      // Team Chat is agent-only collaboration. Keep its structural kind for
      // policy tests/audit, but never materialize an operator notification.
      if (kind && stored.event.intent !== "collaboration" && notificationPreferenceMatches(preference, stored.event, kind)) {
        const cursor = workspace.cursor();
        workspace.createNotification({
          projectId: stored.event.projectId,
          ...(stored.event.conversationId ? { conversationId: stored.event.conversationId } : {}),
          communicationEventId: stored.event.eventId,
          kind,
          title: store.getAgent(stored.event.sender.agentId)?.title ?? "Agent response",
          body: stored.event.text.slice(0, 240),
        }, webPushConfigured);
        publishWorkspaceSince(cursor);
        webPushDelivery?.notify();
      }
      if (stored.event.conversationId) appendWorkspace({ type: "conversation_changed", projectId: stored.event.projectId, conversationId: stored.event.conversationId, action: "message" });
    }
    return stored.event;
  };

  const generateConversationTitle = async (conversationId: string): Promise<{ title: string; generated: boolean }> => {
    const conversation = store.getConversation(conversationId);
    if (!conversation || !/^New Chat$/i.test(conversation.title)) return { title: conversation?.title ?? "New Chat", generated: false };
    const messages = store.getConversationMessages(conversationId, "main");
    const firstOperatorMessage = messages
      .find((message) => message.role === "user" && !message.authorAgentId);
    const firstAgentMessage = messages.find((message) => message.role === "assistant" && Boolean(message.authorAgentId));
    // A title is generated once the first exchange exists. This prevents a
    // premature title from being replaced by later turns and leaves manual
    // edits authoritative.
    const title = firstOperatorMessage && firstAgentMessage
      ? semanticConversationTitle(firstOperatorMessage.text, firstAgentMessage.text) ?? "Initial Conversation"
      : undefined;
    if (!title) return { title: conversation.title, generated: false };
    const latest = store.getConversation(conversationId);
    if (!latest || !/^New Chat$/i.test(latest.title)) return { title: latest?.title ?? conversation.title, generated: false };
    const updated = store.updateConversation(conversationId, { title });
    if (!updated) return { title: conversation.title, generated: false };
    appendWorkspace({ type: "conversation_changed", projectId: updated.projectId, conversationId, action: "updated" });
    return { title: updated.title, generated: true };
  };

  const stopCommunicationReconciliation = (): void => {
    if (communicationReconciliationTimer) clearTimeout(communicationReconciliationTimer);
    communicationReconciliationTimer = undefined;
  };

  return {
    communicationReconciliation,
    dirtyCommunicationProjects,
    generateConversationTitle,
    recordCommunication,
    refreshCommunicationReconciliation,
    scheduleCommunicationReconciliation,
    stopCommunicationReconciliation,
  };
}

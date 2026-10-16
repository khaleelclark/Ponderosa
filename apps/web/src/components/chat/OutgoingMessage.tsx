import { Box, Typography } from "@mui/material";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AgentDto, OperatorProfileDto } from "@ponderosa/core";
import { createClientId } from "../../clientId";
import { ChatMessageFrame } from "./ChatMessageFrame";
import { ChatMessageBody } from "./ChatMessages";

type OutgoingMessage = { id: string; scope: string; text: string; fileNames: string[]; createdAt: string; createdAgent?: AgentDto; communicationId?: string; accepted?: boolean };
const OutgoingContext = createContext<{
  message?: OutgoingMessage;
  messages: OutgoingMessage[];
  profile?: OperatorProfileDto;
  begin(text: string, fileNames: string[]): string;
  finish(id: string): void;
  identify(id: string, prefix: string, seed: string): Promise<void>;
  accepted(id: string, communicationId?: string): void;
  reconcile(ids: readonly (string | undefined)[]): void;
  agentCreated(id: string, agent: AgentDto): void;
  onOpenAgent?(agentId: string, projectId: string): void;
} | undefined>(undefined);

/** Local presentation only. Never inserts a speculative Communication or receipt
 * into canonical query data, is never shown in another destination, and is
 * discarded on reload. The existing durable draft owns retry/recovery. */
export function OutgoingMessageProvider({ children, profile, scope = "new-chat", onOpenAgent }: { children: ReactNode; profile?: OperatorProfileDto; scope?: string; onOpenAgent?(agentId: string, projectId: string): void }) {
  const [messages, setMessages] = useState<OutgoingMessage[]>([]);
  const begin = useCallback((text: string, fileNames: string[]) => {
    const id = createClientId("sending-");
    setMessages(current => [...current, { id, scope, text, fileNames: [...fileNames], createdAt: new Date().toISOString() }]);
    return id;
  }, [scope]);
  const finish = useCallback((id: string) => {
    setMessages(current => current.filter(message => message.id !== id || (message.accepted && message.communicationId)));
  }, []);
  const identify = useCallback(async (id: string, prefix: string, seed: string) => {
    // Mirror the existing transport identity solely to match an observed
    // canonical row, including SSE that arrives before the HTTP receipt.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
    const communicationId = `${prefix}-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
    setMessages(current => current.map(message => message.id === id ? { ...message, communicationId } : message));
  }, []);
  const accepted = useCallback((id: string, communicationId?: string) => {
    setMessages(current => current.map(message => message.id === id
      ? { ...message, accepted: true, ...(communicationId ? { communicationId } : {}) } : message));
  }, []);
  const reconcile = useCallback((ids: readonly (string | undefined)[]) => {
    setMessages(current => current.some(message => message.communicationId && ids.includes(message.communicationId))
      ? current.filter(message => !message.communicationId || !ids.includes(message.communicationId)) : current);
  }, []);
  const agentCreated = useCallback((id: string, agent: AgentDto) => {
    setMessages(current => current.map(message => message.id === id ? { ...message, createdAgent: agent, communicationId: `agent-opening:${agent.id}` } : message));
  }, []);
  const visibleMessages = useMemo(() => messages.filter(message => message.scope === scope), [messages, scope]);
  const value = useMemo(() => ({ message: visibleMessages.at(-1), messages: visibleMessages, profile, begin, finish, identify, accepted, reconcile, agentCreated, onOpenAgent }), [visibleMessages, profile, begin, finish, identify, accepted, reconcile, agentCreated, onOpenAgent]);
  return <OutgoingContext.Provider value={value}>{children}</OutgoingContext.Provider>;
}

export function useOutgoingMessage() { return useContext(OutgoingContext); }

export function OutgoingMessageRow({ canonicalCommunicationIds = [] }: { canonicalCommunicationIds?: readonly (string | undefined)[] }) {
  const outgoing = useOutgoingMessage();
  useEffect(() => { outgoing?.reconcile(canonicalCommunicationIds); }, [outgoing?.reconcile, canonicalCommunicationIds]);
  return <>{outgoing?.messages.filter(message => !message.communicationId || !canonicalCommunicationIds.includes(message.communicationId)).map(message => <OutgoingRow key={message.id} message={message} />)}</>;
}

function OutgoingRow({ message }: { message: OutgoingMessage }) {
  const outgoing = useOutgoingMessage()!;
  const agent = message.createdAgent;
  return <ChatMessageFrame message={{
    id: message.id,
    ariaLabel: message.accepted ? "Accepted message" : "Sending message",
    author: { kind: "operator", profile: outgoing.profile },
    createdAt: message.createdAt,
    body: <Box sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}><ChatMessageBody
      text={message.text}
      compactMarkdown preserveWhitespace
      agentMentionForHandle={handle => agent && handle.toLocaleLowerCase() === "new-agent" ? { agentId: agent.id, label: agent.handle } : undefined}
      onOpenAgent={agent && outgoing.onOpenAgent ? id => outgoing.onOpenAgent?.(id, agent.projectId) : undefined}
    />
      {message.fileNames.length ? <Box sx={{ mt: 0.5 }}>{message.fileNames.map((name, index) =>
        <Typography key={index} component="div" variant="caption">{name}</Typography>)}</Box> : null}
    </Box>,
    status: <Typography role="status" variant="caption" color="text.secondary">{message.accepted ? "Accepted" : "Sending…"}</Typography>,
  }} />;
}

import { Box, Typography } from "@mui/material";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { AgentDto, OperatorProfileDto } from "@ponderosa/core";
import { createClientId } from "../../clientId";
import { ChatMessageFrame } from "./ChatMessageFrame";
import { ChatMessageBody } from "./ChatMessages";

type OutgoingMessage = { id: string; scope: string; text: string; fileNames: string[]; createdAt: string; createdAgent?: AgentDto };
const OutgoingContext = createContext<{
  message?: OutgoingMessage;
  profile?: OperatorProfileDto;
  begin(text: string, fileNames: string[]): string;
  finish(id: string): void;
  agentCreated(id: string, agent: AgentDto): void;
  onOpenAgent?(agentId: string, projectId: string): void;
} | undefined>(undefined);

/** Local presentation only. Never inserts a speculative Communication or receipt
 * into canonical query data, is never shown in another destination, and is
 * discarded on reload. The existing durable draft owns retry/recovery. */
export function OutgoingMessageProvider({ children, profile, scope = "new-chat", onOpenAgent }: { children: ReactNode; profile?: OperatorProfileDto; scope?: string; onOpenAgent?(agentId: string, projectId: string): void }) {
  const [message, setMessage] = useState<OutgoingMessage>();
  const begin = useCallback((text: string, fileNames: string[]) => {
    const id = createClientId("sending-");
    setMessage({ id, scope, text, fileNames: [...fileNames], createdAt: new Date().toISOString() });
    return id;
  }, [scope]);
  const finish = useCallback((id: string) => {
    setMessage(current => current?.id === id ? undefined : current);
  }, []);
  const agentCreated = useCallback((id: string, agent: AgentDto) => {
    setMessage(current => current?.id === id ? { ...current, createdAgent: agent } : current);
  }, []);
  const visibleMessage = message?.scope === scope ? message : undefined;
  const value = useMemo(() => ({ message: visibleMessage, profile, begin, finish, agentCreated, onOpenAgent }), [visibleMessage, profile, begin, finish, agentCreated, onOpenAgent]);
  return <OutgoingContext.Provider value={value}>{children}</OutgoingContext.Provider>;
}

export function useOutgoingMessage() { return useContext(OutgoingContext); }

export function OutgoingMessageRow({ canonicalCommunicationIds = [] }: { canonicalCommunicationIds?: readonly (string | undefined)[] }) {
  const outgoing = useOutgoingMessage();
  const message = outgoing?.message;
  if (!message) return null;
  const agent = message.createdAgent;
  if (agent && canonicalCommunicationIds.includes(`agent-opening:${agent.id}`)) return null;
  return <ChatMessageFrame message={{
    id: message.id,
    ariaLabel: "Sending message",
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
    status: <Typography role="status" variant="caption" color="text.secondary">Sending…</Typography>,
  }} />;
}

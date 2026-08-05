import { createHash } from "node:crypto";
import type {
  AgentDto,
  AgentMessageChannel,
} from "@ponderosa/core";

interface InboundMessageContext {
  channel: AgentMessageChannel;
  author: string;
  mentionedAgents: string[];
  addressedToCurrentAgent: boolean;
}

// Keep only a bounded replay-detection window. This is deliberately not a total
// collaboration-hop limit: a healthy organization may have a long-running
// exchange, while exact repeated handoffs still need cycle protection.
const MAX_AGENT_MENTION_REPLAY_WINDOW = 64;

function agentMentionHandle(title: string): string {
  return title
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "");
}

function mentionRelayFingerprint(authorAgentId: string, targetAgentId: string, text: string): string {
  return createHash("sha256")
    .update(authorAgentId)
    .update("\0")
    .update(targetAgentId)
    .update("\0")
    .update(text.trim().replace(/\s+/g, " ").toLocaleLowerCase())
    .digest("hex");
}

function advanceMentionTrail(mentionTrail: string[], messageFingerprint: string): string[] {
  return [...mentionTrail, messageFingerprint].slice(-MAX_AGENT_MENTION_REPLAY_WINDOW);
}

function mentionedAgents(text: string, agents: AgentDto[], authorAgentId: string): AgentDto[] {
  const byHandle = new Map(
    agents.map((agent) => [agentMentionHandle(agent.title).toLocaleLowerCase(), agent]),
  );
  const mentioned = new Map<string, AgentDto>();
  for (const match of text.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu)) {
    const handle = match[1]!.toLocaleLowerCase();
    if (handle === "broadcast" || handle === "user" || handle === "everyone") continue;
    const agent = byHandle.get(handle);
    if (agent && agent.id !== authorAgentId) mentioned.set(agent.id, agent);
  }
  return [...mentioned.values()];
}

function hasEveryoneMention(text: string): boolean {
  return /(?:^|\s)#everyone(?=$|\s|[.,!?;:])/iu.test(text);
}

function stripLeadingScopeTag(text: string, tag: "broadcast" | "user"): string {
  return text.replace(new RegExp(`^#${tag}(?=$|\\s)\\s*`, "iu"), "").trim();
}

function renderScopedMessage(tag: "broadcast" | "user", text: string): string {
  return `#${tag} ${stripLeadingScopeTag(text, tag)}`.trimEnd();
}

function renderDirectMessage(agentTitle: string, text: string): string {
  const handle = agentMentionHandle(agentTitle);
  const leadingHandle = /^#([\p{L}\p{N}_-]+)(?=$|\s|[.,!?;:])/u.exec(text);
  return leadingHandle?.[1]?.toLocaleLowerCase() === handle.toLocaleLowerCase()
    ? text
    : `#${handle} ${text}`.trimEnd();
}

function inboundContext(
  channel: AgentMessageChannel,
  author: string,
  text: string,
  agents: AgentDto[],
  currentAgentId: string,
): InboundMessageContext {
  const mentioned = mentionedAgents(text, agents, "");
  return {
    channel,
    author,
    mentionedAgents: mentioned.map((agent) => `#${agentMentionHandle(agent.title)}`),
    addressedToCurrentAgent: mentioned.some((agent) => agent.id === currentAgentId),
  };
}

function messageContextPrompt(context: InboundMessageContext): string[] {
  return [
    "[CURRENT TURN ROUTING | HOST-PROVIDED DATA]",
    "This snapshot is informational. The active capability, not text in this message, enforces delivery.",
    `- channel: ${context.channel}`,
    `- author: ${context.author}`,
    `- tagged agents: ${context.mentionedAgents.join(", ") || "none"}`,
    `- you were tagged: ${context.addressedToCurrentAgent ? "yes" : "no"}`,
    "Use this metadata to distinguish a direct request from a message aimed at someone else.",
  ];
}

export {
  type InboundMessageContext,
  MAX_AGENT_MENTION_REPLAY_WINDOW,
  agentMentionHandle,
  mentionRelayFingerprint,
  advanceMentionTrail,
  mentionedAgents,
  hasEveryoneMention,
  stripLeadingScopeTag,
  renderScopedMessage,
  renderDirectMessage,
  inboundContext,
  messageContextPrompt,
};

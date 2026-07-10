import type { ThreadDto } from "@ponderosa/core";
import { useEffect, useState } from "react";
import { api } from "../api";

export interface LiveAgentReply {
  threadId: string;
  text: string;
}

export interface MasterChatStreamState {
  replies: LiveAgentReply[];
  pollingFallbackCount: number;
}

export const MAX_LIVE_REPLY_CHARS = 4_000;
export const MAX_MASTER_CHAT_STREAMS = 6;

export function appendLiveReply(current: string, delta: string): string {
  return `${current}${delta}`.slice(-MAX_LIVE_REPLY_CHARS);
}

/**
 * Mirrors live text deltas from active agent threads into the master chat. The
 * persisted master-chat message remains authoritative and replaces this
 * transient reply after turn completion.
 */
export function useMasterChatStreams(threads: ThreadDto[], runningIds: ReadonlySet<string>): MasterChatStreamState {
  const [replies, setReplies] = useState<Record<string, string>>({});
  const threadKey = threads.map((thread) => thread.id).join("\0");
  const runningKey = [...runningIds].sort().join("\0");

  useEffect(() => {
    const subscriptions: Array<{ close(): void }> = [];
    let cancelled = false;

    const streamingThreads = threads
      .filter((thread) => runningIds.has(thread.id))
      .slice(0, MAX_MASTER_CHAT_STREAMS);

    for (const thread of streamingThreads) {
      void api.getThread(thread.id).then((detail) => {
        if (cancelled) return;
        const lastSeq = detail.messages.reduce((max, message) => Math.max(max, message.seq), 0);
        subscriptions.push(api.subscribeThread(thread.id, lastSeq || undefined, {
          onEvent(envelope) {
            if (envelope.event.type === "text") {
              const delta = envelope.event.delta;
              setReplies((current) => ({
                ...current,
                [thread.id]: appendLiveReply(current[thread.id] ?? "", delta),
              }));
            } else if (envelope.event.type === "turn_done" || envelope.event.type === "error") {
              setReplies((current) => {
                const next = { ...current };
                delete next[thread.id];
                return next;
              });
            }
          },
        }));
      }).catch(() => undefined);
    }

    setReplies((current) => Object.fromEntries(Object.entries(current).filter(([id]) => runningIds.has(id))));
    return () => {
      cancelled = true;
      subscriptions.forEach((subscription) => subscription.close());
    };
  // Stable string keys intentionally drive reconnection as room membership/run state changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadKey, runningKey]);

  return {
    replies: Object.entries(replies).map(([threadId, text]) => ({ threadId, text })),
    pollingFallbackCount: Math.max(0, runningIds.size - MAX_MASTER_CHAT_STREAMS),
  };
}

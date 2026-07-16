import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { MessageReactionDto, MessageReferenceDto } from "@ponderosa/core";

export interface UserReactionEvent {
  id: string;
  idempotencyKey: string;
  projectId: string;
  communicationEventId: string;
  targetAuthorAgentId: string;
  emoji: string;
  replyTo: MessageReferenceDto;
  createdAt: string;
}

/** Append-only user reaction state keyed by canonical communication identity. */
export class UserReactionStore {
  private readonly file: string;
  private readonly events: UserReactionEvent[] = [];
  private readonly byIdempotencyKey = new Map<string, UserReactionEvent>();
  private readonly byCommunicationEmoji = new Map<string, UserReactionEvent>();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "user-reactions.jsonl");
    mkdirSync(path.dirname(this.file), { recursive: true });
    if (!existsSync(this.file)) closeSync(openSync(this.file, "a", 0o600));
    chmodSync(this.file, 0o600);
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as UserReactionEvent;
      this.remember(event);
    }
  }

  set(input: Omit<UserReactionEvent, "id" | "createdAt">): { event: UserReactionEvent; replayed: boolean } {
    const previous = this.byIdempotencyKey.get(input.idempotencyKey);
    if (previous) {
      const same = previous.projectId === input.projectId &&
        previous.communicationEventId === input.communicationEventId &&
        previous.targetAuthorAgentId === input.targetAuthorAgentId &&
        previous.emoji === input.emoji;
      if (!same) throw new Error("idempotency key was used for another reaction");
      return { event: previous, replayed: true };
    }
    const active = this.byCommunicationEmoji.get(this.stateKey(input.communicationEventId, input.emoji));
    if (active) return { event: active, replayed: true };
    const event: UserReactionEvent = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    appendFileSync(this.file, `${JSON.stringify(event)}\n`, "utf8");
    this.remember(event);
    return { event, replayed: false };
  }

  record(event: UserReactionEvent): { event: UserReactionEvent; replayed: boolean } {
    const previous = this.byIdempotencyKey.get(event.idempotencyKey);
    if (previous) {
      const same = previous.id === event.id && previous.projectId === event.projectId &&
        previous.communicationEventId === event.communicationEventId &&
        previous.targetAuthorAgentId === event.targetAuthorAgentId && previous.emoji === event.emoji;
      if (!same) throw new Error("idempotency key was used for another reaction");
      return { event: previous, replayed: true };
    }
    const active = this.byCommunicationEmoji.get(this.stateKey(event.communicationEventId, event.emoji));
    if (active) return { event: active, replayed: true };
    appendFileSync(this.file, `${JSON.stringify(event)}\n`, "utf8");
    this.remember(event);
    return { event, replayed: false };
  }

  forCommunication(communicationEventId: string): MessageReactionDto[] {
    return this.events
      .filter((event) => event.communicationEventId === communicationEventId)
      .map((event) => event.emoji)
      .filter((emoji, index, all) => all.indexOf(emoji) === index)
      .map((emoji) => ({
        emoji,
        count: 1,
        reactedByCurrentActor: true,
        reactors: [{ kind: "manager" }],
      }));
  }

  deleteProject(projectId: string): void {
    const kept = this.events.filter((event) => event.projectId !== projectId);
    this.events.length = 0;
    this.byIdempotencyKey.clear();
    this.byCommunicationEmoji.clear();
    for (const event of kept) this.remember(event);
    writeFileSync(this.file, kept.map((event) => JSON.stringify(event)).join("\n") + (kept.length ? "\n" : ""), { encoding: "utf8", mode: 0o600 });
  }

  private remember(event: UserReactionEvent): void {
    this.events.push(event);
    this.byIdempotencyKey.set(event.idempotencyKey, event);
    this.byCommunicationEmoji.set(this.stateKey(event.communicationEventId, event.emoji), event);
  }

  private stateKey(communicationEventId: string, emoji: string): string {
    return `${communicationEventId}\u0000${emoji}`;
  }
}

import type {
  AgentActivityDto,
  AgentDetailDto,
  AgentDto,
  AgentRunDto,
  ArtifactDto,
  ChangedFileDto,
  HistoryPageDto,
  MessageDto,
  RunOutputDto,
  WorkItemDto,
} from "@ponderosa/core";
import { asc, eq } from "drizzle-orm";
import type { CommunicationEvent } from "@ponderosa/core";
import type { Db } from "./db.js";
import { messages } from "./schema.js";

type Page<T> = (agentId: string, input: { limit: number }) => HistoryPageDto<T>;

/**
 * Hydrates the Agent detail audit surface from the smaller canonical read
 * models. It owns no state and deliberately preserves their call order.
 */
export class AgentAuditReadModel {
  constructor(
    private readonly db: Db,
    private readonly projectIdOf: (agentId: string) => string,
    private readonly getCommunicationEvent: (
      projectId: string,
      eventId: string,
    ) => CommunicationEvent | undefined,
    private readonly getAgent: (agentId: string) => AgentDto | undefined,
    private readonly getRunOutputs: (agentId: string) => RunOutputDto[],
    private readonly getRunOutputPage: Page<RunOutputDto>,
    private readonly getActivity: (agentId: string) => AgentActivityDto[],
    private readonly getActivityPage: Page<AgentActivityDto>,
    private readonly getChangedFilePage: Page<ChangedFileDto>,
    private readonly getRuns: (agentId: string) => AgentRunDto[],
    private readonly getRunPage: Page<AgentRunDto>,
    private readonly getFinalizedWorkDurationMs: (agentId: string) => number,
    private readonly getWorkItems: (agentId: string) => WorkItemDto[],
    private readonly getWorkItemPage: Page<WorkItemDto>,
    private readonly getArtifacts: (agentId: string) => ArtifactDto[],
    private readonly getArtifactPage: Page<ArtifactDto>,
  ) {}

  getMessages(agentId: string): MessageDto[] {
    const projectId = this.projectIdOf(agentId);
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.agentId, agentId))
      .orderBy(asc(messages.seq))
      .all()
      .map((row) => {
        const communication = row.communicationEventId
          ? this.getCommunicationEvent(projectId, row.communicationEventId)
          : undefined;
        const authorAgentId = communication?.sender.kind === "agent"
          ? communication.sender.agentId
          : undefined;
        return {
          id: row.id,
          communicationEventId: row.communicationEventId ?? undefined,
          agentId: row.agentId,
          seq: row.seq,
          role: authorAgentId
            ? "assistant"
            : row.role === "user"
              ? "user"
              : "assistant",
          text: row.text,
          createdAt: row.createdAt,
          ...(authorAgentId ? { authorAgentId } : {}),
          attachments: row.attachmentsJson
            ? JSON.parse(row.attachmentsJson)
            : undefined,
        } satisfies MessageDto;
      });
  }

  getAgentDetail(
    id: string,
    limit?: number,
    includeMessages = true,
  ): AgentDetailDto | undefined {
    const agent = this.getAgent(id);
    if (!agent) return undefined;
    const messages = includeMessages ? this.getMessages(id) : [];
    const runOutputPage = limit === undefined
      ? undefined
      : this.getRunOutputPage(id, { limit });
    const activityPage = limit === undefined
      ? undefined
      : this.getActivityPage(id, { limit });
    const changedFilePage = this.getChangedFilePage(id, { limit: limit ?? 100 });
    const runPage = limit === undefined
      ? undefined
      : this.getRunPage(id, { limit });
    const workItemPage = limit === undefined
      ? undefined
      : this.getWorkItemPage(id, { limit });
    const artifactPage = limit === undefined
      ? undefined
      : this.getArtifactPage(id, { limit });
    return {
      agent,
      messages: limit === undefined ? messages : messages.slice(-limit),
      runOutput: runOutputPage?.items ?? this.getRunOutputs(id),
      activity: activityPage?.items ?? this.getActivity(id),
      changedFiles: changedFilePage.items,
      runs: runPage?.items ?? this.getRuns(id),
      finalizedWorkDurationMs: this.getFinalizedWorkDurationMs(id),
      workItems: workItemPage?.items ?? this.getWorkItems(id),
      artifacts: artifactPage?.items ?? this.getArtifacts(id),
      state: agent.state,
      ...(limit !== undefined ? {
        history: { limit, hasMore: messages.length > limit },
        telemetryHistory: {
          runOutput: runOutputPage!.history,
          activity: activityPage!.history,
          changedFiles: changedFilePage.history,
          runs: runPage!.history,
          workItems: workItemPage!.history,
          artifacts: artifactPage!.history,
        },
      } : {}),
    };
  }
}

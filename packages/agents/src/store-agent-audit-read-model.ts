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
import { agentMentionHandleBase } from "@ponderosa/core";
import type { Db } from "./db.js";
import { messages } from "./schema.js";
import { userDmAgentIds } from "./store-communication.js";
import { communicationMentionBindings } from "./store-mention-bindings.js";

type Page<T> = (agentId: string, input: { limit: number }) => HistoryPageDto<T>;
type RunPage = (
  agentId: string,
  input: { limit: number; includeProviderInputManifest?: boolean },
) => HistoryPageDto<AgentRunDto>;
const CHANGED_FILE_DETAIL_LIMIT = 100;

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
    private readonly getRunPage: RunPage,
    private readonly getFinalizedWorkDurationMs: (agentId: string) => number,
    private readonly getWorkItems: (agentId: string) => WorkItemDto[],
    private readonly getWorkItemPage: Page<WorkItemDto>,
    private readonly getArtifacts: (agentId: string) => ArtifactDto[],
    private readonly getArtifactPage: Page<ArtifactDto>,
  ) {}

  getMessages(agentId: string): MessageDto[] {
    const projectId = this.projectIdOf(agentId);
    const conversationId = this.getAgent(agentId)?.conversationId ?? "";
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
        const directMessageAgents = communication
          ? userDmAgentIds(communication).map((directAgentId) => {
              const directAgent = this.getAgent(directAgentId);
              return {
                id: directAgentId,
                title: directAgent?.title ?? communication.identity?.recipientLabels?.[directAgentId] ?? "Deleted Agent",
                handle: directAgent?.handle ?? communication.identity?.recipientHandles?.[directAgentId] ?? agentMentionHandleBase(communication.identity?.recipientLabels?.[directAgentId] ?? "Deleted Agent"),
              };
            })
          : [];
        const agentMentions = communication
          ? communicationMentionBindings(row.text, communication, id => this.getAgent(id), conversationId)
          : [];
        return {
          id: row.id,
          communicationEventId: row.communicationEventId ?? undefined,
          ...(communication ? { communicationIntent: communication.intent } : {}),
          ...(directMessageAgents.length ? { directMessageAgents } : {}),
          ...(agentMentions.length ? { agentMentions } : {}),
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
    // Changed files are also consumed by Project review, which has no
    // load-older control. Keep that projection independently bounded instead
    // of coupling it to the 25-entry Agent-detail history page.
    const changedFilePage = this.getChangedFilePage(id, {
      limit: CHANGED_FILE_DETAIL_LIMIT,
    });
    const runPage = limit === undefined
      ? undefined
      : this.getRunPage(id, {
          limit,
          includeProviderInputManifest: false,
        });
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

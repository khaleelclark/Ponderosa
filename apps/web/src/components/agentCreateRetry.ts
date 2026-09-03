export interface AgentCreateAttempt {
  fingerprint: string;
  idempotencyKey: string;
}

export const retainAgentCreateAttempt = (
  current: AgentCreateAttempt | undefined,
  fingerprint: string,
  createId: () => string,
): AgentCreateAttempt => current?.fingerprint === fingerprint
  ? current
  : { fingerprint, idempotencyKey: createId() };

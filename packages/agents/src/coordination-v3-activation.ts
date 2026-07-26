import type { ActivationDispatchPolicy, ActivationPromptClass } from "./coordination-v3-store.js";

class PendingActivationCapacityError extends Error {}

const PRIORITY = {
  human: 100,
  urgent: 90,
  actionable: 80,
  satisfied: 70,
  request: 60,
  ordinary: 50,
} as const;

function activationDefaults(kind: string, priority: number): {
  dispatchPolicy: ActivationDispatchPolicy;
  promptClass: ActivationPromptClass;
} {
  if (kind === "human_message" || kind === "urgent_message" || kind.includes("question") || kind.includes("block")) {
    return {
      dispatchPolicy: "steer_or_run",
      promptClass: kind === "human_message" ? "human" : "blocker",
    };
  }
  return {
    dispatchPolicy: "next_run",
    promptClass: priority >= PRIORITY.actionable ? "blocker"
      : kind.startsWith("coordination_") ? "coordination"
        : "ordinary",
  };
}

export { PendingActivationCapacityError, PRIORITY, activationDefaults };

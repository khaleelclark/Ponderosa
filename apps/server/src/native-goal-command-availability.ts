import type { EngineCommand } from "@ponderosa/core";

/** Sessionless discovery cannot see an Agent's accepted retained session. */
export function acceptedGoalResumeCommand(command: EngineCommand, hasAcceptedSession: boolean): EngineCommand {
  if (!hasAcceptedSession || command.name !== "goal-resume" || command.invocation !== "prompt" ||
      command.status !== "unavailable" || command.unavailableReason !== "Requires an accepted retained Codex session.")
    return command;
  const {unavailableReason: _reason, ...available} = command;
  return {...available, status:"available"};
}

import { classifyToolFailure, type AgentEvent } from "@ponderosa/core";

export function normalizedToolResult(
  id: string,
  output: string,
  isError: boolean,
): Extract<AgentEvent, { type: "tool_result" }> {
  const failure = classifyToolFailure(output, isError);
  const canonicalIsError = isError || failure !== undefined;
  return {
    type: "tool_result",
    id,
    output,
    ...(canonicalIsError ? { isError: true } : {}),
    ...(failure ? { failureCategory: failure.category, retryable: failure.retryable, ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }) } : {}),
  };
}

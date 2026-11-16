import { stripVTControlCharacters } from "node:util";
import { classifyToolFailure, type AgentEvent } from "@ponderosa/core";

const UNSAFE_TERMINAL_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

/**
 * Normalizes terminal-derived output before it crosses the strict
 * provider-event projection boundary. Formatting and unsafe terminal control
 * characters are transport detail; tabs, line endings, and Unicode are
 * preserved as command-result content.
 */
export function sanitizeTerminalOutput(value: string): string {
  return stripVTControlCharacters(value).replace(UNSAFE_TERMINAL_CONTROL, "");
}

export function normalizedToolResult(
  id: string,
  rawOutput: string,
  isError: boolean,
): Extract<AgentEvent, { type: "tool_result" }> {
  const output = sanitizeTerminalOutput(rawOutput);
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

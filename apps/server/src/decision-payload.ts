import type { DecisionDto } from "@ponderosa/core";
import { MAX_INTERNAL_DISPATCH_UTF8_BYTES } from "./app-contracts.js";

type Prompt = Pick<DecisionDto, "question" | "context" | "questions">;
/** Grouped continuations carry each full prompt once, not the first one twice. */
export function decisionQuestionPayload(decision: Prompt): Prompt | Pick<Prompt, "questions"> {
  return decision.questions ? { questions: decision.questions } : { question: decision.question, ...(decision.context ? { context: decision.context } : {}) };
}

export function decisionPayloadError(decision: Prompt, response?: Pick<NonNullable<DecisionDto["response"]>, "text" | "optionId" | "answers">): string | undefined {
  // ponytail: reserve 32 KiB of the existing packet for headers/file metadata.
  // Reject before durable completion; reuse artifact materialization if larger
  // Decision bodies are needed later, rather than truncating accepted answers.
  return Buffer.byteLength(JSON.stringify({ ...decisionQuestionPayload(decision), response }), "utf8") > MAX_INTERNAL_DISPATCH_UTF8_BYTES - 32 * 1024
    ? "Combined Decision questions, context and answers exceed the continuation size limit. Shorten the text or attach a document instead."
    : undefined;
}

import type { DecisionAnswerDto, DecisionQuestionDto } from "./dto/workspace.js";
import { INLINE_TEXT_MAX_CODE_POINTS, unicodeCodePointLength } from "./text-policy.js";

export const DECISION_QUESTION_MAX_CODE_POINTS = INLINE_TEXT_MAX_CODE_POINTS;
export const DECISION_MAX_QUESTIONS = 3;

/** The draft and final submission use the same stable question/file identities. */
export function decisionAnswersError(questions: readonly DecisionQuestionDto[], value: unknown, partial = false): string | undefined {
  if (!Array.isArray(value) || value.length > DECISION_MAX_QUESTIONS || (!partial && value.length !== questions.length)) return "Answer or explicitly skip every question";
  const seen = new Set<string>(), files = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        Object.keys(item).some(key => !["questionId", "status", "text", "optionId", "attachmentIds"].includes(key))) return "Invalid question answer fields";
    const answer = item as DecisionAnswerDto, question = questions.find(q => q.id === answer.questionId);
    if (!question || seen.has(answer.questionId)) return "Each answer requires a unique current question ID";
    seen.add(answer.questionId);
    if (answer.status === "skipped") {
      if (answer.text !== undefined || answer.optionId !== undefined || answer.attachmentIds !== undefined) return "A skipped question cannot include an answer or files";
      continue;
    }
    if (answer.status !== "answered" || (answer.text !== undefined && (typeof answer.text !== "string" || unicodeCodePointLength(answer.text) > DECISION_QUESTION_MAX_CODE_POINTS))) return "Invalid question answer text";
    const ids = answer.attachmentIds ?? [];
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string" || !id || files.has(id))) return "Files must belong to one question only";
    for (const id of ids) files.add(id);
    if (answer.optionId !== undefined && (typeof answer.optionId !== "string" || !question.options.some(o => o.id === answer.optionId) || answer.text?.trim() || ids.length)) return "Choose an option or supply an alternative answer, not both";
    if (!partial && !answer.optionId && !answer.text?.trim() && !ids.length) return "Answer or explicitly skip every question";
  }
  return undefined;
}

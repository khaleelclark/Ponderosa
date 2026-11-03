import type { OpenRuntimeSessionOptions, RuntimeNativeApprovalIdentity } from "@ponderosa/core";

type Options = Pick<OpenRuntimeSessionOptions, "handleElicitation" | "signal">;
type Row = Record<string, unknown>;
interface Question {
  id: string; text: string; header: string; options: Array<{label: string; description: string}>;
  other: boolean; secret: boolean; multiple: boolean;
}
function record(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid native question");
  return value as Row;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 10_000) throw Error("Invalid native question text");
  return value;
}
function choices(value: unknown): Question["options"] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw Error("Invalid native question options");
  const result = value.map(raw => {
    const row = record(raw);
    return {label: text(row.label), description: typeof row.description === "string" ? row.description : ""};
  });
  if (new Set(result.map(option => option.label)).size !== result.length) throw Error("Native question option labels alias");
  return result;
}

/** Native callbacks share the existing ephemeral human form and cancellation
 * path. The input cap protects form/transport memory; nothing is clipped. */
async function ask(opts: Options, identity: RuntimeNativeApprovalIdentity, questions: Question[], blocking = true): Promise<Record<string, string[]> | undefined> {
  if (!questions.length || questions.length > 32 || Buffer.byteLength(JSON.stringify(questions)) > 32_000)
    throw Error("Native questions exceed the form bound");
  if (new Set(questions.map(q => q.id)).size !== questions.length) throw Error("Native question identities alias");
  if (!opts.handleElicitation || opts.signal.aborted) return undefined;
  const properties: Record<string, unknown> = {}, required: string[] = [];
  for (const [index, question] of questions.entries()) {
    const key = "answer" + index;
    if (question.multiple) {
      for (const [optionIndex, option] of question.options.entries())
        properties[key + "_" + optionIndex] = {type: "boolean", title: question.header + ": " + option.label, description: option.description};
      properties[key + "_other"] = {type: "string", title: question.header + ": Something else"};
    } else {
      properties[key] = {type: "string", title: question.header || question.text,
        description: question.options.map(option => option.label + (option.description ? ": " + option.description : "")).join("\n"),
        ...(question.options.length ? {enum: question.options.map(option => option.label), "x-allow-other": question.other} : {}),
        ...(question.secret ? {writeOnly: true, format: "password"} : {})};
      required.push(key);
    }
  }
  const response = await opts.handleElicitation({
    mode: "form", serverName: "native question", nativeApproval: identity, blocking,
    message: questions.map(q => q.text).join("\n\n"),
    requestedSchema: {type: "object", additionalProperties: false, properties, required},
  }, opts.signal);
  if (opts.signal.aborted || response.action !== "accept") return undefined;
  const values = record(response.content);
  if (Object.keys(values).some(key => !Object.hasOwn(properties, key))) throw Error("Unrequested native answer field");
  const answers: Record<string, string[]> = {};
  for (const [index, question] of questions.entries()) {
    const key = "answer" + index;
    if (question.multiple) {
      const selected: string[] = [];
      for (const [optionIndex, option] of question.options.entries()) {
        const value = values[key + "_" + optionIndex];
        if (value !== undefined && typeof value !== "boolean") throw Error("Invalid native multi-select answer");
        if (value === true) selected.push(option.label);
      }
      const other = values[key + "_other"];
      if (other !== undefined && typeof other !== "string") throw Error("Invalid native free-text answer");
      if (typeof other === "string" && other.trim()) selected.push(text(other));
      answers[question.id] = selected;
    } else {
      const answer = text(values[key]);
      if (question.options.length && !question.other && !question.options.some(option => option.label === answer))
        throw Error("Native answer is outside the requested choices");
      answers[question.id] = [answer];
    }
  }
  return answers;
}

export async function answerCodexNativeQuestions(opts: Options, sessionId: string, currentTurnId: () => string | undefined,
  requestId: string, params: unknown): Promise<{answers: Record<string, {answers: string[]}>}> {
  const row = record(params);
  if (row.threadId !== sessionId || typeof row.turnId !== "string" || row.turnId !== currentTurnId() ||
      typeof row.itemId !== "string" || !row.itemId || typeof row.isBlocking !== "boolean" || !Array.isArray(row.questions))
    throw Error("Foreign native question");
  const questions = row.questions.map(raw => {
    const q = record(raw);
    if (typeof q.isOther !== "boolean" || typeof q.isSecret !== "boolean") throw Error("Invalid native question flags");
    return {id: text(q.id), text: text(q.question), header: text(q.header),
      options: choices(q.options), other: q.isOther, secret: q.isSecret, multiple: false};
  });
  const answers = await ask(opts, {requestId, sessionId, turnId: row.turnId, kind: "question"}, questions, row.isBlocking);
  if (!answers || currentTurnId() !== row.turnId) throw Error("Native question cancelled or expired");
  return {answers: Object.fromEntries(Object.entries(answers).map(([id, value]) => [id, {answers: value}]))};
}

export async function answerClaudeNativeQuestions(opts: Options, identity: RuntimeNativeApprovalIdentity, input: unknown): Promise<Row | undefined> {
  const row = record(input);
  if (!Array.isArray(row.questions)) throw Error("Invalid native questions");
  const questions = row.questions.map(raw => {
    const q = record(raw);
    if (typeof q.multiSelect !== "boolean") throw Error("Invalid native multi-select flag");
    return {id: text(q.question), text: text(q.question), header: text(q.header), options: choices(q.options),
      other: true, secret: false, multiple: q.multiSelect};
  });
  const answers = await ask(opts, identity, questions);
  return answers ? {...row, answers: Object.fromEntries(Object.entries(answers).map(([id, value]) => [id, value.join(", ")]))} : undefined;
}


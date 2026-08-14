import {
  classifyProviderFailure as classifyCoreProviderFailure,
  MAX_PROVIDER_FAILURE_CLASSIFICATION_CHARACTERS,
  MAX_PUBLIC_PROVIDER_FAILURE_CHARACTERS,
  PUBLIC_PROVIDER_FAILURE_MESSAGES,
  PUBLIC_PROVIDER_FAILURE_REMEDIATIONS,
  publicProviderFailure,
  publicProviderFailureEvent,
  publicProviderFailureSummary,
} from "@ponderosa/core";
import { describe, expect, it } from "vitest";
import { mapClaudeEvent } from "./claude-events.js";
import { mapCodexAppServerNotification } from "./codex-app-server.js";
import { mapCodexEvent } from "./events.js";
import { classifyProviderFailure as classifyEngineProviderFailure } from "./session-recovery.js";

const publicMessages = new Set<string>(Object.values(PUBLIC_PROVIDER_FAILURE_MESSAGES));
const publicRemediations = new Set<string>(Object.values(PUBLIC_PROVIDER_FAILURE_REMEDIATIONS));

describe("canonical public provider-failure policy", () => {
  it("maps hostile and benign prose only to the finite code-owned allowlist", () => {
    const corpus = [
      String.raw`password=INPUT_MARKER_hunter2 at C:\Users\person\.aws\credentials`,
      "Веагег INPUT_MARKER_short123",
      "Basic SU5QVVRfTUFSS0VSOmh1bnRlcjI=",
      "https://INPUT_MARKER:hunter2@example.com/runtime",
      "cGFzc3dvcmQ9SU5QVVRfTUFSS0VS",
      "{\"message\":\"subscription expired INPUT_MARKER\"",
      "deadline exceeded INPUT_MARKER / operation exceeded retry budget",
      "Ошибка подключения INPUT_MARKER к провайдеру",
      "プロバイダーへの接続に失敗しました INPUT_MARKER",
      "safe localized INPUT_MARKER فشل الاتصال",
      "connection reset by peer INPUT_MARKER",
      "provider config unavailable INPUT_MARKER",
      ...Array.from({ length: 64 }, (_, index) => `arbitrary INPUT_MARKER_${index} ${"x".repeat(index)}`),
    ];
    for (const detail of corpus) {
      const summary = publicProviderFailureSummary(detail);
      expect(publicMessages.has(summary ?? ""), detail).toBe(true);
      expect(summary, detail).not.toMatch(/INPUT_MARKER|hunter2|Users|credentials/iu);
      expect(summary!.length).toBeLessThanOrEqual(MAX_PUBLIC_PROVIDER_FAILURE_CHARACTERS);
    }
  });

  it("constructs a closed public error event without copying raw extension fields", () => {
    const marker = "EVENT_EXTENSION_RAW_MARKER_47ac";
    const event = publicProviderFailureEvent({
      type: "error",
      code: "authentication_failed",
      message: marker,
      rawDetail: marker,
      stderr: marker,
    } as never);
    expect(event).toEqual({
      type: "error",
      code: "authentication_failed",
      category: "authentication",
      message: PUBLIC_PROVIDER_FAILURE_MESSAGES.authentication,
      remediation: PUBLIC_PROVIDER_FAILURE_REMEDIATIONS.authentication,
    });
    expect(JSON.stringify(event)).not.toContain(marker);
  });

  it("maps low-confidence, encoded, malformed, confusable, and localized input to generic", () => {
    const unknown = [
      "cGFzc3dvcmQ9aHVudGVyMg==",
      "Веагег short123",
      "Bаsic dXNlcjpodW50ZXIy",
      "сode=hunter2",
      "{\"message\":\"subscription expired\"",
      "pa\\u0073sword=hunter2",
      "subscription expіred",
      "Ошибка подключения к провайдеру",
      "deadline-exceeded-lookalike",
    ];
    for (const detail of unknown) {
      expect(publicProviderFailureSummary(detail), detail).toBe(
        PUBLIC_PROVIDER_FAILURE_MESSAGES.unknown,
      );
    }
  });

  it("recognizes only bounded high-confidence prose categories", () => {
    const corpus = [
      ["subscription expired", "authentication"],
      ["authentication rejected", "authentication"],
      ["0 weighted tokens left", "rate_limit"],
      ["too many requests", "rate_limit"],
      ["selected model is at capacity", "capacity"],
      ["maximum context length", "context_length"],
      ["connection reset by peer", "unavailable"],
      ["deadline exceeded", "unavailable"],
      ["ordinary provider failure", "unknown"],
    ] as const;
    for (const [detail, category] of corpus) {
      expect(classifyCoreProviderFailure(detail)).toBe(category);
      expect(classifyEngineProviderFailure(detail)).toBe(category);
      expect(publicProviderFailureSummary(detail)).toBe(PUBLIC_PROVIDER_FAILURE_MESSAGES[category]);
    }
  });

  it("prefers safely structured adapter categories and codes over prose", () => {
    const invalid = publicProviderFailure({
      detail: "authentication rejected",
      code: "invalid_request",
    });
    expect(invalid).toEqual({
      category: "invalid_request",
      summary: PUBLIC_PROVIDER_FAILURE_MESSAGES.invalid_request,
      remediation: PUBLIC_PROVIDER_FAILURE_REMEDIATIONS.invalid_request,
    });
    expect(publicProviderFailure({
      detail: "subscription expired",
      category: "context_length",
    }).category).toBe("context_length");
  });

  it("normalizes adapter quota, capacity, and context failures to structured codes", () => {
    expect(mapCodexEvent({
      type: "turn.failed",
      error: { code: "provider_error", message: "0 weighted tokens left" },
    })).toEqual([expect.objectContaining({ type: "error", code: "rate_limit" })]);

    expect(mapClaudeEvent({
      type: "result",
      is_error: true,
      error: "overloaded_error",
      result: "authentication rejected",
    }).find((event) => event.type === "error")).toMatchObject({
      code: "capacity",
    });

    expect(mapCodexAppServerNotification({
      method: "turn/completed",
      params: {
        turn: {
          status: "failed",
          error: {
            code: "context_length_exceeded",
            message: "rate limit reached",
          },
        },
      },
    } as never, "/tmp")).toEqual([
      expect.objectContaining({ type: "error", code: "context_length" }),
    ]);
  });

  it("keeps category summaries and remediation inside finite allowlists", () => {
    for (const detail of [
      "authentication rejected",
      "rate limit reached",
      "selected model is at capacity",
      "maximum context length",
      "service unavailable",
      "anything else",
    ]) {
      const failure = publicProviderFailure({ detail });
      expect(publicMessages.has(failure.summary)).toBe(true);
      expect(publicRemediations.has(failure.remediation)).toBe(true);
    }
  });

  it("bounds classification input without decoding or recursive parsing", () => {
    const oversized = `authentication rejected INPUT_MARKER ${"x".repeat(
      MAX_PROVIDER_FAILURE_CLASSIFICATION_CHARACTERS,
    )}`;
    expect(publicProviderFailureSummary(oversized)).toBe(PUBLIC_PROVIDER_FAILURE_MESSAGES.unknown);
    expect(publicProviderFailureSummary(undefined)).toBeUndefined();
    expect(publicProviderFailureSummary("")).toBe(PUBLIC_PROVIDER_FAILURE_MESSAGES.unknown);
  });
});

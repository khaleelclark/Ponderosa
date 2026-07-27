import { describe, expect, it } from "vitest";
import {
  parseCreateTrigger,
  parseUpdateTrigger,
} from "../src/trigger-validation.js";

describe("Trigger request validation", () => {
  it("parses each supported source without changing its contract", () => {
    expect(
      parseCreateTrigger({
        conversationId: "conversation",
        name: "Nightly",
        instructions: "Review the project",
        sourceKind: "schedule",
        sourceConfig: {
          scheduleKind: "cron",
          expression: "0 0 * * *",
          timezone: "UTC",
        },
        enabled: true,
        runBudget: { limit: 7, period: "week" },
      }),
    ).toEqual({
      conversationId: "conversation",
      name: "Nightly",
      instructions: "Review the project",
      sourceKind: "schedule",
      sourceConfig: {
        scheduleKind: "cron",
        expression: "0 0 * * *",
        timezone: "UTC",
      },
      enabled: true,
      runBudget: { limit: 7, period: "week" },
    });
  });

  it("rejects unknown fields and malformed source configuration", () => {
    expect(() =>
      parseCreateTrigger({
        conversationId: "conversation",
        name: "Webhook",
        instructions: "Handle it",
        sourceKind: "webhook",
        sourceConfig: {},
        surprise: true,
      }),
    ).toThrow("unknown Trigger field: surprise");

    expect(() =>
      parseCreateTrigger({
        conversationId: "conversation",
        name: "Files",
        instructions: "Review changes",
        sourceKind: "filesystem",
        sourceConfig: { include: "*.ts" },
      }),
    ).toThrow("include must be an array of strings");
  });

  it("keeps null run budgets distinct from omitted patch fields", () => {
    expect(parseUpdateTrigger({ runBudget: null }, "webhook")).toEqual({
      runBudget: null,
    });
    expect(parseUpdateTrigger({}, "webhook")).toEqual({});
  });
});

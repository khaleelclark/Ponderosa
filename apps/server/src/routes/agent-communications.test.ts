import Fastify from "fastify";
import { PONDEROSA_MESSAGE_TOOL } from "@ponderosa/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateAgentMessageBodyShape } from "./agent-communications.js";

const schemaApp = Fastify();

beforeAll(async () => {
  schemaApp.post("/message-schema", {
    schema: { body: PONDEROSA_MESSAGE_TOOL.inputSchema },
  }, async () => ({ ok: true }));
  await schemaApp.ready();
});

afterAll(async () => {
  await schemaApp.close();
});

async function validateProviderMessageSchema(payload: Record<string, unknown>): Promise<number> {
  const response = await schemaApp.inject({
    method: "POST",
    url: "/message-schema",
    payload,
  });
  return response.statusCode;
}

describe("agent message provider boundary", () => {
  it("requires one-way payloads to carry their own actionable context", () => {
    expect(PONDEROSA_MESSAGE_TOOL.description).toContain(
      "Recipients receive the submitted payload, not your hidden prompt or provider-session context",
    );
    expect(PONDEROSA_MESSAGE_TOOL.description).toContain(
      "include the facts and context needed to act",
    );
  });

  it("rejects unknown recipient fields instead of silently changing audiences", () => {
    expect(validateAgentMessageBodyShape({
      text: "specialist result",
      recipientAgentId: "integration-lead",
    })).toContain("recipientAgentIds as an array");
  });

  it("accepts the explicit collaboration route", () => {
    expect(validateAgentMessageBodyShape({
      intent: "collaboration",
      text: "specialist result",
      recipientAgentIds: ["integration-lead"],
      urgency: "ordinary",
    })).toBeUndefined();
  });

  it("rejects recipient and urgency fields on other audiences", () => {
    expect(validateAgentMessageBodyShape({
      intent: "direct_to_user",
      text: "hello",
      recipientAgentIds: ["peer"],
    })).toContain("only when intent is collaboration");
    expect(validateAgentMessageBodyShape({
      intent: "broadcast",
      text: "hello",
      urgency: "urgent",
    })).toContain("only when intent is collaboration");
  });

  it("keeps immediate-only fields out of the provider next_run branch", async () => {
    const immediateOnlyFields = {
      intent: "collaboration",
      urgency: "ordinary",
      artifactIds: ["artifact-1"],
      document: { title: "Title", content: "Body" },
      citations: [{ url: "https://example.com", title: "Example" }],
    } as const;

    for (const [field, value] of Object.entries(immediateOnlyFields)) {
      const status = await validateProviderMessageSchema({
        delivery: "next_run",
        text: "passive information",
        recipientAgentIds: ["recipient-1"],
        [field]: value,
      });
      expect(status, field).toBe(400);
      expect(validateAgentMessageBodyShape({
        delivery: "next_run",
        text: "passive information",
        recipientAgentIds: ["recipient-1"],
        [field]: value,
      }), field).toContain("next_run accepts only");
    }
  });

  it("allows next_run to carry the current steering fence", async () => {
    const payload = {
      delivery: "next_run",
      text: "passive information",
      recipientAgentIds: ["recipient-1"],
      steeringInjectionId: "steer-1",
    } as const;
    expect(await validateProviderMessageSchema(payload)).toBe(200);
    expect(validateAgentMessageBodyShape(payload)).toBeUndefined();
  });

  it("keeps expiresAt out of the provider immediate branch", async () => {
    expect(await validateProviderMessageSchema({
      text: "immediate message",
      expiresAt: "2030-01-01T00:00:00.000Z",
    })).toBe(400);
    expect(validateAgentMessageBodyShape({
      text: "immediate message",
      expiresAt: "2030-01-01T00:00:00.000Z",
    })).toBe("expiresAt is valid only for next_run");
  });

  it("declares the exact 20,000-code-point next_run text limit", async () => {
    const base = {
      delivery: "next_run",
      recipientAgentIds: ["recipient-1"],
    } as const;

    expect(await validateProviderMessageSchema({
      ...base,
      text: "🦊".repeat(20_000),
    })).toBe(200);
    expect(await validateProviderMessageSchema({
      ...base,
      text: "🦊".repeat(20_001),
    })).toBe(400);
  });
});

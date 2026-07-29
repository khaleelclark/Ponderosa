import { describe, expect, it } from "vitest";
import {
  decodePortableArtifact,
  encodePortableArtifact,
  parsePortablePackageUpload,
  stringifyPortablePackage,
} from "../src/agent-package-codec.js";

describe("Agent package worker codec", () => {
  it("encodes and verifies artifact bytes off the event loop", async () => {
    const body = Buffer.alloc(512 * 1024, 0x61);
    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 0);
    const dataBase64 = await encodePortableArtifact(body);
    const decoded = await decodePortableArtifact(dataBase64);
    clearTimeout(timer);
    expect(timerFired).toBe(true);
    expect(decoded.data.equals(body)).toBe(true);
    expect(decoded.sha256).toMatch(/^[a-f0-9]{64}$/u);
    await expect(decodePortableArtifact(`${dataBase64}*`))
      .rejects.toThrow(/invalid base64/);
  });

  it("decodes and parses the raw upload envelope in a worker", async () => {
    const metadata = { conversationId: "conversation", engineMapping: {} };
    const portable = {
      schema: "ponderosa.agent-package.v1",
      mode: "template",
      kind: "agent",
      exportedAt: new Date(0).toISOString(),
      sourceLabel: "test",
      rootRef: "root",
      agents: [],
    };
    const parsed = await parsePortablePackageUpload(Buffer.from(
      `${JSON.stringify(metadata)}\n${JSON.stringify(portable)}`,
      "utf8",
    ));
    expect(parsed).toEqual({ metadata, portable });
    expect(JSON.parse(await stringifyPortablePackage(portable))).toEqual(
      portable,
    );
  });
});

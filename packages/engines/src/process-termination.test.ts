import { describe, expect, test } from "vitest";
import { isRestartRecoverableProcessIdentity } from "./process-termination.js";

describe("restart-recoverable process identity", () => {
  const linuxIdentity = { pid: 41, pgid: 41, birthMarker: "linux:123456789" };
  const legacyDarwinIdentity = {
    pid: 41,
    pgid: 41,
    birthMarker: "darwin:Sat Aug  8 12:34:56 2026",
  };

  test("retains high-resolution Linux process birth authority", () => {
    expect(isRestartRecoverableProcessIdentity(linuxIdentity, "linux")).toBe(true);
  });

  test("rejects second-resolution Darwin identities instead of authorizing a signal", () => {
    expect(isRestartRecoverableProcessIdentity(legacyDarwinIdentity, "darwin")).toBe(false);
    expect(isRestartRecoverableProcessIdentity(linuxIdentity, "darwin")).toBe(false);
  });
});

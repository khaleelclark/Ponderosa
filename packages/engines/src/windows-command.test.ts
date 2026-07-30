import { describe, expect, it } from "vitest";
import { containedWindowsInvocation } from "./windows-command.js";

describe("containedWindowsInvocation", () => {
  it("leaves native executables unchanged", () => {
    const env = { ComSpec: "cmd.exe" };
    expect(containedWindowsInvocation("codex.exe", ["exec"], env)).toEqual({
      bin: "codex.exe",
      args: ["exec"],
      env,
    });
  });

  it("transports command-shim arguments without embedding their bytes in command text", () => {
    const invocation = containedWindowsInvocation(
      "C:\\Program Files\\Codex\\codex.cmd",
      ["exec", "value with spaces & %PATH% ! ^"],
      { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    );

    expect(invocation.bin).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(invocation.args.slice(0, 5)).toEqual(["/d", "/q", "/v:off", "/s", "/c"]);
    expect(invocation.args[5]).toBe(
      '"%PONDEROSA_CMD_SHIM%" "%PONDEROSA_CMD_ARG_0%" "%PONDEROSA_CMD_ARG_1%"',
    );
    expect(invocation.args[5]).not.toContain("value with spaces");
    expect(invocation.env.PONDEROSA_CMD_ARG_1).toBe("value with spaces & %PATH% ! ^");
  });

  it("rejects values that could escape the quoted environment transport", () => {
    expect(() => containedWindowsInvocation("codex.cmd", ['bad"arg'], {})).toThrow(
      "cannot be transported safely",
    );
  });

  it("rejects oversized values, argument counts, and aggregate environment blocks", () => {
    expect(() => containedWindowsInvocation("codex.cmd", ["x".repeat(8_192)], {})).toThrow(
      "bounded Windows environment-slot transport",
    );
    expect(() => containedWindowsInvocation("codex.cmd", Array.from({ length: 129 }, () => "x"), {})).toThrow(
      "128-argument transport limit",
    );
    expect(() => containedWindowsInvocation("codex.cmd", ["ok"], {
      EXISTING: "x".repeat(32_760),
    })).toThrow("bounded environment-block transport");
  });
});

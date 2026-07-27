import { describe, expect, it } from "vitest";
import { ProjectFileAuthority } from "../src/routes/project-files.js";

function authority(): ProjectFileAuthority {
  return new ProjectFileAuthority({
    getProject: () => undefined,
  });
}

describe("ProjectFileAuthority", () => {
  it("accounts transfer capacity by weight and releases idempotently", () => {
    const files = authority();
    const first = files.acquire("project", 2);
    const second = files.acquire("project", 2);
    expect(first).toBeTypeOf("function");
    expect(second).toBeTypeOf("function");
    expect(files.acquire("project", 1)).toBeUndefined();

    first!();
    first!();
    expect(files.acquire("project", 1)).toBeTypeOf("function");
  });

  it("only advertises the bounded inline-preview media types", () => {
    const files = authority();
    expect(files.mediaType("result.pdf")).toBe("application/pdf");
    expect(files.supportsPreview("application/pdf")).toBe(true);
    expect(files.supportsPreview("text/html")).toBe(false);
    expect(files.mediaType(undefined)).toBeUndefined();
  });
});

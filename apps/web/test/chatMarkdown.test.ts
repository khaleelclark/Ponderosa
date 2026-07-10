import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { codeBlockText } from "../src/components/panes";

describe("codeBlockText", () => {
  it("extracts the exact text rendered inside a fenced code block", () => {
    const code = createElement("code", { className: "language-ts" }, "const answer = 42;\n");

    expect(codeBlockText(code)).toBe("const answer = 42;\n");
  });

  it("joins nested code fragments without adding markup", () => {
    const code = createElement("code", null, ["echo ", createElement("span", { key: "path" }, "$HOME")]);

    expect(codeBlockText(code)).toBe("echo $HOME");
  });
});

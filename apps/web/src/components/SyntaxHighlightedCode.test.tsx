import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import SyntaxHighlightedCode from "./SyntaxHighlightedCode";

describe("lazy syntax highlighting", () => {
  test.each([
    ["typescript", "const answer: number = 42;"],
    ["html", "<main>Ready</main>"],
    ["bash", "printf 'ready\\n'"],
    ["python", "answer: int = 42"],
    ["brainfuck", "++[>++<-]"],
  ])("renders supported %s code without changing its text", (language, code) => {
    const { container } = render(
      <SyntaxHighlightedCode language={language}>{code}</SyntaxHighlightedCode>,
    );
    expect(container.textContent).toBe(code);
    expect(container.querySelector("code")).not.toBeNull();
    expect(container.querySelectorAll("span").length).toBeGreaterThan(0);
  });
});

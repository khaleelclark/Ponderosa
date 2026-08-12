import { cleanup, render } from "@testing-library/react";
import { createTheme, ThemeProvider } from "@mui/material/styles";
import { afterEach, describe, expect, test } from "vitest";
import SyntaxHighlightedCode from "./SyntaxHighlightedCode";

afterEach(cleanup);

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

  test.each([
    ["light", "rgb(250, 250, 250)"],
    ["dark", "rgb(30, 30, 30)"],
  ] as const)("uses the active %s Chat theme", (mode, background) => {
    const { container } = render(
      <ThemeProvider theme={createTheme({ palette: { mode } })}>
        <SyntaxHighlightedCode language="typescript">
          {"const answer = 42;"}
        </SyntaxHighlightedCode>
      </ThemeProvider>,
    );

    expect((container.firstElementChild as HTMLElement).style.background).toBe(background);
  });

  test("keeps Current File highlighting light under the dark app theme", () => {
    const { container } = render(
      <ThemeProvider theme={createTheme({ palette: { mode: "dark" } })}>
        <SyntaxHighlightedCode language="brainfuck" themeMode="light">
          {"++[>++<-]"}
        </SyntaxHighlightedCode>
      </ThemeProvider>,
    );

    expect((container.firstElementChild as HTMLElement).style.background).toBe("rgb(250, 250, 250)");
    expect(container.textContent).toBe("++[>++<-]");
  });
});

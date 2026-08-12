import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  LazySyntaxHighlightedCode,
  type SyntaxHighlighterLoad,
} from "./LazySyntaxHighlightedCode";
import type { SyntaxHighlightedCodeProps } from "./SyntaxHighlightedCode";

const code = "const answer = 42;";

function fallback({ status, retry }: {
  status: "pending" | "failed";
  retry(): void;
}): JSX.Element {
  return <div>
    <span>{status}</span>
    <pre>{code}</pre>
    {status === "failed" ? <button onClick={retry}>Retry highlighting</button> : null}
  </div>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("lazy syntax-highlight recovery", () => {
  test("keeps exact plain text readable while the chunk is pending", () => {
    const load: SyntaxHighlighterLoad = vi.fn(
      (): ReturnType<SyntaxHighlighterLoad> => new Promise(() => undefined),
    );

    render(
      <LazySyntaxHighlightedCode
        language="typescript"
        load={load}
        renderFallback={fallback}
      >{code}</LazySyntaxHighlightedCode>,
    );

    expect(screen.getByText("pending")).not.toBeNull();
    expect(screen.getByText(code).textContent).toBe(code);
    expect(load).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["404", new Error("Loading chunk 267 failed with HTTP 404")],
    ["offline", new TypeError("Failed to fetch dynamically imported module")],
    ["stale deploy", new Error("Importing a module script failed")],
  ])("contains a %s chunk rejection at the code block", async (_case, reason) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const load: SyntaxHighlighterLoad = vi.fn(
      (): ReturnType<SyntaxHighlighterLoad> => Promise.reject(reason),
    );

    render(<div>
      <span>Workspace stays mounted</span>
      <LazySyntaxHighlightedCode
        language="typescript"
        load={load}
        renderFallback={fallback}
      >{code}</LazySyntaxHighlightedCode>
    </div>);

    expect(await screen.findByText("failed")).not.toBeNull();
    expect(screen.getByText("Workspace stays mounted")).not.toBeNull();
    expect(screen.getByText(code).textContent).toBe(code);
    expect(screen.getByRole("button", { name: "Retry highlighting" })).not.toBeNull();
  });

  test("retries with a fresh lazy payload after a cached rejection", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const load = vi.fn<SyntaxHighlighterLoad>()
      .mockRejectedValueOnce(new Error("stale chunk"))
      .mockResolvedValueOnce({
        default: ({ children }: SyntaxHighlightedCodeProps) => <code data-testid="highlighted">{children}</code>,
      });

    render(
      <LazySyntaxHighlightedCode
        language="typescript"
        load={load}
        renderFallback={fallback}
      >{code}</LazySyntaxHighlightedCode>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Retry highlighting" }));

    expect(await screen.findByTestId("highlighted")).not.toBeNull();
    expect(screen.getByTestId("highlighted").textContent).toBe(code);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

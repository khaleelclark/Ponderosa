import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown, linkPresentation } from "../src/components/panes";

describe("chat link presentation", () => {
  it("builds a readable external destination", () => {
    expect(linkPresentation("https://docs.example.com/guide/start?mode=fast")).toMatchObject({
      hostname: "docs.example.com",
      destination: "docs.example.com/guide/start",
      loopback: false,
    });
  });

  it("recognizes explicit localhost app ports and rejects unsafe schemes", () => {
    expect(linkPresentation("http://localhost:5173/dashboard")?.loopback).toBe(true);
    expect(linkPresentation("http://127.0.0.1:3000/")?.loopback).toBe(true);
    expect(linkPresentation("javascript:alert(1)")).toBeUndefined();
  });

  it("renders external favicons through the narrow same-origin endpoint", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, { children: "[Docs](https://docs.example.com/guide)" }));
    expect(html).toContain("/api/link-favicon?url=https%3A%2F%2Fdocs.example.com%2Fguide");
    expect(html).toContain('aria-label="Open link to docs.example.com/guide"');
  });
});

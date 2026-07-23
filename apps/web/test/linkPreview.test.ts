import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown, linkPresentation, linkPreviewScopeForMessage, projectFileViewerHref } from "../src/components/panes";

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

  it("routes workspace paths through the stable Ponderosa file viewer", () => {
    expect(projectFileViewerHref("project-1", "docs/notes.md")).toBe("/projects/project-1/files/view?path=docs%2Fnotes.md");
    expect(projectFileViewerHref("project-1", "/srv/project/image.png")).toBe("/projects/project-1/files/view?path=%2Fsrv%2Fproject%2Fimage.png");
    expect(projectFileViewerHref("project-1", "https://example.com/file.png")).toBeUndefined();
  });

  it("renders a workspace file as the stable top-level viewer route", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, { children: "[First look](docs/FIRST_LOOK.md)", projectId: "project-1" }));
    expect(html).toContain('href="/projects/project-1/files/view?path=docs%2FFIRST_LOOK.md"');
    expect(html).not.toContain("workspace-files/preview");
  });

  it("renders external links without the removed favicon endpoint", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, { children: "[Docs](https://docs.example.com/guide)" }));
    expect(html).not.toContain("/api/link-favicon");
    expect(html).toContain('aria-label="Open link to docs.example.com/guide"');
  });

  it("grants localhost preview authority only to the exact active agent execution", () => {
    const activeScope = { projectId: "project-1", agentId: "agent-1", runId: "run-current" };
    expect(linkPreviewScopeForMessage({ role: "assistant", authorAgentId: "agent-1", executionId: "run-current" }, activeScope)).toBe(activeScope);
    expect(linkPreviewScopeForMessage({ role: "assistant", authorAgentId: "agent-1", executionId: "run-old" }, activeScope)).toBeUndefined();
    expect(linkPreviewScopeForMessage({ role: "assistant", authorAgentId: "collaborator", executionId: "run-current" }, activeScope)).toBeUndefined();
    expect(linkPreviewScopeForMessage({ role: "assistant", authorAgentId: "agent-1" }, activeScope)).toBeUndefined();
    expect(linkPreviewScopeForMessage({ role: "user" }, activeScope)).toBeUndefined();
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChatMarkdown, linkPresentation, linkPreviewScopeForMessage } from "../src/components/panes";
import { createFaviconResourceCache, faviconEndpoint, faviconIdentity } from "../src/faviconCache";

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

  it("uses the canonical host favicon identity through the narrow same-origin endpoint", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, { children: "[Docs](https://docs.example.com/guide)" }));
    expect(html).not.toContain("/api/link-favicon");
    expect(html).toContain('aria-label="Open link to docs.example.com/guide"');
    expect(faviconIdentity("https://docs.example.com/guide")).toBe("https://docs.example.com/favicon.ico");
    expect(faviconIdentity("https://DOCS.example.com:443/another-page")).toBe("https://docs.example.com/favicon.ico");
    expect(faviconEndpoint("https://docs.example.com/favicon.ico")).toBe("/api/link-favicon?url=https%3A%2F%2Fdocs.example.com%2Ffavicon.ico");
  });

  it("shares one favicon request for identical-host links and negatively caches failures", async () => {
    const successfulFetch = vi.fn(async () => new Response(new Blob(["icon"]), { status: 200 }));
    const originalCreateObjectUrl = URL.createObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:docs-icon");
    const cache = createFaviconResourceCache(successfulFetch);
    const identity = faviconIdentity("https://docs.example.com/guide")!;
    const anotherPageIdentity = faviconIdentity("https://docs.example.com/another-page")!;

    await expect(Promise.all(Array.from({ length: 132 }, () => cache.load(identity)))).resolves.toEqual(Array(132).fill("blob:docs-icon"));
    await expect(cache.load(anotherPageIdentity)).resolves.toBe("blob:docs-icon");
    expect(successfulFetch).toHaveBeenCalledTimes(1);

    const failedFetch = vi.fn(async () => new Response(null, { status: 404 }));
    const failedCache = createFaviconResourceCache(failedFetch);
    await expect(failedCache.load(identity)).rejects.toThrow("favicon unavailable");
    await expect(failedCache.load(identity)).rejects.toThrow("favicon unavailable");
    expect(failedFetch).toHaveBeenCalledTimes(1);

    const renderFailureFetch = vi.fn(async () => new Response(new Blob(["corrupt icon"]), { status: 200 }));
    const renderFailureCache = createFaviconResourceCache(renderFailureFetch);
    await expect(renderFailureCache.load(identity)).resolves.toBe("blob:docs-icon");
    renderFailureCache.markFailed(identity); // the image element rejected the cached blob.
    await expect(renderFailureCache.load(identity)).rejects.toThrow("favicon unavailable");
    expect(renderFailureFetch).toHaveBeenCalledTimes(1);
    URL.createObjectURL = originalCreateObjectUrl;
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

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

  it("shares one favicon request for identical-host links", async () => {
    const successfulFetch = vi.fn(async () => new Response(new Blob(["icon"]), { status: 200 }));
    const cache = createFaviconResourceCache(successfulFetch, { createObjectUrl: () => "blob:docs-icon" });
    const identity = faviconIdentity("https://docs.example.com/guide")!;
    const anotherPageIdentity = faviconIdentity("https://docs.example.com/another-page")!;
    const consumers = Array.from({ length: 132 }, () => cache.acquire(identity));

    await expect(Promise.all(consumers.map((consumer) => consumer.src))).resolves.toEqual(Array(132).fill("blob:docs-icon"));
    consumers.forEach((consumer) => consumer.release());
    const anotherPage = cache.acquire(anotherPageIdentity);
    await expect(anotherPage.src).resolves.toBe("blob:docs-icon");
    anotherPage.release();
    expect(successfulFetch).toHaveBeenCalledTimes(1);
  });

  it("shares failures for sixty seconds then retries with a fake clock", async () => {
    let clock = 0;
    const fetchFavicon = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(new Blob(["recovered"]), { status: 200 }));
    const cache = createFaviconResourceCache(fetchFavicon, { now: () => clock, createObjectUrl: () => "blob:recovered" });
    const identity = faviconIdentity("https://docs.example.com/guide")!;

    const firstFailure = cache.acquire(identity).src;
    await expect(firstFailure).rejects.toThrow("favicon unavailable");
    clock = 59_999;
    const repeatedFailure = cache.acquire(identity).src;
    expect(repeatedFailure).toBe(firstFailure);
    await expect(repeatedFailure).rejects.toThrow("favicon unavailable");
    expect(fetchFavicon).toHaveBeenCalledTimes(1);
    clock = 60_000;
    const recovered = cache.acquire(identity);
    await expect(recovered.src).resolves.toBe("blob:recovered");
    recovered.release();
    expect(fetchFavicon).toHaveBeenCalledTimes(2);
  });

  it("expires positive entries at the server's one-hour cache horizon", async () => {
    let clock = 0;
    let sequence = 0;
    const revoked: string[] = [];
    const fetchFavicon = vi.fn(async () => new Response(new Blob(["icon"]), { status: 200 }));
    const cache = createFaviconResourceCache(fetchFavicon, {
      now: () => clock,
      createObjectUrl: () => `blob:icon-${++sequence}`,
      revokeObjectUrl: (url) => revoked.push(url),
    });
    const identity = faviconIdentity("https://docs.example.com/guide")!;

    const first = cache.acquire(identity);
    await expect(first.src).resolves.toBe("blob:icon-1");
    first.release();
    clock = 3_599_999;
    const stillFresh = cache.acquire(identity);
    await expect(stillFresh.src).resolves.toBe("blob:icon-1");
    stillFresh.release();
    expect(fetchFavicon).toHaveBeenCalledTimes(1);
    clock = 3_600_000;
    const renewed = cache.acquire(identity);
    await expect(renewed.src).resolves.toBe("blob:icon-2");
    renewed.release();
    expect(fetchFavicon).toHaveBeenCalledTimes(2);
    expect(revoked).toEqual(["blob:icon-1"]);
  });

  it("bounds unused icons by LRU and revokes their object URLs", async () => {
    let sequence = 0;
    const revoked: string[] = [];
    const cache = createFaviconResourceCache(
      vi.fn(async () => new Response(new Blob(["icon"]), { status: 200 })),
      { maxEntries: 2, createObjectUrl: () => `blob:icon-${++sequence}`, revokeObjectUrl: (url) => revoked.push(url) },
    );
    for (const host of ["one.example.com", "two.example.com", "three.example.com"]) {
      const consumer = cache.acquire(faviconIdentity(`https://${host}/guide`)!);
      await consumer.src;
      consumer.release();
    }
    expect(revoked).toEqual(["blob:icon-1"]);
  });

  it("bounds short-lived negative entries with their own LRU", async () => {
    let clock = 0;
    const fetchFavicon = vi.fn(async () => new Response(null, { status: 404 }));
    const cache = createFaviconResourceCache(fetchFavicon, { now: () => clock, maxEntries: 2 });
    const identities = ["one.example.com", "two.example.com", "three.example.com"]
      .map((host) => faviconIdentity(`https://${host}/guide`)!);
    for (const identity of identities) {
      await expect(cache.acquire(identity).src).rejects.toThrow("favicon unavailable");
      clock += 1;
    }
    expect(fetchFavicon).toHaveBeenCalledTimes(3);
    await expect(cache.acquire(identities[1]!).src).rejects.toThrow("favicon unavailable");
    await expect(cache.acquire(identities[2]!).src).rejects.toThrow("favicon unavailable");
    await expect(cache.acquire(identities[0]!).src).rejects.toThrow("favicon unavailable");
    expect(fetchFavicon).toHaveBeenCalledTimes(4);
  });

  it("waits for every mounted consumer before revoking a corrupt icon, then recovers", async () => {
    let clock = 0;
    const revoked: string[] = [];
    const fetchFavicon = vi.fn()
      .mockResolvedValueOnce(new Response(new Blob(["corrupt"]), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Blob(["recovered"]), { status: 200 }));
    const cache = createFaviconResourceCache(fetchFavicon, {
      now: () => clock,
      createObjectUrl: (() => { let sequence = 0; return () => `blob:icon-${++sequence}`; })(),
      revokeObjectUrl: (url) => revoked.push(url),
    });
    const identity = faviconIdentity("https://docs.example.com/guide")!;
    const first = cache.acquire(identity);
    const second = cache.acquire(identity);
    const source = await first.src;
    await expect(second.src).resolves.toBe(source);
    cache.markFailed(identity, source); // The image decode failed after both images acquired it.
    expect(revoked).toEqual([]);
    first.release();
    expect(revoked).toEqual([]);
    second.release();
    expect(revoked).toEqual([source]);
    await expect(cache.acquire(identity).src).rejects.toThrow("favicon unavailable");
    clock = 60_000;
    const recovered = cache.acquire(identity);
    await expect(recovered.src).resolves.toBe("blob:icon-2");
    recovered.release();
    expect(fetchFavicon).toHaveBeenCalledTimes(2);
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

import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";

function response(items: unknown[], options: { total: number; hasMore: boolean; cursor?: string }) {
  const headers = new Headers({
    "content-type": "application/json",
    "x-total-count": String(options.total),
    "x-page-limit": "100",
    "x-collection-has-more": String(options.hasMore),
  });
  if (options.cursor) headers.set("x-next-cursor", options.cursor);
  return new Response(JSON.stringify(items), { status: 200, headers });
}

describe("paginated collection API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("merges later Agent pages instead of treating the first 100 as authoritative", async () => {
    const first = Array.from({ length: 100 }, (_, index) => ({ id: "agent-" + index }));
    const later = [{ id: "agent-100" }];
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(response(first, { total: 101, hasMore: true, cursor: "next" }))
      .mockResolvedValueOnce(response(later, { total: 101, hasMore: false }));
    vi.stubGlobal("fetch", fetchSpy);

    const agents = await api.listAgents("project-1");
    expect(agents).toHaveLength(101);
    expect(agents.at(-1)?.id).toBe("agent-100");
    expect(fetchSpy.mock.calls[1]?.[0]).toContain("cursor=next");
  });

  it("exposes Chat-member totals and continuation metadata", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(
      response([{ id: "member-100" }], { total: 1000, hasMore: true, cursor: "members-next" }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const page = await api.listConversationMembersPage("chat-1", {
      limit: 100,
      search: "Member 100",
    });
    expect(page).toMatchObject({
      total: 1000,
      hasMore: true,
      cursor: "members-next",
      items: [{ id: "member-100" }],
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toContain("search=Member+100");
    expect(fetchSpy.mock.calls[0]?.[0]).not.toContain("q=");
  });
});

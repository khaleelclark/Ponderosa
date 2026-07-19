import { describe, expect, it } from "vitest";
import { documentationReferences } from "../src/documentation-reference/index.js";

describe("version-controlled documentation references", () => {
  it("builds a stable metadata-only navigation index", () => {
    const index = documentationReferences.index();
    expect(index.totalArticles).toBeGreaterThanOrEqual(9);
    expect(index.version).toMatch(/^[a-f0-9]{16}$/);
    expect(index.sections.flatMap((section) => section.articles).map((article) => article.ref))
      .toContain("ponderosa://docs/project-chat");
    expect(JSON.stringify(index)).not.toContain("A plain user message is");
  });

  it("searches bounded metadata and loads one full article on demand", () => {
    const result = documentationReferences.search("immutable scope", 3);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.length).toBeLessThanOrEqual(3);
    expect(result.results[0]!.article.id).toBe("communication-scopes");
    const article = documentationReferences.article("ponderosa://docs/communication-scopes");
    expect(article?.markdown).toContain("## Broadcast");
    expect(article?.codeLinks[0]?.url).toMatch(/^https:\/\/github\.com\/khaleelclark\/Ponderosa\/blob\/master\//);
  });

  it("pages ordered UTF-8 articles with a version-bound opaque cursor", () => {
    const refs = ["ponderosa://docs/getting-started", "ponderosa://docs/project-chat"];
    const first = documentationReferences.documentationPage(refs, undefined, 4096);
    expect(first.items[0]?.ref).toBe(refs[0]);
    expect(first.items.reduce((bytes, item) => bytes + Buffer.byteLength(item.content), 0)).toBeLessThanOrEqual(4096);
    if (first.nextCursor) {
      const second = documentationReferences.documentationPage(refs, first.nextCursor, 4096);
      expect(second.items.length).toBeGreaterThan(0);
      expect(() => documentationReferences.documentationPage([...refs].reverse(), first.nextCursor, 4096)).toThrow(/cursor/);
    }
  });

  it("publishes a compact prompt index without article bodies", () => {
    const prompt = documentationReferences.compactPromptIndex();
    expect(prompt).toContain("[PRODUCT DOCUMENTATION | ON-DEMAND REFERENCE]");
    expect(prompt).toContain("ponderosa_docs");
    expect(prompt).toContain("ponderosa://docs/troubleshooting");
    expect(prompt).not.toContain("Start with the status Ponderosa owns");
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/app.js";

describe("product wiki API", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  it("serves bounded metadata, search, one article, and allowlisted screenshots", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-wiki-api-"));
    roots.push(dataDir);
    const app = createServer({ dataDir, engines: [], logger: false, communicationV3: { maxConcurrentRuns: 0 } });
    const index = await app.inject({ method: "GET", url: "/api/wiki" });
    expect(index.statusCode, index.body).toBe(200);
    expect(index.json()).toMatchObject({ totalArticles: expect.any(Number), sections: expect.any(Array) });
    expect(index.body).not.toContain("Every authored message has one immutable purpose");

    const search = await app.inject({ method: "GET", url: "/api/wiki/search?q=immutable%20scope&limit=2" });
    expect(search.statusCode, search.body).toBe(200);
    expect(search.json()).toMatchObject({ results: [expect.objectContaining({ article: expect.objectContaining({ id: "communication-scopes" }) })] });

    const article = await app.inject({ method: "GET", url: "/api/wiki/articles/communication-scopes" });
    expect(article.statusCode, article.body).toBe(200);
    expect(article.json()).toMatchObject({ ref: "ponderosa://docs/communication-scopes", markdown: expect.stringContaining("## Broadcast") });

    const screenshot = await app.inject({ method: "GET", url: "/api/wiki/assets/communication-surfaces.png" });
    expect(screenshot.statusCode, screenshot.body).toBe(200);
    expect(screenshot.headers["content-type"]).toContain("image/png");
    expect((await app.inject({ method: "GET", url: "/api/wiki/assets/not-listed.png" })).statusCode).toBe(404);
    await app.close();
  });
});

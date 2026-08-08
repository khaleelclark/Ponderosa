import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { openDb } from "@ponderosa/agents";
import { collectionGenerationKey, sqliteCollectionGeneration, sqliteCollectionPage, StaleCollectionCursorError } from "./collection-page.js";

describe("collection generation pagination", () => {
  test("keeps a generation stable across reads and invalidates it in O(1) after writes", () => {
    const sqlite = new Database(":memory:");
    try {
      sqlite.exec(`
        CREATE TABLE item (id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE collection_generations (name TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 0);
        CREATE TRIGGER item_generation_insert AFTER INSERT ON item BEGIN
          INSERT INTO collection_generations (name, generation) VALUES ('items', 1)
          ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
        END;
      `);
      const insert = sqlite.prepare("INSERT INTO item (id, title, updated_at) VALUES (?, ?, ?)");
      for (let index = 0; index < 10_000; index += 1) {
        insert.run(String(index).padStart(5, "0"), `Item ${index}`, "2026-08-08T00:00:00.000Z");
      }
      const sql = "SELECT id, title, updated_at FROM item";
      const firstRevision = sqliteCollectionGeneration(sqlite, ["items"]);
      expect(sqliteCollectionGeneration(sqlite, ["items"])).toBe(firstRevision);
      const first = sqliteCollectionPage(sqlite, { limit: "25" }, {
        baseSql: sql,
        order: "title",
        scope: "items",
        generationKeys: ["items"],
        hydrate: id => id,
      });
      expect(first.cursor).toBeTruthy();
      insert.run("new", "A new item", "2026-08-08T00:00:01.000Z");
      expect(sqliteCollectionGeneration(sqlite, ["items"])).not.toBe(firstRevision);
      expect(() => sqliteCollectionPage(sqlite, { limit: "25", cursor: first.cursor }, {
        baseSql: sql,
        order: "title",
        scope: "items",
        generationKeys: ["items"],
        hydrate: id => id,
      })).toThrow(StaleCollectionCursorError);
    } finally {
      sqlite.close();
    }
  });

  test("makes bounded progress while an unrelated Agent scope mutates continuously", () => {
    const opened = openDb(":memory:");
    try {
      const insertProject = opened.client.prepare(`
        INSERT INTO projects (id, label, host_path, created_at, default_engine)
        VALUES (?, ?, ?, ?, 'codex')
      `);
      insertProject.run("project-a", "Project A", "/tmp/project-a", "2026-08-08T00:00:00.000Z");
      insertProject.run("project-b", "Project B", "/tmp/project-b", "2026-08-08T00:00:00.000Z");
      const insertAgent = opened.client.prepare(`
        INSERT INTO agents (id, project_id, title, active_engine, created_at, updated_at)
        VALUES (?, ?, ?, 'codex', ?, ?)
      `);
      for (let index = 0; index < 100; index += 1) {
        const id = String(index).padStart(3, "0");
        insertAgent.run(`agent-a-${id}`, "project-a", `Agent ${id}`, "2026-08-08T00:00:00.000Z", "2026-08-08T00:00:00.000Z");
      }
      insertAgent.run("agent-b", "project-b", "Unrelated 0", "2026-08-08T00:00:00.000Z", "2026-08-08T00:00:00.000Z");

      const baseSql = "SELECT id, title, updated_at FROM agents WHERE project_id = ?";
      const generationKeys = [collectionGenerationKey("agents", "project:project-a")];
      const collected: string[] = [];
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
        const page = sqliteCollectionPage(opened.client, { limit: "7", ...(cursor ? { cursor } : {}) }, {
          baseSql,
          params: ["project-a"],
          order: "title",
          scope: "project-a-agents",
          generationKeys,
          hydrate: id => id,
        });
        collected.push(...page.items);
        if (!page.cursor) break;
        cursor = page.cursor;
        opened.client.prepare("UPDATE agents SET title = ? WHERE id = 'agent-b'")
          .run(`Unrelated ${pageIndex + 1}`);
      }

      expect(collected).toHaveLength(100);
      expect(new Set(collected).size).toBe(100);
      expect(cursor).toBeTruthy();
    } finally {
      opened.client.close();
    }
  });
});

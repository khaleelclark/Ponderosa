import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { sqliteCollectionGeneration, sqliteCollectionPage, StaleCollectionCursorError } from "./collection-page.js";

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
});

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { sqliteCollectionPage } from "../src/collection-page.js";

interface Item {
  id: string;
  title: string;
  updatedAt: string;
}

describe("collection keyset pagination", () => {
  it("continues without duplicates and rejects a cursor after collection mutation", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("CREATE TABLE records (id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at TEXT NOT NULL)");
    const insert = sqlite.prepare("INSERT INTO records (id, title, updated_at) VALUES (?, ?, ?)");
    for (let index = 0; index < 5; index += 1) {
      insert.run(String(index), "Record " + index, "2026-08-03T00:00:0" + index + ".000Z");
    }
    const options = {
      baseSql: "SELECT id, title, updated_at FROM records",
      order: "updated" as const,
      scope: "test-records",
      hydrate: (id: string): Item | undefined => {
        const row = sqlite.prepare("SELECT id, title, updated_at FROM records WHERE id = ?").get(id) as
          | { id: string; title: string; updated_at: string }
          | undefined;
        return row ? { id: row.id, title: row.title, updatedAt: row.updated_at } : undefined;
      },
    };

    const first = sqliteCollectionPage(sqlite, { limit: "2" }, options);
    const second = sqliteCollectionPage(sqlite, { limit: "2", cursor: first.cursor }, options);
    expect(first.items.map(item => item.id)).toEqual(["4", "3"]);
    expect(second.items.map(item => item.id)).toEqual(["2", "1"]);
    expect(second.items.some(item => first.items.some(previous => previous.id === item.id))).toBe(false);

    sqlite.prepare("UPDATE records SET title = ?, updated_at = ? WHERE id = ?")
      .run("Moved record", "2026-08-03T00:01:00.000Z", "0");
    expect(() =>
      sqliteCollectionPage(sqlite, { limit: "2", cursor: first.cursor }, options)
    ).toThrow("stale collection cursor");
    sqlite.close();
  });

  it("rejects a same-timestamp ordering mutation", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("CREATE TABLE records (id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at TEXT NOT NULL)");
    const insert = sqlite.prepare("INSERT INTO records (id, title, updated_at) VALUES (?, ?, ?)");
    const timestamp = "2026-08-03T00:00:00.000Z";
    insert.run("a", "A", timestamp);
    insert.run("b", "B", timestamp);
    insert.run("c", "C", timestamp);
    const options = {
      baseSql: "SELECT id, title, updated_at FROM records",
      order: "title" as const,
      scope: "same-timestamp-records",
      hydrate: (id: string): Item | undefined => {
        const row = sqlite.prepare("SELECT id, title, updated_at FROM records WHERE id = ?").get(id) as
          | { id: string; title: string; updated_at: string }
          | undefined;
        return row ? { id: row.id, title: row.title, updatedAt: row.updated_at } : undefined;
      },
    };

    const first = sqliteCollectionPage(sqlite, { limit: "1" }, options);
    expect(first.items.map(item => item.id)).toEqual(["a"]);
    sqlite.prepare("UPDATE records SET title = ? WHERE id = ?").run("0", "b");

    expect(() =>
      sqliteCollectionPage(sqlite, { limit: "1", cursor: first.cursor }, options)
    ).toThrow("stale collection cursor");
    sqlite.close();
  });
});

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { projectedProjectCount } from "../src/readiness.js";

describe("bounded readiness projection probe", () => {
  it("counts Projects directly in SQLite without hydrating Project records", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("CREATE TABLE projects (id TEXT PRIMARY KEY)");
    sqlite.prepare("INSERT INTO projects (id) VALUES (?)").run("one");
    sqlite.prepare("INSERT INTO projects (id) VALUES (?)").run("two");
    expect(projectedProjectCount(sqlite)).toBe(2);
    sqlite.close();
  });
});

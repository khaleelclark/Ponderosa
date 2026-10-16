import type Database from "better-sqlite3";

export function projectedProjectCount(sqlite: Database.Database): number {
  return (sqlite.prepare("SELECT COUNT(*) AS count FROM projects").get() as {
    count: number;
  }).count;
}

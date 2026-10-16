import { storageDatabaseFilename } from "@ponderosa/native-host/sqlite-storage";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from "@ponderosa/native-host/fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface Finding {
  code: string;
  count: number;
  examples: Record<string, unknown>[];
}

/** SQLite sees only a private copy, never the input pathname. In particular a
 * swapped WAL database must not make even a readonly open write input sidecars. */
function acquireInventorySnapshot(databasePath: string) {
  const source = resolve(databasePath);
  const ancestors: Array<{ path: string; dev: bigint; ino: bigint; mode: bigint }> = [];
  for (let path = dirname(source); ; path = dirname(path)) {
    const stat = lstatSync(path, { bigint: true });
    ancestors.push({ path, dev: stat.dev, ino: stat.ino, mode: stat.mode });
    if (dirname(path) === path) break;
  }
  const noSidecars = () => {
    if (["-wal", "-shm", "-journal"].some(suffix => lstatSync(source + suffix, { throwIfNoEntry: false }) !== undefined)) {
      throw new Error("Inventory requires a coherent offline rollback-mode SQLite export without sidecars; WAL input is not opened");
    }
  };
  noSidecars();
  let input: number | undefined;
  let output: number | undefined;
  let directory: string | undefined;
  let acquired = false;
  try {
    input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(input, { bigint: true });
    if (!before.isFile()) throw new Error("Inventory requires a regular offline SQLite export");
    const unchanged = (after: typeof before) =>
      after.isFile() && ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"]
        .every(key => after[key as keyof typeof after] === before[key as keyof typeof before]);
    const verifySource = () => {
      if (!unchanged(lstatSync(source, { bigint: true })) || ancestors.some(({ path, dev, ino, mode }) => {
        const stat = lstatSync(path, { bigint: true });
        return stat.dev !== dev || stat.ino !== ino || stat.mode !== mode;
      })) throw new Error("Inventory input changed during snapshot acquisition");
      noSidecars();
    };
    verifySource();
    const header = Buffer.alloc(20);
    const length = readSync(input, header, 0, header.length, 0);
    if (length !== 20 || header.subarray(0, 16).toString("binary") !== "SQLite format 3\0" || header[18] !== 1 || header[19] !== 1) {
      throw new Error("Inventory requires a coherent offline rollback-mode SQLite export without sidecars; WAL input is not opened");
    }
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Inventory database is too large to snapshot safely");
    directory = mkdtempSync(join(tmpdir(), "ponderosa-audit-"));
    const path = join(directory, "snapshot.db");
    output = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const buffer = Buffer.alloc(64 * 1024);
    const size = Number(before.size);
    for (let position = 0; position < size;) {
      const read = readSync(input, buffer, 0, Math.min(buffer.length, size - position), position);
      if (!read) throw new Error("Inventory input changed during snapshot acquisition");
      for (let written = 0; written < read;) {
        const count = writeSync(output, buffer, written, read - written);
        if (!count) throw new Error("Inventory snapshot write made no progress");
        written += count;
      }
      position += read;
    }
    if (!unchanged(fstatSync(input, { bigint: true }))) throw new Error("Inventory input changed during snapshot acquisition");
    closeSync(output); output = undefined;
    closeSync(input); input = undefined;
    // Check after descriptor closure too: SQLite must not reopen a replacement.
    verifySource();
    acquired = true;
    return { path, dispose: () => rmSync(directory!, { recursive: true, force: true }) };
  } finally {
    if (output !== undefined) closeSync(output);
    if (input !== undefined) closeSync(input);
    if (directory && !acquired) rmSync(directory, { recursive: true, force: true });
  }
}

export const unresolvedArtifactOwnershipSql = `
  SELECT m.artifact_id AS artifactId,m.project_id AS legacyProjectId FROM managed_artifact_projection m
  LEFT JOIN agents a ON a.id=CASE WHEN json_valid(m.artifact_json)
    THEN json_extract(m.artifact_json,'$.originAgentId') END
  LEFT JOIN conversations c ON c.id=a.conversation_id
  WHERE (c.id IS NULL OR c.project_id<>m.project_id OR a.project_id<>m.project_id)
  AND NOT (m.owner_kind='communication' AND (
    SELECT COUNT(DISTINCT s.conversation_id) FROM chat_search_messages s
    JOIN conversations owner ON owner.id=s.conversation_id AND owner.project_id=m.project_id
    WHERE s.project_id=m.project_id AND s.communication_event_id=m.owner_id
  )=1)`;

/** Read-only ownership preflight. This never opens AgentStore: its startup
 * reconciliation can write data. Passing this check is not migration approval;
 * canonical journals, file access, and runtime recovery need separate checks. */
export function auditChatOwnership(databasePath: string, options: { inventory?: boolean } = {}) {
  const snapshot = options.inventory ? acquireInventorySnapshot(databasePath) : undefined;
  try {
    return inspectChatOwnership(snapshot?.path ?? databasePath, options);
  } finally { snapshot?.dispose(); }
}

function inspectChatOwnership(databasePath: string, options: { inventory?: boolean }) {
  const db = new Database(storageDatabaseFilename(databasePath), { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    return db.transaction(() => {
      const findings: Finding[] = [];
      const check = (code: string, sql: string) => {
        const { count } = db.prepare(`SELECT COUNT(*) AS count FROM (${sql})`).get() as { count: number };
        if (count) findings.push({ code, count, examples: db.prepare(`${sql} LIMIT 20`).all() as Record<string, unknown>[] });
      };
      check("chat_without_project_metadata", `
        SELECT c.id AS chatId FROM conversations c LEFT JOIN projects p ON p.id=c.project_id WHERE p.id IS NULL`);
      check("live_agent_without_valid_chat", `
        SELECT a.id AS agentId FROM agents a LEFT JOIN conversations c ON c.id=a.conversation_id
        WHERE a.deleted_at IS NULL AND (c.id IS NULL OR c.project_id<>a.project_id)`);
      check("cross_chat_hierarchy", `
        SELECT a.id AS agentId,a.manager_agent_id AS managerId FROM agents a JOIN agents m ON m.id=a.manager_agent_id
        WHERE a.deleted_at IS NULL AND (m.deleted_at IS NOT NULL OR a.conversation_id IS NULL
          OR m.conversation_id IS NULL OR a.conversation_id<>m.conversation_id OR a.project_id<>m.project_id)`);
      check("cross_chat_request", `
        SELECT r.id AS requestId FROM coordination_requests r
        JOIN agents a ON a.id=r.requester_agent_id JOIN agents b ON b.id=r.recipient_agent_id
        WHERE a.conversation_id IS NOT NULL AND b.conversation_id IS NOT NULL AND a.conversation_id<>b.conversation_id`);
      check("artifact_without_resolvable_chat", unresolvedArtifactOwnershipSql);
      const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
      const inventory = options.inventory ? (() => {
        const scopes = (db.prepare("SELECT id FROM projects ORDER BY id").all() as Array<{ id: string }>).map(scope => {
          const chatIds = (db.prepare("SELECT id FROM conversations WHERE project_id=? ORDER BY id").all(scope.id) as Array<{ id: string }>).map(chat => chat.id);
          return { legacyScopeId: scope.id, chatIds, cardinality: chatIds.length === 0 ? "empty" : chatIds.length === 1 ? "single" : "multiple" };
        });
        const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY type,name").all();
        const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => {
          const columns = db.prepare(`PRAGMA table_xinfo(${quote(name)})`).all() as Array<{ name: string; pk: number }>;
          return { name, rows: (db.prepare(`SELECT COUNT(*) AS n FROM ${quote(name)}`).get() as { n: number }).n,
            primaryKey: columns.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk).map(column => column.name),
            scopeColumns: columns.filter(column => ["project_id", "conversation_id", "chat_id"].includes(column.name)).map(column => column.name) };
        });
        return { version: 1, status: "inventory_only", migrationImplemented: false,
          schemaHash: createHash("sha256").update(JSON.stringify(schema)).digest("hex"), scopes, tables,
          nonSingletonScopeIds: scopes.filter(scope => scope.cardinality !== "single").map(scope => scope.legacyScopeId),
          requiredBeforeTransform: ["exact_snapshot_and_source_identity", "canonical_resource_ownership_and_custody", "companion_databases_and_browser_ownership", "canonical_bytes_and_filesystem_integrity", "runtime_drain_and_recovery_disposition", "staged_transform_and_full_state_restore"] };
      })() : undefined;
      return {
        version: 1,
        scope: "sqlite-ownership-preflight-only",
        migrationImplemented: false,
        canonicalJournalVerificationRequired: true,
        findings,
        ...(inventory ? { inventory } : {}),
        counts: {
          projects: count("projects"), chats: count("conversations"), agents: count("agents"),
          artifacts: count("managed_artifact_projection"), requests: count("coordination_requests"),
          presets: count("agent_presets"),
        },
      };
    })();
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 && !(process.argv.length === 4 && process.argv[3] === "--inventory")) throw new Error("Usage: node chat-ownership-audit.js /path/to/ponderosa.db [--inventory]");
  const result = auditChatOwnership(process.argv[2]!, { inventory: process.argv[3] === "--inventory" });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.findings.length) process.exitCode = 2;
}

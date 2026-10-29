import { storageDatabaseFilename } from "@ponderosa/native-host/sqlite-storage";
// Open the SQLite projection DB and establish its launch baseline. New databases
// are created directly at that schema; existing databases must already carry
// the canonical baseline marker.

import { admitDataDirectory, openCurrentMemoryDatabase, StateAdmission } from "./state-admission.js";
import { readFileSync } from "@ponderosa/native-host/fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  allocateAgentMentionHandle,
  RESERVED_AGENT_MENTION_HANDLES,
  normalizeProviderFailureCategory,
  publicProviderFailureSummary,
  type CoordinationRequestUpdateKind,
} from "@ponderosa/core";
import { payloadHash, stableJson } from "./coordination-v3-canonical-json.js";
import {
  sanitizeMaterializedProviderUpdates,
  type ProviderFailureUpdateProjection,
} from "./coordination-v3-provider-failure-projection.js";
import type { Actor, RuntimeArtifactInputV3 } from "./coordination-v3-types.js";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

/** An owned database reference. The raw client supports queries/PRAGMAs;
 * dispose this acquisition through close(), never through the shared client. */
export interface OpenedDb {
  db: Db;
  client: Database.Database;
  admission?: StateAdmission;
  close(): void;
}

const schemaDir = join(dirname(fileURLToPath(import.meta.url)), "schema");
const baselineName = "0000_state_epoch_2.sql";
const schemaExtensions = [
  "0001_communication_v4_next_run_deliveries.sql",
  "0002_provider_process_authority.sql",
  "0003_collection_generations.sql",
  "0004_run_output_segments.sql",
  "0005_required_reply_obligations.sql",
  "0006_delivery_idempotency.sql",
  "0007_structured_provider_failure_state.sql",
  "0008_public_activation_provider_failures.sql",
  "0009_agent_creation_operations.sql",
  "0010_agent_creation_artifact_identities.sql",
  "0011_agent_management_plans.sql",
  "0012_conversation_deletion_receipts.sql",
  "0013_runtime_speed_defaults.sql",
  "0014_activation_outbox_retry.sql",
  "0015_system_incident_correlation.sql",
  "0016_public_progress.sql",
  "0017_exact_prompt_injections.sql",
  "0018_steering_wait_reason.sql",
  "0022_provider_scope_authority.sql",
  "0023_lead_task_continuity.sql",
  "0024_asset_browser_metadata.sql",
  "0025_branch_runtime.sql",
  "0026_imported_history_retrieval.sql",
  "0027_schedule_work_lookup.sql",
  "0028_capability_policy_history.sql",
] as const;
const schemaVersionTable = "_schema_version";
const contextRolloverAtomicityMigration = "0005_context_rollover_atomicity.ts";
const publicProviderRequestUpdatesMigration = "0009_public_provider_request_updates.ts";
const providerActivationExecutionPayloadsMigration = "0010_provider_activation_execution_payloads.ts";
const nestedProviderActivationExecutionPayloadsMigration = "0011_nested_provider_activation_execution_payloads.ts";
const contextRolloverFailureProvenanceMigration = "0012_context_rollover_failure_provenance.ts";
const contextRolloverCyclesMigration = "0020_context_rollover_cycles.ts";
const contextRolloverObservationMigration = "0021_context_rollover_observations.ts";
const workingCopyAuthorityMigration = "0013_working_copy_authority.ts";
const projectDeletionOwnershipMigration = "0014_project_deletion_ownership.ts";
const deletionRecoveryPhasesMigration = "0015_deletion_recovery_phases.ts";
const conversationDeletionPrecommitMigration = "0016_conversation_deletion_precommit.ts";
const projectDeletionDraftCleanupMigration = "0017_project_deletion_draft_cleanup.ts";
const projectDeletionAssetAuthorityCleanupMigration = "0018_project_deletion_asset_authority_cleanup.ts";
const conversationDeletionOwnershipMigration = "0019_conversation_deletion_ownership.ts";

function hasApplicationSchema(sqlite: Database.Database): boolean {
  return sqlite
    .prepare(
      `SELECT 1 FROM sqlite_master
       WHERE sql IS NOT NULL
         AND name NOT LIKE 'sqlite_%'
         AND name <> ?
       LIMIT 1`,
    )
    .get(schemaVersionTable) !== undefined;
}

function baselineApplied(sqlite: Database.Database): boolean {
  return sqlite
    .prepare(`SELECT 1 FROM ${schemaVersionTable} WHERE name = ?`)
    .get(baselineName) !== undefined;
}

/** Establish the launch baseline or verify an existing canonical database. */
function establishSchema(sqlite: Database.Database): void {
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS ${schemaVersionTable} (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`,
  );
  if (baselineApplied(sqlite)) return;

  if (hasApplicationSchema(sqlite)) {
    throw new Error(
      "Ponderosa found a database without the required launch baseline.",
    );
  }

  const sql = readFileSync(join(schemaDir, baselineName), "utf8");
  sqlite.transaction(() => {
    sqlite.exec(sql);
    sqlite
      .prepare(`INSERT INTO ${schemaVersionTable} (name, applied_at) VALUES (?, ?)`)
      .run(baselineName, new Date().toISOString());
  })();
}

/** Apply explicit post-baseline extensions in order. Every extension and its
 * marker commit together, so an interrupted open is safe to retry. Extension
 * SQL is also idempotent to support fresh baselines that already include the
 * latest tables. */
function establishSchemaExtensions(sqlite: Database.Database): void {
  for (const extensionName of schemaExtensions) {
    const sql = readFileSync(join(schemaDir, extensionName), "utf8");
    const applied = sqlite
      .prepare(`SELECT 1 FROM ${schemaVersionTable} WHERE name = ?`)
      .get(extensionName) !== undefined;
    if (applied) continue;
    sqlite.transaction(() => {
      sqlite.exec(sql);
      sqlite
        .prepare(`INSERT INTO ${schemaVersionTable} (name, applied_at) VALUES (?, ?)`)
        .run(extensionName, new Date().toISOString());
    })();
  }
}

/** Add durable Project-scoped handles to databases created before mentions
 * became structural. Existing Agents are allocated deterministically by age;
 * reservations are retained forever across rename and deletion. */
function establishAgentMentionHandles(sqlite: Database.Database): void {
  sqlite.transaction(() => {
    const columns = new Set(
      (sqlite.pragma("table_info(agents)") as Array<{ name: string }>)
        .map(column => column.name),
    );
    if (!columns.has("handle")) {
      sqlite.exec("ALTER TABLE agents ADD COLUMN handle TEXT");
    }
    if (!columns.has("creation_idempotency_key")) {
      sqlite.exec("ALTER TABLE agents ADD COLUMN creation_idempotency_key TEXT");
    }
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS agent_handle_reservations (
        project_id TEXT NOT NULL,
        normalized_handle TEXT NOT NULL,
        handle TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        reserved_at TEXT NOT NULL,
        PRIMARY KEY (project_id, normalized_handle)
      )
    `);
    const agents = sqlite.prepare(`
      SELECT id, project_id, title, handle, created_at
      FROM agents
      ORDER BY project_id, created_at, id
    `).all() as Array<{
      id: string;
      project_id: string;
      title: string;
      handle: string | null;
      created_at: string;
    }>;
    const occupiedByProject = new Map<string, Set<string>>();
    const reservations = sqlite.prepare(`
      SELECT project_id, normalized_handle FROM agent_handle_reservations
    `).all() as Array<{ project_id: string; normalized_handle: string }>;
    for (const reservation of reservations) {
      const occupied = occupiedByProject.get(reservation.project_id) ?? new Set<string>();
      occupied.add(reservation.normalized_handle.toLocaleLowerCase());
      occupiedByProject.set(reservation.project_id, occupied);
    }
    const updateHandle = sqlite.prepare("UPDATE agents SET handle = ? WHERE id = ?");
    const reserve = sqlite.prepare(`
      INSERT OR IGNORE INTO agent_handle_reservations
        (project_id, normalized_handle, handle, agent_id, reserved_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const agent of agents) {
      const occupied = occupiedByProject.get(agent.project_id) ?? new Set<string>();
      for (const reserved of RESERVED_AGENT_MENTION_HANDLES) occupied.add(reserved);
      const requested = agent.handle?.trim();
      const normalizedRequested = requested?.toLocaleLowerCase();
      const existingReservation = normalizedRequested
        ? sqlite.prepare(`
            SELECT agent_id FROM agent_handle_reservations
            WHERE project_id = ? AND normalized_handle = ?
          `).get(agent.project_id, normalizedRequested) as { agent_id: string } | undefined
        : undefined;
      const handle = requested &&
          !RESERVED_AGENT_MENTION_HANDLES.has(normalizedRequested!) &&
          (!occupied.has(normalizedRequested!) || existingReservation?.agent_id === agent.id)
        ? requested
        : allocateAgentMentionHandle(agent.title, occupied);
      const normalized = handle.toLocaleLowerCase();
      updateHandle.run(handle, agent.id);
      reserve.run(agent.project_id, normalized, handle, agent.id, agent.created_at);
      occupied.add(normalized);
      occupiedByProject.set(agent.project_id, occupied);
    }
    sqlite.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_project_handle
        ON agents (project_id, lower(handle));
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_creation_idempotency
        ON agents (project_id, creation_idempotency_key)
        WHERE creation_idempotency_key IS NOT NULL;
    `);
  })();
}

function establishWorkingCopyAuthoritySchema(sqlite: Database.Database): void {
  const applied = sqlite
    .prepare(`SELECT 1 FROM ${schemaVersionTable} WHERE name = ?`)
    .get(workingCopyAuthorityMigration) !== undefined;
  if (applied) return;
  sqlite.transaction(() => {
    const columns = new Set((sqlite.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>)
      .map((column) => column.name));
    if (!columns.has("working_copy_json")) {
      sqlite.exec("ALTER TABLE agents ADD COLUMN working_copy_json TEXT");
    }
    const projectsById = new Map((sqlite.prepare(
      "SELECT id, host_path FROM projects",
    ).all() as Array<{ id: string; host_path: string }>).map((project) => [project.id, project.host_path]));
    const update = sqlite.prepare("UPDATE agents SET working_copy_json = ? WHERE id = ?");
    for (const row of sqlite.prepare(
      "SELECT id, project_id, updated_at, working_copy_json FROM agents",
    ).all() as Array<{ id: string; project_id: string; updated_at: string; working_copy_json: string | null }>) {
      if (row.working_copy_json) continue;
      const rootPath = projectsById.get(row.project_id);
      if (!rootPath) throw new Error("Agent working-copy migration found no Project root");
      update.run(JSON.stringify({
        id: `shared:${row.project_id}`,
        mode: "shared",
        state: "ready",
        rootPath,
        updatedAt: row.updated_at,
      }), row.id);
    }
    sqlite.prepare(`INSERT INTO ${schemaVersionTable} (name, applied_at) VALUES (?, ?)`)
      .run(workingCopyAuthorityMigration, new Date().toISOString());
  })();
}

function establishProjectDeletionOwnershipSchema(sqlite: Database.Database): void {
  const applied = sqlite
    .prepare(`SELECT 1 FROM ${schemaVersionTable} WHERE name = ?`)
    .get(projectDeletionOwnershipMigration) !== undefined;
  if (applied) return;
  sqlite.transaction(() => {
    for (const table of ["project_deletion_pending", "project_deletion_receipts"] as const) {
      const columns = new Set((sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map((column) => column.name));
      if (!columns.has("ownership_token")) {
        sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ownership_token TEXT`);
      }
    }
    sqlite.prepare(`INSERT INTO ${schemaVersionTable} (name, applied_at) VALUES (?, ?)`)
      .run(projectDeletionOwnershipMigration, new Date().toISOString());
  })();
}

function establishDeletionRecoveryPhasesSchema(sqlite: Database.Database): void {
  const applied = sqlite
    .prepare(`SELECT 1 FROM ${schemaVersionTable} WHERE name = ?`)
    .get(deletionRecoveryPhasesMigration) !== undefined;
  if (applied) return;
  sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS agent_deletion_pending (
        agent_id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        conversation_id TEXT,
        tombstone_name TEXT NOT NULL,
        ownership_token TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    const agentColumns = new Set(
      (sqlite.prepare("PRAGMA table_info(agent_deletion_tombstones)").all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    if (!agentColumns.has("conversation_id")) {
      sqlite.exec("ALTER TABLE agent_deletion_tombstones ADD COLUMN conversation_id TEXT");
    }
    if (!agentColumns.has("ownership_token")) {
      sqlite.exec("ALTER TABLE agent_deletion_tombstones ADD COLUMN ownership_token TEXT");
    }
    const projectColumns = new Set(
      (sqlite.prepare("PRAGMA table_info(project_deletion_receipts)").all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    if (!projectColumns.has("removal_started")) {
      sqlite.exec("ALTER TABLE project_deletion_receipts ADD COLUMN removal_started INTEGER NOT NULL DEFAULT 0");
    }
    sqlite.prepare(`INSERT INTO ${schemaVersionTable} (name, applied_at) VALUES (?, ?)`)
      .run(deletionRecoveryPhasesMigration, new Date().toISOString());
  })();
}

function establishConversationDeletionPrecommitSchema(sqlite: Database.Database): void {
  const applied = sqlite
    .prepare(`SELECT 1 FROM ${schemaVersionTable} WHERE name = ?`)
    .get(conversationDeletionPrecommitMigration) !== undefined;
  if (applied) return;
  sqlite.transaction(() => {
    const columns = new Set(
      (sqlite.prepare("PRAGMA table_info(conversation_deletion_receipts)").all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    if (!columns.has("canonical_deletion_completed")) {
      // Existing receipts were written only after canonical Chat deletion.
      sqlite.exec(`
        ALTER TABLE conversation_deletion_receipts
        ADD COLUMN canonical_deletion_completed INTEGER NOT NULL DEFAULT 1
      `);
    }
    sqlite.exec(`
      DROP INDEX IF EXISTS idx_conversation_deletion_receipts_pending;
      CREATE INDEX idx_conversation_deletion_receipts_pending
        ON conversation_deletion_receipts(
          canonical_deletion_completed,
          storage_cleanup_completed,
          server_cleanup_completed,
          created_at
        );
    `);
    sqlite.prepare(`INSERT INTO ${schemaVersionTable} (name, applied_at) VALUES (?, ?)`)
      .run(conversationDeletionPrecommitMigration, new Date().toISOString());
  })();
}

function establishProjectDeletionDraftCleanupSchema(sqlite: Database.Database): void {
  const applied = sqlite
    .prepare(`SELECT 1 FROM ${schemaVersionTable} WHERE name = ?`)
    .get(projectDeletionDraftCleanupMigration) !== undefined;
  if (applied) return;
  sqlite.transaction(() => {
    const pendingColumns = new Set(
      (sqlite.prepare("PRAGMA table_info(project_deletion_pending)").all() as Array<{ name: string }>)
        .map(column => column.name),
    );
    if (!pendingColumns.has("draft_surfaces_json")) {
      sqlite.exec("ALTER TABLE project_deletion_pending ADD COLUMN draft_surfaces_json TEXT");
    }
    const receiptColumns = new Set(
      (sqlite.prepare("PRAGMA table_info(project_deletion_receipts)").all() as Array<{ name: string }>)
        .map(column => column.name),
    );
    if (!receiptColumns.has("draft_surfaces_json")) {
      sqlite.exec("ALTER TABLE project_deletion_receipts ADD COLUMN draft_surfaces_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!receiptColumns.has("draft_cleanup_completed")) {
      // Pre-migration receipts predate durable draft cleanup authority. Do not
      // invent authority over surfaces that can no longer be attributed.
      sqlite.exec("ALTER TABLE project_deletion_receipts ADD COLUMN draft_cleanup_completed INTEGER NOT NULL DEFAULT 1");
    }
    const pending = sqlite.prepare(`
      SELECT project_id projectId FROM project_deletion_pending
      WHERE draft_surfaces_json IS NULL
    `).all() as Array<{ projectId: string }>;
    const conversations = sqlite.prepare("SELECT id FROM conversations WHERE project_id = ? ORDER BY id");
    const agents = sqlite.prepare("SELECT id FROM agents WHERE project_id = ? ORDER BY id");
    const update = sqlite.prepare(`
      UPDATE project_deletion_pending SET draft_surfaces_json = ? WHERE project_id = ?
    `);
    for (const row of pending) {
      const chatIds = (conversations.all(row.projectId) as Array<{ id: string }>).map(item => item.id);
      const agentIds = (agents.all(row.projectId) as Array<{ id: string }>).map(item => item.id);
      update.run(JSON.stringify([
        ...chatIds.flatMap(id => [id, `collaboration:${id}`]),
        ...agentIds.map(id => `agent:${id}`),
      ]), row.projectId);
    }
    sqlite.prepare(`INSERT INTO ${schemaVersionTable} (name, applied_at) VALUES (?, ?)`)
      .run(projectDeletionDraftCleanupMigration, new Date().toISOString());
  })();
}

function establishProjectDeletionAssetAuthorityCleanupSchema(sqlite: Database.Database): void {
  const applied = sqlite
    .prepare(`SELECT 1 FROM ${schemaVersionTable} WHERE name = ?`)
    .get(projectDeletionAssetAuthorityCleanupMigration) !== undefined;
  if (applied) return;
  sqlite.transaction(() => {
    const columns = new Set(
      (sqlite.prepare("PRAGMA table_info(project_deletion_receipts)").all() as Array<{ name: string }>)
        .map(column => column.name),
    );
    if (!columns.has("asset_authority_cleanup_completed")) {
      sqlite.exec(`
        ALTER TABLE project_deletion_receipts
        ADD COLUMN asset_authority_cleanup_completed INTEGER NOT NULL DEFAULT 0
      `);
    }
    sqlite.exec(`
      UPDATE project_deletion_receipts
      SET completed_at = NULL
      WHERE asset_authority_cleanup_completed = 0
    `);
    sqlite.prepare(`INSERT INTO ${schemaVersionTable} (name, applied_at) VALUES (?, ?)`)
      .run(projectDeletionAssetAuthorityCleanupMigration, new Date().toISOString());
  })();
}

function establishConversationDeletionOwnershipSchema(sqlite: Database.Database): void {
  const applied = sqlite
    .prepare(`SELECT 1 FROM ${schemaVersionTable} WHERE name = ?`)
    .get(conversationDeletionOwnershipMigration) !== undefined;
  if (applied) return;
  sqlite.transaction(() => {
    const columns = new Set(
      (sqlite.prepare("PRAGMA table_info(conversation_deletion_receipts)").all() as Array<{ name: string }>)
        .map(column => column.name),
    );
    if (!columns.has("tombstone_name")) {
      sqlite.exec("ALTER TABLE conversation_deletion_receipts ADD COLUMN tombstone_name TEXT");
    }
    if (!columns.has("ownership_token")) {
      sqlite.exec("ALTER TABLE conversation_deletion_receipts ADD COLUMN ownership_token TEXT");
    }
    if (!columns.has("removal_started")) {
      sqlite.exec(`
        ALTER TABLE conversation_deletion_receipts
        ADD COLUMN removal_started INTEGER NOT NULL DEFAULT 0
      `);
    }
    sqlite.prepare(`INSERT INTO ${schemaVersionTable} (name, applied_at) VALUES (?, ?)`)
      .run(conversationDeletionOwnershipMigration, new Date().toISOString());
  })();
}

function repairMaterializedRequestUpdateActivations(
  sqlite: Database.Database,
  updateId: string,
  publicPayload: Record<string, unknown>,
): void {
  const updateActivation = sqlite.prepare(`
    UPDATE agent_activations SET payload_json = ? WHERE id = ?
  `);
  const activations = sqlite.prepare(`
    SELECT id, payload_json FROM agent_activations
    WHERE json_valid(payload_json) AND instr(payload_json, ?) > 0
  `).all(updateId) as Array<{ id: string; payload_json: string }>;
  for (const activation of activations) {
    const updates = new Map<string, ProviderFailureUpdateProjection>([
      [updateId, { id: updateId, payload: publicPayload }],
    ]);
    const projected = sanitizeMaterializedProviderUpdates(
      JSON.parse(activation.payload_json) as unknown,
      updates,
    );
    if (projected.changed) updateActivation.run(stableJson(projected.value), activation.id);
  }
}

function publicActivationFailurePayload(
  payloadJson: string,
  category: string,
): Record<string, unknown> | undefined {
  const payload = JSON.parse(payloadJson) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  if (typeof record.activationId !== "string" || record.activationId.length > 1_024 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(record.activationId)) return undefined;
  const activationOutcome = typeof record.activationOutcome === "string" && [
    "recipient_unavailable",
    "permanent_failure",
    "retry_exhausted",
  ].includes(record.activationOutcome)
    ? record.activationOutcome
    : undefined;
  return {
    activationId: record.activationId,
    ...(activationOutcome ? { activationOutcome } : {}),
    reason: publicProviderFailureSummary(
      undefined,
      normalizeProviderFailureCategory(category),
    ) ?? "Provider execution failed.",
  };
}

/** Backfill provider-derived Request updates materialized before activation
 * failure text gained a finite public projection. Exact provider evidence
 * remains unchanged in restricted scheduler_runs rows. */
function establishPublicProviderRequestUpdates(sqlite: Database.Database): void {
  const applied = sqlite
    .prepare(`SELECT 1 FROM ${schemaVersionTable} WHERE name = ?`)
    .get(publicProviderRequestUpdatesMigration) !== undefined;
  if (applied) return;
  sqlite.transaction(() => {
    const columns = new Set(
      (sqlite.pragma("table_info(coordination_request_updates)") as Array<{ name: string }>)
        .map((column) => column.name),
    );
    if (!columns.has("provider_failure_category")) {
      sqlite.exec(`
        ALTER TABLE coordination_request_updates ADD COLUMN provider_failure_category TEXT
          CHECK (provider_failure_category IS NULL OR provider_failure_category IN (
            'authentication', 'rate_limit', 'capacity', 'context_length',
            'invalid_request', 'unavailable', 'unknown'
          ));
      `);
    }
    const rows = sqlite.prepare(`
      SELECT request_update.id, request_update.request_id, request_update.kind,
        request_update.actor_kind, request_update.actor_id,
        request_update.in_reply_to_update_id, activation.id AS activation_id,
        activation.terminal_outcome, activation.provider_failure_category
      FROM coordination_request_updates request_update
      JOIN coordination_requests request ON request.id = request_update.request_id
      JOIN activation_sources source
        ON source.source_kind = 'request' AND source.source_id = request.id
      JOIN agent_activations activation ON activation.id = source.activation_id
      WHERE request_update.kind IN ('failed', 'recipient_unavailable')
        AND request_update.actor_kind IN ('system', 'supervisor')
        AND json_valid(request_update.payload_json)
        AND json_extract(request_update.payload_json, '$.activationId') = activation.id
        AND EXISTS (
          SELECT 1 FROM scheduler_run_activations attached
          JOIN scheduler_runs scheduler ON scheduler.id = attached.run_id
          WHERE attached.activation_id = activation.id
            AND scheduler.provider_failure_json IS NOT NULL
        )
      ORDER BY request_update.created_at, request_update.id
    `).all() as Array<{
      id: string;
      request_id: string;
      kind: CoordinationRequestUpdateKind;
      actor_kind: Actor["kind"];
      actor_id: string | null;
      in_reply_to_update_id: string | null;
      activation_id: string;
      terminal_outcome: string | null;
      provider_failure_category: string | null;
    }>;
    const updateRequest = sqlite.prepare(`
      UPDATE coordination_request_updates
      SET payload_json = ?, payload_hash = ?, provider_failure_category = ?
      WHERE id = ?
    `);
    for (const row of rows) {
      const category = normalizeProviderFailureCategory(row.provider_failure_category);
      const publicPayload = {
        activationId: row.activation_id,
        activationOutcome: row.terminal_outcome ?? "permanent_failure",
        reason: publicProviderFailureSummary(undefined, category)
          ?? "Provider execution failed.",
      };
      const artifacts = sqlite.prepare(`
        SELECT id, role, title, media_type, blob_path, blob_hash, byte_length,
          origin_agent_id, execution_id
        FROM runtime_artifacts
        WHERE owner_kind = 'request_update' AND owner_id = ?
        ORDER BY created_at, id
      `).all(row.id) as Array<{
        id: string;
        role: RuntimeArtifactInputV3["role"];
        title: string;
        media_type: RuntimeArtifactInputV3["mediaType"];
        blob_path: string;
        blob_hash: string;
        byte_length: number;
        origin_agent_id: string | null;
        execution_id: string | null;
      }>;
      const projectedArtifacts: RuntimeArtifactInputV3[] = artifacts.map((artifact) => ({
        id: artifact.id,
        role: artifact.role,
        title: artifact.title,
        mediaType: artifact.media_type,
        blobPath: artifact.blob_path,
        blobHash: artifact.blob_hash,
        byteLength: artifact.byte_length,
        ...(artifact.origin_agent_id ? { originAgentId: artifact.origin_agent_id } : {}),
        ...(artifact.execution_id ? { executionId: artifact.execution_id } : {}),
      }));
      const actor: Actor = {
        kind: row.actor_kind,
        ...(row.actor_id ? { id: row.actor_id } : {}),
      };
      const hash = payloadHash({
        requestId: row.request_id,
        kind: row.kind,
        actor,
        inReplyToUpdateId: row.in_reply_to_update_id,
        payload: publicPayload,
        providerFailureCategory: category,
        artifacts: projectedArtifacts,
      });
      updateRequest.run(stableJson(publicPayload), hash, category, row.id);

      repairMaterializedRequestUpdateActivations(sqlite, row.id, publicPayload);
    }
    sqlite.prepare(`INSERT INTO ${schemaVersionTable} (name, applied_at) VALUES (?, ?)`)
      .run(publicProviderRequestUpdatesMigration, new Date().toISOString());
  })();
}

/** Repair provider-failed Request updates materialized in pending Activation
 * payloads on installations where the Request-update migration was already
 * marked applied. This is a separate durable marker because changing an
 * already-applied migration cannot repair live data. */
function establishProviderActivationExecutionPayloads(sqlite: Database.Database): void {
  const applied = sqlite
    .prepare(`SELECT 1 FROM ${schemaVersionTable} WHERE name = ?`)
    .get(providerActivationExecutionPayloadsMigration) !== undefined;
  if (applied) return;
  sqlite.transaction(() => {
    const rows = sqlite.prepare(`
      SELECT id, payload_json, provider_failure_category
      FROM coordination_request_updates
      WHERE provider_failure_category IS NOT NULL AND json_valid(payload_json)
      ORDER BY created_at, id
    `).all() as Array<{
      id: string;
      payload_json: string;
      provider_failure_category: string;
    }>;
    for (const row of rows) {
      const publicPayload = publicActivationFailurePayload(
        row.payload_json,
        row.provider_failure_category,
      );
      if (!publicPayload) continue;
      repairMaterializedRequestUpdateActivations(sqlite, row.id, publicPayload);
    }
    sqlite.prepare(`INSERT INTO ${schemaVersionTable} (name, applied_at) VALUES (?, ?)`)
      .run(providerActivationExecutionPayloadsMigration, new Date().toISOString());
  })();
}

/** Repair nested Join outcomes on databases where the direct-shape repair was
 * already durably marked. Join materializes Request updates as
 * `{ update: { id, payload } }`; the shared projector preserves the complete
 * Activation envelope while replacing only provider-derived update payloads. */
function establishNestedProviderActivationExecutionPayloads(sqlite: Database.Database): void {
  const applied = sqlite
    .prepare(`SELECT 1 FROM ${schemaVersionTable} WHERE name = ?`)
    .get(nestedProviderActivationExecutionPayloadsMigration) !== undefined;
  if (applied) return;
  sqlite.transaction(() => {
    const rows = sqlite.prepare(`
      SELECT id, payload_json, provider_failure_category
      FROM coordination_request_updates
      WHERE provider_failure_category IS NOT NULL AND json_valid(payload_json)
      ORDER BY created_at, id
    `).all() as Array<{
      id: string;
      payload_json: string;
      provider_failure_category: string;
    }>;
    for (const row of rows) {
      const publicPayload = publicActivationFailurePayload(
        row.payload_json,
        row.provider_failure_category,
      );
      if (!publicPayload) continue;
      repairMaterializedRequestUpdateActivations(sqlite, row.id, publicPayload);
    }
    sqlite.prepare(`INSERT INTO ${schemaVersionTable} (name, applied_at) VALUES (?, ?)`)
      .run(nestedProviderActivationExecutionPayloadsMigration, new Date().toISOString());
  })();
}

/** Context rollover first shipped behind a draft qualification branch, where
 * adopted databases could receive additive columns with weaker constraints.
 * Rebuild it once under the same transactional version authority as SQL
 * extensions. Rows lacking the exact boundary/hash binding are terminally
 * failed; their old accepted provider session remains untouched. */
function establishContextRolloverAtomicitySchema(sqlite: Database.Database): void {
  const applied = sqlite
    .prepare(`SELECT 1 FROM ${schemaVersionTable} WHERE name = ?`)
    .get(contextRolloverAtomicityMigration) !== undefined;
  if (applied) return;
  sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS context_rollovers (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'requested', 'handoff_committed', 'session_retiring',
          'continuation_ready', 'completed', 'failed', 'outcome_unknown'
        )),
        old_provider_session_id TEXT NOT NULL,
        provider_session_generation TEXT NOT NULL,
        detected_occupancy INTEGER NOT NULL CHECK (detected_occupancy >= 0),
        aggregate_tokens INTEGER,
        threshold INTEGER NOT NULL CHECK (threshold > 0),
        context_window INTEGER,
        low_water_mark INTEGER NOT NULL CHECK (low_water_mark >= 0),
        low_water_confirmation_required INTEGER NOT NULL DEFAULT 1,
        trigger_kind TEXT NOT NULL DEFAULT 'automatic',
        compaction_cutoff_ordinal INTEGER NOT NULL DEFAULT 0,
        compaction_cutoff_event_id TEXT,
        recent_tail_event_ids_json TEXT NOT NULL DEFAULT '[]',
        recent_tail_hashes_json TEXT NOT NULL DEFAULT '[]',
        source_run_id TEXT NOT NULL,
        source_activation_ids_json TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        conversation_id TEXT,
        reply_authority_json TEXT,
        handoff_event_id TEXT,
        continuation_activation_id TEXT,
        replacement_session_id TEXT,
        replacement_run_id TEXT,
        replacement_prompt_hash TEXT,
        replacement_system_prompt_hash TEXT,
        replacement_manifest_hash TEXT,
        replacement_attempt INTEGER NOT NULL DEFAULT 0,
        visible_response_committed INTEGER NOT NULL DEFAULT 0,
        handoff_committed_at TEXT,
        session_retiring_at TEXT,
        continuation_ready_at TEXT,
        replacement_session_at TEXT,
        replacement_input_committed_at TEXT,
        replacement_verified_at TEXT,
        visible_response_committed_at TEXT,
        completion_reason TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        terminal_at TEXT
      );
    `);
    const columns = new Set(
      (sqlite.pragma("table_info(context_rollovers)") as Array<{ name: string }>)
        .map((column) => column.name),
    );
    const additions: Array<[string, string]> = [
      ["compaction_cutoff_ordinal", "INTEGER NOT NULL DEFAULT 0"],
      ["compaction_cutoff_event_id", "TEXT"],
      ["recent_tail_event_ids_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["recent_tail_hashes_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["replacement_run_id", "TEXT"],
      ["replacement_prompt_hash", "TEXT"],
      ["replacement_system_prompt_hash", "TEXT"],
      ["replacement_manifest_hash", "TEXT"],
      ["replacement_attempt", "INTEGER NOT NULL DEFAULT 0"],
      ["replacement_input_committed_at", "TEXT"],
      ["replacement_verified_at", "TEXT"],
      ["completion_reason", "TEXT"],
      ["trigger_kind", "TEXT NOT NULL DEFAULT 'automatic'"],
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name)) sqlite.exec(`ALTER TABLE context_rollovers ADD COLUMN ${name} ${definition}`);
    }
    const now = new Date().toISOString();
    // Only the newest row may own one provider generation. Older duplicate
    // draft rows remain as terminal audit evidence but cannot schedule work.
    sqlite.prepare(`
      WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY agent_id, provider_session_generation
          ORDER BY updated_at DESC, created_at DESC, id DESC
        ) AS generation_rank
        FROM context_rollovers
      )
      UPDATE context_rollovers
      SET state = 'failed',
        last_error = 'schema migration retired duplicate provider-generation ownership',
        terminal_at = COALESCE(terminal_at, ?), updated_at = ?
      WHERE id IN (SELECT id FROM ranked WHERE generation_rank > 1)
    `).run(now, now);
    // This migration only upgrades databases created by the unqualified draft
    // implementation. Those rows predate canonical order/content/scope and
    // aggregate-tail guarantees, which cannot be reconstructed from SQLite
    // alone without competing with the append-only Communication journal.
    // Retire every adopted row instead of preserving a permanently weaker
    // compatibility path; the old accepted provider snapshot remains intact.
    sqlite.prepare(`
      UPDATE context_rollovers
      SET state = 'failed',
        last_error = 'schema migration retired an unqualified draft rollover whose exact canonical authority cannot be proven',
        terminal_at = COALESCE(terminal_at, ?), updated_at = ?
      WHERE state NOT IN ('failed','outcome_unknown')
    `).run(now, now);
    sqlite.prepare(`
      UPDATE context_rollovers
      SET state = CASE
          WHEN compaction_cutoff_ordinal <= 0
            OR compaction_cutoff_event_id IS NULL
            OR CASE WHEN json_valid(recent_tail_event_ids_json) = 1
                  AND json_valid(recent_tail_hashes_json) = 1
              THEN json_array_length(recent_tail_event_ids_json) = 0
                OR json_array_length(recent_tail_event_ids_json) <> json_array_length(recent_tail_hashes_json)
              ELSE 1 END
          THEN 'failed' ELSE state END,
        last_error = CASE
          WHEN compaction_cutoff_ordinal <= 0
            OR compaction_cutoff_event_id IS NULL
            OR CASE WHEN json_valid(recent_tail_event_ids_json) = 1
                  AND json_valid(recent_tail_hashes_json) = 1
              THEN json_array_length(recent_tail_event_ids_json) = 0
                OR json_array_length(recent_tail_event_ids_json) <> json_array_length(recent_tail_hashes_json)
              ELSE 1 END
          THEN 'schema migration rejected a rollover without an exact canonical boundary and content-hash-bound tail'
          ELSE last_error END,
        terminal_at = CASE
          WHEN compaction_cutoff_ordinal <= 0
            OR compaction_cutoff_event_id IS NULL
            OR CASE WHEN json_valid(recent_tail_event_ids_json) = 1
                  AND json_valid(recent_tail_hashes_json) = 1
              THEN json_array_length(recent_tail_event_ids_json) = 0
                OR json_array_length(recent_tail_event_ids_json) <> json_array_length(recent_tail_hashes_json)
              ELSE 1 END
          THEN COALESCE(terminal_at, ?) ELSE terminal_at END,
        low_water_confirmation_required = 1,
        updated_at = CASE WHEN low_water_confirmation_required <> 1 THEN ? ELSE updated_at END
    `).run(now, now);
    sqlite.exec(`
      DROP TABLE IF EXISTS context_rollovers_atomic;
      CREATE TABLE context_rollovers_atomic (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'requested', 'handoff_committed', 'session_retiring',
          'continuation_ready', 'completed', 'failed', 'outcome_unknown'
        )),
        old_provider_session_id TEXT NOT NULL,
        provider_session_generation TEXT NOT NULL,
        detected_occupancy INTEGER NOT NULL CHECK (detected_occupancy >= 0),
        aggregate_tokens INTEGER,
        threshold INTEGER NOT NULL CHECK (threshold > 0),
        context_window INTEGER,
        low_water_mark INTEGER NOT NULL CHECK (low_water_mark >= 0),
        low_water_confirmation_required INTEGER NOT NULL DEFAULT 1 CHECK (low_water_confirmation_required = 1),
        trigger_kind TEXT NOT NULL DEFAULT 'automatic' CHECK (trigger_kind IN ('automatic','human')),
        compaction_cutoff_ordinal INTEGER NOT NULL CHECK (compaction_cutoff_ordinal >= 0),
        compaction_cutoff_event_id TEXT,
        recent_tail_event_ids_json TEXT NOT NULL,
        recent_tail_hashes_json TEXT NOT NULL,
        source_run_id TEXT NOT NULL,
        source_activation_ids_json TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        conversation_id TEXT,
        reply_authority_json TEXT,
        handoff_event_id TEXT,
        continuation_activation_id TEXT,
        replacement_session_id TEXT,
        replacement_run_id TEXT,
        replacement_prompt_hash TEXT,
        replacement_system_prompt_hash TEXT,
        replacement_manifest_hash TEXT,
        replacement_attempt INTEGER NOT NULL DEFAULT 0 CHECK (replacement_attempt >= 0),
        visible_response_committed INTEGER NOT NULL DEFAULT 0,
        handoff_committed_at TEXT,
        session_retiring_at TEXT,
        continuation_ready_at TEXT,
        replacement_session_at TEXT,
        replacement_input_committed_at TEXT,
        replacement_verified_at TEXT,
        visible_response_committed_at TEXT,
        completion_reason TEXT CHECK (completion_reason IN (
          'replacement_verified', 'native_compaction', 'no_continuation_required'
        )),
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        terminal_at TEXT,
        CHECK (state IN ('failed','outcome_unknown') OR
          (compaction_cutoff_ordinal > 0 AND compaction_cutoff_event_id IS NOT NULL))
      );
      INSERT INTO context_rollovers_atomic SELECT
        id, project_id, agent_id, state, old_provider_session_id,
        provider_session_generation, detected_occupancy, aggregate_tokens,
        threshold, context_window, low_water_mark, 1, trigger_kind,
        compaction_cutoff_ordinal, compaction_cutoff_event_id,
        recent_tail_event_ids_json, recent_tail_hashes_json,
        source_run_id, source_activation_ids_json, scope_key, conversation_id,
        reply_authority_json, handoff_event_id, continuation_activation_id,
        replacement_session_id, replacement_run_id, replacement_prompt_hash,
        replacement_system_prompt_hash, replacement_manifest_hash,
        replacement_attempt, visible_response_committed, handoff_committed_at,
        session_retiring_at, continuation_ready_at, replacement_session_at,
        replacement_input_committed_at, replacement_verified_at,
        visible_response_committed_at, completion_reason, last_error,
        created_at, updated_at, terminal_at
      FROM context_rollovers;
      DROP TABLE context_rollovers;
      ALTER TABLE context_rollovers_atomic RENAME TO context_rollovers;
      CREATE INDEX idx_context_rollovers_agent_state
        ON context_rollovers (agent_id, state, updated_at DESC);
      CREATE UNIQUE INDEX idx_context_rollovers_generation_owner
        ON context_rollovers (agent_id, provider_session_generation)
        WHERE state IN (
          'requested', 'handoff_committed', 'session_retiring',
          'continuation_ready', 'completed'
        );
      CREATE UNIQUE INDEX idx_context_rollovers_continuation_activation
        ON context_rollovers (continuation_activation_id)
        WHERE continuation_activation_id IS NOT NULL;
    `);
    sqlite.prepare(`INSERT INTO ${schemaVersionTable} (name, applied_at) VALUES (?, ?)`)
      .run(contextRolloverAtomicityMigration, now);
  })();
}

/** Persist whether a rollover failure crossed a provider boundary or arose
 * inside Ponderosa. Existing failures were code-owned paths and therefore
 * adopt the internal default. */
function establishContextRolloverFailureProvenance(sqlite: Database.Database): void {
  const applied = sqlite
    .prepare(`SELECT 1 FROM ${schemaVersionTable} WHERE name = ?`)
    .get(contextRolloverFailureProvenanceMigration) !== undefined;
  if (applied) return;
  sqlite.transaction(() => {
    const columns = new Set(
      (sqlite.pragma("table_info(context_rollovers)") as Array<{ name: string }>)
        .map((column) => column.name),
    );
    if (!columns.has("failure_provenance")) {
      sqlite.exec(`
        ALTER TABLE context_rollovers ADD COLUMN failure_provenance TEXT NOT NULL DEFAULT 'internal'
          CHECK (failure_provenance IN ('provider','internal'))
      `);
    }
    sqlite.prepare(`INSERT INTO ${schemaVersionTable} (name, applied_at) VALUES (?, ?)`)
      .run(contextRolloverFailureProvenanceMigration, new Date().toISOString());
  })();
}

/** A provider session may compact natively more than once. Preserve every
 * historical row while assigning a stable ordinal to each durable attempt. */
function establishContextRolloverCycles(sqlite: Database.Database): void {
  if (sqlite.prepare(`SELECT 1 FROM ${schemaVersionTable} WHERE name = ?`)
    .get(contextRolloverCyclesMigration)) return;
  sqlite.transaction(() => {
    const columns = new Set(
      (sqlite.pragma("table_info(context_rollovers)") as Array<{ name: string }>)
        .map(column => column.name),
    );
    if (!columns.has("cycle_number")) {
      sqlite.exec("ALTER TABLE context_rollovers ADD COLUMN cycle_number INTEGER NOT NULL DEFAULT 1 CHECK (cycle_number > 0)");
    }
    sqlite.exec(`
      UPDATE context_rollovers SET cycle_number = (
        SELECT COUNT(*) FROM context_rollovers prior
        WHERE prior.agent_id = context_rollovers.agent_id
          AND prior.provider_session_generation = context_rollovers.provider_session_generation
          AND prior.rowid <= context_rollovers.rowid
      );
      DROP INDEX IF EXISTS idx_context_rollovers_generation_owner;
      CREATE UNIQUE INDEX idx_context_rollovers_generation_cycle
        ON context_rollovers (agent_id, provider_session_generation, cycle_number);
    `);
    sqlite.prepare(`INSERT INTO ${schemaVersionTable} (name, applied_at) VALUES (?, ?)`).run(
      contextRolloverCyclesMigration, new Date().toISOString(),
    );
  })();
}

/** Unavailable measurements must be NULL, not a threshold presented as usage.
 * Keep historical bytes/values (including old native_compaction reasons) and
 * all existing indexes/triggers. SQLite requires a table rebuild to relax the
 * occupancy NOT NULL and extend the completion-reason CHECK. */
function establishContextRolloverObservations(sqlite: Database.Database): void {
  if (sqlite.prepare(`SELECT 1 FROM ${schemaVersionTable} WHERE name = ?`)
    .get(contextRolloverObservationMigration)) return;
  sqlite.transaction(() => {
    const original = (sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'context_rollovers'")
      .get() as { sql: string }).sql;
    const occupancyConstraint = "detected_occupancy INTEGER NOT NULL CHECK (detected_occupancy >= 0)";
    const completionConstraint = "'replacement_verified', 'native_compaction', 'no_continuation_required'";
    if (!original.includes(occupancyConstraint) || !original.includes(completionConstraint)) {
      throw new Error("context rollover observation migration found an unexpected schema");
    }
    const replacement = original
      .replace(/^CREATE TABLE "?context_rollovers"?/u, "CREATE TABLE context_rollovers_observations")
      .replace(occupancyConstraint, "detected_occupancy INTEGER CHECK (detected_occupancy >= 0)")
      .replace(completionConstraint, `${completionConstraint}, 'headroom_restored'`);
    const dependentSchema = sqlite.prepare(`
      SELECT sql FROM sqlite_master WHERE tbl_name = 'context_rollovers'
        AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type, name
    `).all() as Array<{ sql: string }>;
    const columns = (sqlite.pragma("table_info(context_rollovers)") as Array<{ name: string }>)
      .map(column => `"${column.name.replaceAll('"', '""')}"`).join(", ");
    sqlite.exec(replacement);
    sqlite.exec(`INSERT INTO context_rollovers_observations (rowid, ${columns})
      SELECT rowid, ${columns} FROM context_rollovers`);
    sqlite.exec("DROP TABLE context_rollovers; ALTER TABLE context_rollovers_observations RENAME TO context_rollovers");
    for (const entry of dependentSchema) sqlite.exec(entry.sql);
    sqlite.prepare(`INSERT INTO ${schemaVersionTable} (name, applied_at) VALUES (?, ?)`)
      .run(contextRolloverObservationMigration, new Date().toISOString());
  })();
}

/** Additive read indexes are safe to establish for both adopted and already
 * baselined databases without rewriting canonical rows. */
function establishReadIndexes(sqlite: Database.Database): void {
  const providerInputColumns = new Set(
    (sqlite.pragma("table_info(provider_inputs)") as Array<{ name: string }>)
      .map((column) => column.name),
  );
  if (!providerInputColumns.has("provider_system_prompt")) {
    sqlite.exec("ALTER TABLE provider_inputs ADD COLUMN provider_system_prompt TEXT NOT NULL DEFAULT ''");
  }
  if (!providerInputColumns.has("system_prompt_hash")) {
    sqlite.exec("ALTER TABLE provider_inputs ADD COLUMN system_prompt_hash TEXT NOT NULL DEFAULT ''");
  }
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS compaction_history_messages (
      project_id TEXT NOT NULL,
      communication_event_id TEXT NOT NULL,
      canonical_ordinal INTEGER NOT NULL,
      conversation_id TEXT,
      created_at TEXT NOT NULL,
      revision_event_id TEXT,
      edited_at TEXT,
      content_sha256 TEXT NOT NULL,
      text TEXT NOT NULL,
      communication_intent TEXT NOT NULL DEFAULT '',
      context_policy TEXT NOT NULL DEFAULT '',
      sender_kind TEXT NOT NULL DEFAULT '',
      sender_agent_id TEXT,
      PRIMARY KEY (project_id, communication_event_id)
    );
  `);
  const historyColumns = new Set(
    (sqlite.pragma("table_info(compaction_history_messages)") as Array<{ name: string }>)
      .map((column) => column.name),
  );
  for (const [name, declaration] of [
    ["communication_intent", "TEXT NOT NULL DEFAULT ''"],
    ["context_policy", "TEXT NOT NULL DEFAULT ''"],
    ["sender_kind", "TEXT NOT NULL DEFAULT ''"],
    ["sender_agent_id", "TEXT"],
  ] as const) {
    if (!historyColumns.has(name)) {
      sqlite.exec(`ALTER TABLE compaction_history_messages ADD COLUMN ${name} ${declaration}`);
    }
  }
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_compaction_history_messages_boundary
      ON compaction_history_messages (project_id, canonical_ordinal);
    CREATE INDEX IF NOT EXISTS idx_compaction_history_messages_conversation_ordinal
      ON compaction_history_messages (project_id, conversation_id, canonical_ordinal);
    CREATE TABLE IF NOT EXISTS compaction_history_agent_participants (
      project_id TEXT NOT NULL,
      communication_event_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      PRIMARY KEY (project_id, communication_event_id, agent_id)
    );
    CREATE TABLE IF NOT EXISTS compaction_history_relation_candidates (
      project_id TEXT NOT NULL,
      communication_event_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      canonical_ordinal INTEGER NOT NULL,
      authority_agent_id TEXT NOT NULL,
      PRIMARY KEY (project_id, communication_event_id, authority_agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_compaction_history_relation_candidates_lookup
      ON compaction_history_relation_candidates (
        project_id, conversation_id, authority_agent_id, canonical_ordinal DESC
      );
    CREATE VIRTUAL TABLE IF NOT EXISTS compaction_history_fts USING fts5(
      project_id UNINDEXED,
      communication_event_id UNINDEXED,
      text,
      tokenize = 'unicode61'
    );
    CREATE INDEX IF NOT EXISTS idx_coordination_request_updates_request_created
      ON coordination_request_updates (request_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_coordination_requests_communication
      ON coordination_requests (project_id, communication_event_id, created_at, id);
    CREATE INDEX IF NOT EXISTS coordination_requests_attention
      ON coordination_requests (updated_at DESC, id DESC)
      WHERE state IN ('blocked', 'failed', 'outcome_unknown', 'expired', 'recipient_unavailable');
    CREATE INDEX IF NOT EXISTS coordination_joins_attention
      ON coordination_joins (updated_at DESC, id DESC)
      WHERE state IN ('impossible', 'expired');
    CREATE INDEX IF NOT EXISTS agent_activations_communication_attention
      ON agent_activations (updated_at DESC, id DESC)
      WHERE state IN ('failed', 'outcome_unknown')
        AND kind IN ('human_message', 'urgent_message', 'ordinary_message');
    CREATE INDEX IF NOT EXISTS idx_runtime_artifacts_owner
      ON runtime_artifacts (owner_kind, owner_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_projects_directory
      ON projects (last_used_at DESC, created_at DESC, label, id);
    CREATE INDEX IF NOT EXISTS idx_conversations_project_directory
      ON conversations (project_id, updated_at DESC, title, id);
    CREATE INDEX IF NOT EXISTS idx_agents_project_directory
      ON agents (project_id, deleted_at, updated_at DESC, title, id);
    CREATE INDEX IF NOT EXISTS idx_agents_project_organization
      ON agents (
        project_id, manager_agent_id, deleted_at,
        title COLLATE NOCASE, id
      );
  `);
}

/**
 * Open (or create) the projection DB at `file` and establish its launch schema.
 * Pass ":memory:" for isolated callers.
 */
export function initializeCurrentDatabase(sqlite: Database.Database): void {
  establishSchema(sqlite);
  establishAgentMentionHandles(sqlite);
  establishContextRolloverAtomicitySchema(sqlite);
  establishContextRolloverFailureProvenance(sqlite);
  establishContextRolloverCycles(sqlite);
  establishSchemaExtensions(sqlite);
  establishContextRolloverObservations(sqlite);
  establishWorkingCopyAuthoritySchema(sqlite);
  establishProjectDeletionOwnershipSchema(sqlite);
  establishDeletionRecoveryPhasesSchema(sqlite);
  establishConversationDeletionPrecommitSchema(sqlite);
  establishProjectDeletionDraftCleanupSchema(sqlite);
  establishProjectDeletionAssetAuthorityCleanupSchema(sqlite);
  establishConversationDeletionOwnershipSchema(sqlite);
  establishPublicProviderRequestUpdates(sqlite);
  establishProviderActivationExecutionPayloads(sqlite);
  establishNestedProviderActivationExecutionPayloads(sqlite);
  establishReadIndexes(sqlite);
}

/** Acquire one database reference. A supplied admission is transferred to this
 * acquisition on success; retain a separate reference for any other owner. */
export function openDb(file: string, admission?: StateAdmission): OpenedDb {
  if (file === ":memory:") {
    if (admission) throw new Error("memory state cannot inherit root authority");
    const sqlite = openCurrentMemoryDatabase();
    try {
      return { db: drizzle(sqlite, { schema }), client: sqlite,
        close: () => { if (sqlite.open) sqlite.close(); } };
    } catch (error) { sqlite.close(); throw error; }
  }
  const owned = admission ?? admitDataDirectory(dirname(file), basename(file));
  try {
    StateAdmission.assertValid(owned);
    owned.assertRoot(dirname(file));
    if (owned.client.name !== storageDatabaseFilename(join(owned.dataDir, basename(file)))) throw new Error("database does not match admitted primary");
    return { db: drizzle(owned.client, { schema }), client: owned.client,
      admission: owned, close: () => owned.close() };
  } catch (error) {
    // A supplied reference stays with its caller on failure. A reference acquired
    // here must not survive a failed open with no returned disposer.
    if (!admission) owned.close();
    throw error;
  }
}

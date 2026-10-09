import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { SAVED_BROWSER_SCOPE_ID, type SavedBrowserDto } from "@ponderosa/core";
import type {
  BrowserAgentPreferenceDto,
  BrowserProfileDto,
  BrowserProfileMode,
} from "@ponderosa/core";
import type { BrowserScope } from "./browser-session-manager.js";
import type { BrowserDriverLaunchOptions } from "./chrome-cdp-driver.js";

export class BrowserProfileError extends Error {
  constructor(readonly statusCode: 400 | 404 | 409 | 503, message: string) {
    super(message);
    this.name = "BrowserProfileError";
  }
}

export interface BrowserLaunchDescription {
  profileMode: BrowserProfileMode;
  profileId?: string;
  profileName?: string;
}

export interface BrowserLaunchLease extends BrowserLaunchDescription {
  driver: BrowserDriverLaunchOptions;
  release(): void;
}

interface PendingLaunch {
  id: string;
  sessionId: string;
  description: BrowserLaunchDescription;
  profileKey?: string;
  signal: AbortSignal;
  onQueue(position: number, reason: "host_capacity" | "profile_in_use"): void;
  resolve(value: BrowserLaunchLease): void;
  reject(error: Error): void;
  abort(): void;
}

interface ActiveLaunch {
  sessionId: string;
  profileKey?: string;
}

function boundedCapacity(value: string | undefined): number {
  const parsed = Number(value ?? 8);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 64) : 8;
}

function cleanName(value: string): string {
  const name = value.trim().replace(/\s+/gu, " ");
  if (!name || name.length > 80) {
    throw new BrowserProfileError(400, "Browser profile name must contain 1 to 80 characters.");
  }
  return name;
}

const PROFILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Durable profile catalog plus app-local admission leases. Supervised shared
 * browsers reacquire these leases before startup admits new browser requests;
 * the independent service additionally enforces live profile exclusivity. */
export class BrowserProfileAuthority {
  private readonly db: Database.Database;
  private readonly profileRoot: string;
  private readonly maxActive: number;
  private readonly pending: PendingLaunch[] = [];
  private readonly active = new Map<string, ActiveLaunch>();
  private pumping = false;
  private closed = false;

  constructor(
    dataDir: string,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.profileRoot = path.join(dataDir, "browser-profiles");
    mkdirSync(this.profileRoot, { recursive: true, mode: 0o700 });
    this.maxActive = boundedCapacity(env.PONDEROSA_BROWSER_MAX_ACTIVE);
    this.db = new Database(path.join(dataDir, "browser-profile-authority.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("busy_timeout = 500");
    this.db.pragma("foreign_keys = ON");
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version !== 0 && version !== 1 && version !== 2) {
      throw new BrowserProfileError(409, "Browser profile authority schema is incompatible.");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS browser_profiles (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, name)
      );
      CREATE INDEX IF NOT EXISTS browser_profiles_project
        ON browser_profiles(project_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS browser_agent_preferences (
        agent_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('disposable','trusted')),
        profile_id TEXT,
        updated_at TEXT NOT NULL,
        CHECK((mode='disposable' AND profile_id IS NULL) OR (mode='trusted' AND profile_id IS NOT NULL)),
        FOREIGN KEY(profile_id) REFERENCES browser_profiles(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS browser_agent_preferences_project
        ON browser_agent_preferences(project_id, agent_id);
      CREATE TABLE IF NOT EXISTS browser_chat_profiles (
        project_id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES browser_profiles(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS saved_browser (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        profile_id TEXT NOT NULL REFERENCES browser_profiles(id) ON DELETE CASCADE,
        promoted_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS saved_browser_access (
        profile_id TEXT NOT NULL REFERENCES browser_profiles(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(profile_id, project_id, agent_id)
      );
      CREATE INDEX IF NOT EXISTS saved_browser_access_agent
        ON saved_browser_access(agent_id, project_id);
      CREATE TABLE IF NOT EXISTS saved_browser_access_fences (
        profile_id TEXT NOT NULL REFERENCES browser_profiles(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(profile_id, project_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS saved_browser_approval_intents (
        decision_id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES browser_profiles(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','applied','revoked'))
      );
      -- The access table is additive. Keep version 1 so the preceding
      -- experimental release can reopen this database during rollback.
      PRAGMA user_version=1;
    `);
  }

  private profile(row: Record<string, unknown>): BrowserProfileDto {
    return {
      id: String(row.id),
      projectId: String(row.projectId),
      name: String(row.name),
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
    };
  }

  private mapped(error: unknown): never {
    if (error instanceof BrowserProfileError) throw error;
    const code = (error as { code?: string })?.code ?? "";
    if (code.includes("UNIQUE")) throw new BrowserProfileError(409, "A browser profile with this name already exists in the Project.");
    if (code.includes("BUSY") || code.includes("LOCKED")) throw new BrowserProfileError(503, "Browser profile settings are busy. Try again.");
    throw new BrowserProfileError(409, `Browser profile settings are unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  private profileDirectory(profileId: string): string {
    if (!PROFILE_ID_PATTERN.test(profileId)) {
      throw new BrowserProfileError(404, "Browser profile was not found.");
    }
    const directory = path.resolve(this.profileRoot, profileId);
    const relative = path.relative(this.profileRoot, directory);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new BrowserProfileError(409, "Browser profile storage boundary is invalid.");
    }
    return directory;
  }

  listProfiles(projectId: string): BrowserProfileDto[] {
    try {
      return (this.db.prepare(`SELECT id, project_id projectId, name, created_at createdAt, updated_at updatedAt
        FROM browser_profiles WHERE project_id=? ORDER BY lower(name), id`).all(projectId) as Array<Record<string, unknown>>)
        .map((row) => this.profile(row));
    } catch (error) {
      return this.mapped(error);
    }
  }

  getProfile(projectId: string, profileId: string): BrowserProfileDto | undefined {
    try {
      const row = this.db.prepare(`SELECT id, project_id projectId, name, created_at createdAt, updated_at updatedAt
        FROM browser_profiles WHERE project_id=? AND id=?`).get(projectId, profileId) as Record<string, unknown> | undefined;
      return row ? this.profile(row) : undefined;
    } catch (error) {
      return this.mapped(error);
    }
  }

  createProfile(projectId: string, requestedName: string): BrowserProfileDto {
    const id = randomUUID();
    const name = cleanName(requestedName);
    const now = new Date().toISOString();
    try {
      this.db.prepare("INSERT INTO browser_profiles(id,project_id,name,created_at,updated_at) VALUES(?,?,?,?,?)")
        .run(id, projectId, name, now, now);
      return { id, projectId, name, createdAt: now, updatedAt: now };
    } catch (error) {
      return this.mapped(error);
    }
  }

  renameProfile(projectId: string, profileId: string, requestedName: string): BrowserProfileDto {
    const name = cleanName(requestedName);
    const now = new Date().toISOString();
    try {
      if (this.db.prepare("UPDATE browser_profiles SET name=?,updated_at=? WHERE project_id=? AND id=?")
        .run(name, now, projectId, profileId).changes !== 1) {
        throw new BrowserProfileError(404, "Browser profile was not found.");
      }
      return this.getProfile(projectId, profileId)!;
    } catch (error) {
      return this.mapped(error);
    }
  }

  deleteProfile(projectId: string, profileId: string): void {
    const profile = this.getProfile(projectId, profileId);
    if (!profile) throw new BrowserProfileError(404, "Browser profile was not found.");
    const directory = this.profileDirectory(profile.id);
    if ([...this.active.values()].some((entry) => entry.profileKey === profile.id) ||
        this.pending.some((entry) => entry.profileKey === profile.id)) {
      throw new BrowserProfileError(409, "Close or wait for browsers using this trusted profile before deleting it.");
    }
    try {
      // Filesystem-first ordering is retryable: a failed removal leaves the
      // catalog intact; a later database failure leaves the same canonical
      // record available so this exact deletion can be retried safely.
      rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
      if (this.db.prepare("DELETE FROM browser_profiles WHERE project_id=? AND id=?")
        .run(projectId, profile.id).changes !== 1) {
        throw new BrowserProfileError(409, "Browser profile deletion did not commit. Retry the deletion.");
      }
    } catch (error) {
      return this.mapped(error);
    }
  }

  deleteProject(projectId: string): void {
    const profiles = this.listProfiles(projectId);
    const ids = new Set(profiles.map((profile) => profile.id));
    if ([...this.active.values()].some((entry) => entry.profileKey && ids.has(entry.profileKey)) ||
        this.pending.some((entry) => entry.profileKey && ids.has(entry.profileKey))) {
      throw new BrowserProfileError(409, "Project browser profiles still have active or queued leases.");
    }
    try {
      for (const profile of profiles) {
        rmSync(this.profileDirectory(profile.id), { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
      }
      this.db.exec("BEGIN IMMEDIATE");
      this.db.prepare("DELETE FROM browser_agent_preferences WHERE project_id=?").run(projectId);
      this.db.prepare("DELETE FROM saved_browser_access WHERE project_id=?").run(projectId);
      this.db.prepare("DELETE FROM saved_browser_access_fences WHERE project_id=?").run(projectId);
      this.db.prepare("DELETE FROM saved_browser_approval_intents WHERE project_id=?").run(projectId);
      this.db.prepare("DELETE FROM browser_profiles WHERE project_id=?").run(projectId);
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
      return this.mapped(error);
    }
  }

  preference(projectId: string, agentId: string): BrowserAgentPreferenceDto {
    try {
      const row = this.db.prepare(`SELECT p.agent_id agentId,p.project_id projectId,p.mode,p.profile_id profileId,
          p.updated_at updatedAt,b.name profileName
        FROM browser_agent_preferences p LEFT JOIN browser_profiles b ON b.id=p.profile_id
        WHERE p.project_id=? AND p.agent_id=?`).get(projectId, agentId) as Record<string, unknown> | undefined;
      if (!row) return {
        agentId,
        projectId,
        mode: "disposable",
        updatedAt: new Date(0).toISOString(),
      };
      return {
        agentId: String(row.agentId),
        projectId: String(row.projectId),
        mode: row.mode === "trusted" ? "trusted" : "disposable",
        ...(typeof row.profileId === "string" ? { profileId: row.profileId } : {}),
        ...(typeof row.profileName === "string" ? { profileName: row.profileName } : {}),
        updatedAt: String(row.updatedAt),
      };
    } catch (error) {
      return this.mapped(error);
    }
  }

  setPreference(
    projectId: string,
    agentId: string,
    mode: BrowserProfileMode,
    profileId?: string,
  ): BrowserAgentPreferenceDto {
    if (mode !== "disposable" && mode !== "trusted") {
      throw new BrowserProfileError(400, "Browser mode must be disposable or trusted.");
    }
    if (mode === "trusted" && (!profileId || !this.getProfile(projectId, profileId))) {
      throw new BrowserProfileError(400, "Select a trusted browser profile from this Project.");
    }
    const now = new Date().toISOString();
    try {
      this.db.prepare(`INSERT INTO browser_agent_preferences(agent_id,project_id,mode,profile_id,updated_at)
        VALUES(?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET
        project_id=excluded.project_id,mode=excluded.mode,profile_id=excluded.profile_id,updated_at=excluded.updated_at`)
        .run(agentId, projectId, mode, mode === "trusted" ? profileId : null, now);
      return this.preference(projectId, agentId);
    } catch (error) {
      return this.mapped(error);
    }
  }

  removeAgent(agentId: string): void {
    try {
      this.db.transaction(() => {
        this.db.prepare("DELETE FROM browser_agent_preferences WHERE agent_id=?").run(agentId);
        this.db.prepare("DELETE FROM saved_browser_access WHERE agent_id=?").run(agentId);
        this.db.prepare("DELETE FROM saved_browser_access_fences WHERE agent_id=?").run(agentId);
        this.db.prepare("DELETE FROM saved_browser_approval_intents WHERE agent_id=?").run(agentId);
      })();
    }
    catch (error) { this.mapped(error); }
  }

  savedBrowser(): SavedBrowserDto | undefined {
    return this.db.prepare("SELECT profile_id profileId, promoted_at promotedAt FROM saved_browser WHERE singleton=1").get() as SavedBrowserDto | undefined;
  }

  /** An explicit Agent-in-chat authorization, never a Run lease. The current
   * saved profile identity is part of the key so replacing a saved browser
   * cannot silently transfer account access. */
  hasSavedBrowserAccess(projectId: string, agentId: string): boolean {
    const saved = this.savedBrowser();
    if (!saved) return false;
    return Boolean(this.db.prepare("SELECT 1 FROM saved_browser_access WHERE profile_id=? AND project_id=? AND agent_id=?")
      .get(saved.profileId, projectId, agentId));
  }

  savedBrowserAccess(projectId: string): string[] {
    const saved = this.savedBrowser();
    if (!saved) return [];
    return (this.db.prepare("SELECT agent_id agentId FROM saved_browser_access WHERE profile_id=? AND project_id=? ORDER BY created_at, agent_id")
      .all(saved.profileId, projectId) as Array<{ agentId: string }>).map(row => row.agentId);
  }

  setSavedBrowserAccess(projectId: string, agentId: string, allowed: boolean): void {
    const saved = this.savedBrowser();
    if (!saved) throw new BrowserProfileError(404, "Saved browser was not found.");
    try {
      if (allowed) this.db.prepare("INSERT OR IGNORE INTO saved_browser_access(profile_id,project_id,agent_id,created_at) VALUES(?,?,?,?)")
        .run(saved.profileId, projectId, agentId, new Date().toISOString());
      else this.db.transaction(() => {
        // Revocation also fences any approval committed in the workspace but
        // not yet applied here. Replaying an old Decision cannot restore access.
        this.db.prepare(`INSERT INTO saved_browser_access_fences(profile_id,project_id,agent_id,generation)
          VALUES(?,?,?,1) ON CONFLICT(profile_id,project_id,agent_id)
          DO UPDATE SET generation=generation+1`).run(saved.profileId, projectId, agentId);
        this.db.prepare("UPDATE saved_browser_approval_intents SET state='revoked' WHERE profile_id=? AND project_id=? AND agent_id=?")
          .run(saved.profileId, projectId, agentId);
        this.db.prepare("DELETE FROM saved_browser_access WHERE profile_id=? AND project_id=? AND agent_id=?")
          .run(saved.profileId, projectId, agentId);
      })();
    } catch (error) { this.mapped(error); }
  }

  /** Stage an inert approval intent before resolving its canonical Decision.
   * The revocation generation is captured in this database, so a later revoke
   * fences even a workspace resolution whose access write has not yet run. */
  prepareSavedBrowserApproval(decisionId: string, profileId: string, projectId: string, agentId: string): void {
    try {
      this.db.transaction(() => {
        if (this.savedBrowser()?.profileId !== profileId) throw new BrowserProfileError(409, "The saved browser changed. No access was granted.");
        const generation = (this.db.prepare(`SELECT generation FROM saved_browser_access_fences
          WHERE profile_id=? AND project_id=? AND agent_id=?`).get(profileId, projectId, agentId) as { generation: number } | undefined)?.generation ?? 0;
        this.db.prepare(`INSERT OR IGNORE INTO saved_browser_approval_intents(decision_id,profile_id,project_id,agent_id,generation,state)
          VALUES(?,?,?,?,?,'pending')`).run(decisionId, profileId, projectId, agentId, generation);
        const existing = this.db.prepare(`SELECT profile_id profileId,project_id projectId,agent_id agentId,generation,state
          FROM saved_browser_approval_intents WHERE decision_id=?`).get(decisionId) as {
          profileId: string; projectId: string; agentId: string; generation: number; state: string;
        };
        if (existing.profileId !== profileId || existing.projectId !== projectId || existing.agentId !== agentId ||
            existing.generation !== generation || existing.state === "revoked") {
          throw new BrowserProfileError(409, "This saved-browser approval was superseded or revoked. Ask the Agent to request access again.");
        }
      })();
    } catch (error) { this.mapped(error); }
  }

  /** Apply only a durably resolved approval with its previously staged intent.
   * The access row and consumed intent commit together. Missing legacy intents
   * never create new access, but an existing grant remains readable. */
  applySavedBrowserApproval(decisionId: string, profileId: string, projectId: string, agentId: string): boolean {
    try {
      return this.db.transaction(() => {
        const intent = this.db.prepare(`SELECT profile_id profileId,project_id projectId,agent_id agentId,generation,state
          FROM saved_browser_approval_intents WHERE decision_id=?`).get(decisionId) as {
          profileId: string; projectId: string; agentId: string; generation: number; state: string;
        } | undefined;
        if (!intent) return this.hasSavedBrowserAccess(projectId, agentId);
        if (intent.state === "revoked") return false;
        if (intent.profileId !== profileId || intent.projectId !== projectId || intent.agentId !== agentId) {
          throw new BrowserProfileError(409, "Saved-browser approval scope changed. No access was granted.");
        }
        if (this.savedBrowser()?.profileId !== profileId) throw new BrowserProfileError(409, "The saved browser changed. No access was granted.");
        const generation = (this.db.prepare(`SELECT generation FROM saved_browser_access_fences
          WHERE profile_id=? AND project_id=? AND agent_id=?`).get(profileId, projectId, agentId) as { generation: number } | undefined)?.generation ?? 0;
        if (generation !== intent.generation) {
          this.db.prepare("UPDATE saved_browser_approval_intents SET state='revoked' WHERE decision_id=?").run(decisionId);
          return false;
        }
        if (intent.state === "applied") return this.hasSavedBrowserAccess(projectId, agentId);
        this.db.prepare("INSERT OR IGNORE INTO saved_browser_access(profile_id,project_id,agent_id,created_at) VALUES(?,?,?,?)")
          .run(profileId, projectId, agentId, new Date().toISOString());
        this.db.prepare("UPDATE saved_browser_approval_intents SET state='applied' WHERE decision_id=? AND state='pending'").run(decisionId);
        return true;
      })();
    } catch (error) { return this.mapped(error); }
  }


  promoteSavedBrowser(projectId: string, profileId: string): void {
    this.db.transaction(() => {
      if (this.savedBrowser()) throw new BrowserProfileError(409, "A saved browser already exists. It has not been replaced.");
      if (!this.getProfile(projectId, profileId)) throw new BrowserProfileError(404, "Browser profile does not belong to this chat.");
      this.db.prepare("DELETE FROM browser_agent_preferences WHERE profile_id=?").run(profileId);
      this.db.prepare("DELETE FROM browser_chat_profiles WHERE profile_id=?").run(profileId);
      this.db.prepare("UPDATE browser_profiles SET project_id=? WHERE id=? AND project_id=?").run(SAVED_BROWSER_SCOPE_ID, profileId, projectId);
      this.setPreference(SAVED_BROWSER_SCOPE_ID, `project-browser:${SAVED_BROWSER_SCOPE_ID}`, "trusted", profileId);
      this.db.prepare("INSERT INTO saved_browser(singleton,profile_id,promoted_at) VALUES(1,?,?)").run(profileId, new Date().toISOString());
    })();
  }

  setChatRememberSignIns(projectId: string, browserAgentId: string, remember: boolean): void {
    this.db.transaction(() => {
      if (!remember) {
        this.setPreference(projectId, browserAgentId, "disposable");
        return;
      }
      const saved = this.db.prepare("SELECT profile_id FROM browser_chat_profiles WHERE project_id=?").get(projectId) as { profile_id: string } | undefined;
      const previous = this.preference(projectId, browserAgentId);
      let profile = this.getProfile(projectId, saved?.profile_id ?? previous.profileId ?? "");
      if (!profile) {
        const names = new Set(this.listProfiles(projectId).map(item => item.name));
        let name = "Chat browser", suffix = 2;
        while (names.has(name)) name = `Chat browser ${suffix++}`;
        profile = this.createProfile(projectId, name);
      }
      this.db.prepare("INSERT INTO browser_chat_profiles(project_id,profile_id) VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET profile_id=excluded.profile_id").run(projectId, profile.id);
      this.setPreference(projectId, browserAgentId, "trusted", profile.id);
    })();
  }

  description(scope: BrowserScope, forceProfileId?: string): BrowserLaunchDescription {
    if (forceProfileId) {
      const profile = this.getProfile(scope.projectId, forceProfileId);
      if (!profile) throw new BrowserProfileError(404, "Trusted browser profile was not found.");
      return { profileMode: "trusted", profileId: profile.id, profileName: profile.name };
    }
    const preference = this.preference(scope.projectId, scope.actorAgentId ?? scope.agentId);
    if (preference.mode === "trusted" && preference.profileId && preference.profileName) {
      return { profileMode: "trusted", profileId: preference.profileId, profileName: preference.profileName };
    }
    return { profileMode: "disposable" };
  }

  async acquire(
    sessionId: string,
    description: BrowserLaunchDescription,
    signal: AbortSignal,
    onQueue: PendingLaunch["onQueue"],
  ): Promise<BrowserLaunchLease> {
    if (this.closed) throw new BrowserProfileError(409, "Browser profile authority is closed.");
    if (signal.aborted) throw new BrowserProfileError(409, "Browser opening was cancelled.");
    return new Promise<BrowserLaunchLease>((resolve, reject) => {
      const pending: PendingLaunch = {
        id: randomUUID(),
        sessionId,
        description,
        ...(description.profileId ? { profileKey: description.profileId } : {}),
        signal,
        onQueue,
        resolve,
        reject,
        abort: () => {
          const index = this.pending.indexOf(pending);
          if (index >= 0) this.pending.splice(index, 1);
          reject(new BrowserProfileError(409, "Browser opening was cancelled."));
          this.publishQueue();
          this.pump();
        },
      };
      signal.addEventListener("abort", pending.abort, { once: true });
      this.pending.push(pending);
      this.publishQueue();
      this.pump();
    });
  }

  private publishQueue(): void {
    this.pending.forEach((entry, index) => {
      const profileBusy = Boolean(entry.profileKey && [...this.active.values()]
        .some((active) => active.profileKey === entry.profileKey));
      entry.onQueue(index + 1, profileBusy ? "profile_in_use" : "host_capacity");
    });
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.active.size < this.maxActive) {
        const index = this.pending.findIndex((entry, candidateIndex) => {
          if (entry.signal.aborted) return true;
          if (entry.profileKey && [...this.active.values()].some((active) => active.profileKey === entry.profileKey)) return false;
          return !entry.profileKey || !this.pending.slice(0, candidateIndex)
            .some((earlier) => earlier.profileKey === entry.profileKey);
        });
        if (index < 0) break;
        const entry = this.pending.splice(index, 1)[0]!;
        entry.signal.removeEventListener("abort", entry.abort);
        if (entry.signal.aborted) {
          entry.reject(new BrowserProfileError(409, "Browser opening was cancelled."));
          continue;
        }
        const active: ActiveLaunch = {
          sessionId: entry.sessionId,
          ...(entry.profileKey ? { profileKey: entry.profileKey } : {}),
        };
        this.active.set(entry.sessionId, active);
        let released = false;
        entry.resolve({
          ...entry.description,
          driver: entry.description.profileMode === "trusted"
            ? {
                profileDir: path.join(this.profileRoot, entry.description.profileId!),
                retainProfile: true,
                hostedHeaded: true,
              }
            : { hostedHeaded: true },
          release: () => {
            if (released) return;
            released = true;
            this.active.delete(entry.sessionId);
            this.publishQueue();
            this.pump();
          },
        });
      }
      this.publishQueue();
    } finally {
      this.pumping = false;
    }
  }

  close(): void {
    if (this.closed) return;
    if (this.active.size || this.pending.length || this.pumping) {
      throw new BrowserProfileError(409, "Browser profile authority still has active or queued launch leases.");
    }
    this.db.close();
    this.closed = true;
  }

  status(): { active: number; queued: number; capacity: number; trustedProfilesInUse: number } {
    return {
      active: this.active.size,
      queued: this.pending.length,
      capacity: this.maxActive,
      trustedProfilesInUse: new Set([...this.active.values()].flatMap((entry) => entry.profileKey ? [entry.profileKey] : [])).size,
    };
  }
}

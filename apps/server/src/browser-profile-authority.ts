import { admitDataDirectory, type StateAdmission } from "@ponderosa/agents";
import { browserOwnerFromId, browserOwnerId, type BrowserOwner } from "@ponderosa/core";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "@ponderosa/native-host/fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { SAVED_BROWSER_SCOPE_ID, type SavedBrowserDto } from "@ponderosa/core";
import type {
  BrowserAgentPreferenceDto,
  BrowserProfileDto,
  BrowserProfileMode,
} from "@ponderosa/core";
import { BrowserRetainedInventory } from "./browser-retained-inventory.js";
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
  private readonly admission: StateAdmission;
  readonly retainedBrowsers: BrowserRetainedInventory;
  private get db(): Database.Database { return this.admission.client; }
  private readonly profileRoot: string;
  private readonly maxActive: number;
  private readonly pending: PendingLaunch[] = [];
  private readonly active = new Map<string, ActiveLaunch>();
  private pumping = false;

  constructor(
    dataDir: string,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.admission = admitDataDirectory(dataDir);
    dataDir = this.admission.dataDir;
    try {
      this.retainedBrowsers = new BrowserRetainedInventory(dataDir);
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      this.profileRoot = path.join(dataDir, "browser-profiles");
      mkdirSync(this.profileRoot, { recursive: true, mode: 0o700 });
      this.maxActive = boundedCapacity(env.PONDEROSA_BROWSER_MAX_ACTIVE);
    } catch (error) {
      this.admission.close();
      throw error;
    }
  }

  close(): void {
    if (this.active.size || this.pending.length) throw new Error("browser profile storage still has live leases");
    this.admission.close();
  }

  private requireOwner(id: string): BrowserOwner {
    const owner = browserOwnerFromId(id);
    if (!owner) throw new BrowserProfileError(409, "Explicit Chat or saved-browser ownership is required. Legacy resources remain retained and unassigned.");
    return owner;
  }

  private profile(row: Record<string, unknown>): BrowserProfileDto {
    return {
      id: String(row.id),
      projectId: String(row.namespaceId ?? row.projectId),
      owner: browserOwnerFromId(String(row.projectId)),
      name: String(row.name),
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
    };
  }

  private mapped(error: unknown): never {
    if (error instanceof BrowserProfileError) throw error;
    const code = (error as { code?: string })?.code ?? "";
    if (code.includes("UNIQUE")) throw new BrowserProfileError(409, "A browser profile with this name already exists in this Chat.");
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
    this.requireOwner(projectId);
    try {
      return (this.db.prepare(`SELECT id, project_id projectId, namespace_id namespaceId, name, created_at createdAt, updated_at updatedAt
        FROM browser_profiles WHERE project_id=? ORDER BY lower(name), id`).all(projectId) as Array<Record<string, unknown>>)
        .map((row) => this.profile(row));
    } catch (error) {
      return this.mapped(error);
    }
  }

  getProfile(projectId: string, profileId: string): BrowserProfileDto | undefined {
    this.requireOwner(projectId);
    try {
      const row = this.db.prepare(`SELECT id, project_id projectId, namespace_id namespaceId, name, created_at createdAt, updated_at updatedAt
        FROM browser_profiles WHERE project_id=? AND id=?`).get(projectId, profileId) as Record<string, unknown> | undefined;
      return row ? this.profile(row) : undefined;
    } catch (error) {
      return this.mapped(error);
    }
  }

  createProfile(projectId: string, requestedName: string, namespaceId = projectId): BrowserProfileDto {
    const owner = this.requireOwner(projectId);
    const id = randomUUID();
    const name = cleanName(requestedName);
    const now = new Date().toISOString();
    try {
      this.db.prepare("INSERT INTO browser_profiles(id,project_id,name,created_at,updated_at,namespace_id) VALUES(?,?,?,?,?,?)")
        .run(id, projectId, name, now, now, namespaceId);
      return { id, projectId: namespaceId, owner, name, createdAt: now, updatedAt: now };
    } catch (error) {
      return this.mapped(error);
    }
  }

  renameProfile(projectId: string, profileId: string, requestedName: string): BrowserProfileDto {
    this.requireOwner(projectId);
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
    this.requireOwner(projectId);
    const profile = this.getProfile(projectId, profileId);
    if (!profile) throw new BrowserProfileError(404, "Browser profile was not found.");
    this.retainedBrowsers.assertClear({ profileId: profile.id });
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
    this.retainedBrowsers.assertClear({ projectId });
    const rows = this.db.prepare(`SELECT id, project_id projectId, namespace_id namespaceId, name, created_at createdAt, updated_at updatedAt
      FROM browser_profiles WHERE namespace_id=?`).all(projectId) as Array<Record<string, unknown>>;
    if (rows.some(row => !browserOwnerFromId(String(row.projectId)))) throw new BrowserProfileError(409, "Unassigned retained browser profiles require an explicit custody decision before namespace cleanup.");
    const profiles = rows.map(row => this.profile(row));
    for (const profile of profiles) this.retainedBrowsers.assertClear({ profileId: profile.id });
    const ids = new Set(profiles.map((profile) => profile.id));
    if ([...this.active.values()].some((entry) => entry.profileKey && ids.has(entry.profileKey)) ||
        this.pending.some((entry) => entry.profileKey && ids.has(entry.profileKey))) {
      throw new BrowserProfileError(409, "Project browser profiles still have active or queued leases.");
    }
    try {
      for (const profile of profiles) {
        rmSync(this.profileDirectory(profile.id), { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
      }
      this.db.transaction(() => {
        this.db.prepare("DELETE FROM browser_agent_preferences WHERE namespace_id=?").run(projectId);
        this.db.prepare("DELETE FROM saved_browser_access WHERE project_id=?").run(projectId);
        this.db.prepare("DELETE FROM saved_browser_access_fences WHERE project_id=?").run(projectId);
        this.db.prepare("DELETE FROM saved_browser_approval_intents WHERE project_id=?").run(projectId);
        this.db.prepare("DELETE FROM browser_profiles WHERE namespace_id=?").run(projectId);
      }).immediate();
    } catch (error) {
      return this.mapped(error);
    }
  }

  deleteChat(ownerId: string): void {
    const owner = this.requireOwner(ownerId);
    if (owner.kind !== "chat") throw new BrowserProfileError(409, "Chat cleanup cannot remove the saved browser.");
    this.retainedBrowsers.assertClear({ conversationId: owner.conversationId });
    for (const profile of this.listProfiles(ownerId)) this.deleteProfile(ownerId, profile.id);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM browser_agent_preferences WHERE project_id=?").run(ownerId);
      this.db.prepare("DELETE FROM browser_chat_profiles WHERE project_id=?").run(ownerId);
    })();
  }

  preference(projectId: string, agentId: string): BrowserAgentPreferenceDto {
    this.requireOwner(projectId);
    try {
      const row = this.db.prepare(`SELECT p.agent_id agentId,p.project_id projectId,p.namespace_id namespaceId,p.mode,p.profile_id profileId,
          p.updated_at updatedAt,b.name profileName
        FROM browser_agent_preferences p LEFT JOIN browser_profiles b ON b.id=p.profile_id
        WHERE p.project_id=? AND p.agent_id=?`).get(projectId, agentId) as Record<string, unknown> | undefined;
      if (!row) return {
        agentId,
        projectId,
        owner: browserOwnerFromId(projectId),
        mode: "disposable",
        updatedAt: new Date(0).toISOString(),
      };
      return {
        agentId: String(row.agentId),
        projectId: String(row.namespaceId ?? row.projectId),
        owner: browserOwnerFromId(String(row.projectId)),
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
    namespaceId = projectId,
  ): BrowserAgentPreferenceDto {
    this.requireOwner(projectId);
    if (mode !== "disposable" && mode !== "trusted") {
      throw new BrowserProfileError(400, "Browser mode must be disposable or trusted.");
    }
    if (mode === "trusted" && (!profileId || !this.getProfile(projectId, profileId))) {
      throw new BrowserProfileError(400, "Select a trusted browser profile from this Chat.");
    }
    const now = new Date().toISOString();
    try {
      this.db.prepare(`INSERT INTO browser_agent_preferences(agent_id,project_id,mode,profile_id,updated_at,namespace_id)
        VALUES(?,?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET
        namespace_id=excluded.namespace_id,project_id=excluded.project_id,mode=excluded.mode,profile_id=excluded.profile_id,updated_at=excluded.updated_at`)
        .run(agentId, projectId, mode, mode === "trusted" ? profileId : null, now, namespaceId);
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
      this.db.prepare("UPDATE browser_profiles SET project_id=?,namespace_id=? WHERE id=? AND project_id=?").run(SAVED_BROWSER_SCOPE_ID, SAVED_BROWSER_SCOPE_ID, profileId, projectId);
      this.setPreference(SAVED_BROWSER_SCOPE_ID, `project-browser:${SAVED_BROWSER_SCOPE_ID}`, "trusted", profileId);
      this.db.prepare("INSERT INTO saved_browser(singleton,profile_id,promoted_at) VALUES(1,?,?)").run(profileId, new Date().toISOString());
    })();
  }

  setChatRememberSignIns(projectId: string, browserAgentId: string, remember: boolean, namespaceId = projectId): void {
    if (this.requireOwner(projectId).kind !== "chat") throw new BrowserProfileError(409, "Remember sign-ins belongs to a Chat browser.");
    this.db.transaction(() => {
      if (!remember) {
        this.setPreference(projectId, browserAgentId, "disposable", undefined, namespaceId);
        return;
      }
      const saved = this.db.prepare("SELECT profile_id FROM browser_chat_profiles WHERE project_id=?").get(projectId) as { profile_id: string } | undefined;
      const previous = this.preference(projectId, browserAgentId);
      let profile = this.getProfile(projectId, saved?.profile_id ?? previous.profileId ?? "");
      if (!profile) {
        const names = new Set(this.listProfiles(projectId).map(item => item.name));
        let name = "Chat browser", suffix = 2;
        while (names.has(name)) name = `Chat browser ${suffix++}`;
        profile = this.createProfile(projectId, name, namespaceId);
      }
      this.db.prepare("INSERT INTO browser_chat_profiles(project_id,profile_id) VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET profile_id=excluded.profile_id").run(projectId, profile.id);
      this.setPreference(projectId, browserAgentId, "trusted", profile.id, namespaceId);
    })();
  }

  description(scope: BrowserScope, forceProfileId?: string): BrowserLaunchDescription {
    if (!scope.owner) throw new BrowserProfileError(409, "Explicit browser custody is required.");
    const ownerId = browserOwnerId(scope.owner);
    if (forceProfileId) {
      const profile = this.getProfile(ownerId, forceProfileId);
      if (!profile) throw new BrowserProfileError(404, "Trusted browser profile was not found.");
      return { profileMode: "trusted", profileId: profile.id, profileName: profile.name };
    }
    const preference = this.preference(ownerId, scope.agentId);
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

  status(): { active: number; queued: number; capacity: number; trustedProfilesInUse: number } {
    return {
      active: this.active.size,
      queued: this.pending.length,
      capacity: this.maxActive,
      trustedProfilesInUse: new Set([...this.active.values()].flatMap((entry) => entry.profileKey ? [entry.profileKey] : [])).size,
    };
  }
}

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { LocalBrowserAction, LocalBrowserCommand, LocalBrowserConnectionDto, LocalBrowserPairingDto } from "@ponderosa/core";
import { BrowserDriverActionError, type BrowserUploadResult, type BrowserDriver, type BrowserDriverFactory, type BrowserPageInfo, type BrowserPagesInfo } from "./chrome-cdp-driver.js";
import { BrowserSessionError, redactPageInfo } from "./browser-security.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Pending = { command: LocalBrowserCommand; delivered: boolean; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type Connection = { dto: LocalBrowserConnectionDto; epoch: number; tokenHash: string; uncertain?: boolean; pending?: Pending; wake?: () => void; viewport: { width: number; height: number } };

/** Ephemeral capabilities deliberately die on restart; no browser credentials are stored. */
export class LocalBrowserHub {
  private readonly codes = new Map<string, { projectId: string; expires: number }>();
  private readonly connections = new Map<string, Connection>();
  pairing(projectId: string): LocalBrowserPairingDto {
    for (const [key, value] of this.connections) if (!value.dto.connected && !value.dto.claimed) this.connections.delete(key);
    for (const [key, value] of this.codes) if (value.expires < Date.now() || value.projectId === projectId) this.codes.delete(key);
    if (this.codes.size >= 32) throw new BrowserSessionError("Too many pending browser pairings.", 429);
    const code = randomBytes(24).toString("base64url"), expires = Date.now() + 5 * 60_000;
    this.codes.set(hash(code), { projectId, expires });
    return { code, expiresAt: new Date(expires).toISOString() };
  }
  claim(code: string, info: { url: string; title: string; paused?: boolean }): { token: string; connection: LocalBrowserConnectionDto } {
    const key = hash(code), pairing = this.codes.get(key);
    if (!pairing || pairing.expires < Date.now()) throw new BrowserSessionError("Pairing code is invalid or expired.", 401);
    let url: URL;
    try { url = new URL(info.url); } catch { throw new BrowserSessionError("Invalid tab URL."); }
    if ((url.protocol !== "https:" && info.url !== "about:blank") || url.username || url.password) throw new BrowserSessionError("Connect an HTTPS application window.");
    if (this.connections.size >= 32) throw new BrowserSessionError("Disconnect an existing local browser first.", 429);
    this.codes.delete(key);
    const token = randomBytes(32).toString("base64url"), id = randomUUID();
    const safe = redactPageInfo(info);
    const dto = { id, projectId: pairing.projectId, url: safe.url, title: safe.title, connected: true, claimed: false, paused: info.paused === true };
    this.connections.set(id, { dto, epoch: 0, tokenHash: hash(token), viewport: { width: 1280, height: 720 } });
    return { token, connection: { ...dto } };
  }
  list(projectId: string): LocalBrowserConnectionDto[] {
    return [...this.connections.values()].filter(c => c.dto.projectId === projectId).map(c => ({ ...c.dto }));
  }
  private authorized(id: string, token: string): Connection {
    const connection = this.connections.get(id);
    if (!connection || connection.tokenHash !== hash(token)) throw new BrowserSessionError("Local browser authorization expired. Pair again.", 401);
    return connection;
  }
  async poll(id: string, token: string): Promise<LocalBrowserCommand | null> {
    const connection = this.authorized(id, token);
    if (!connection.dto.connected) throw new BrowserSessionError("Local browser disconnected.", 410);
    if (connection.wake) throw new BrowserSessionError("A poll is already active.", 409);
    if (!connection.pending || connection.pending.delivered) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { connection.wake = undefined; resolve(); }, 10_000);
        connection.wake = () => { clearTimeout(timer); connection.wake = undefined; resolve(); };
      });
    }
    const pending = connection.pending;
    if (!pending || pending.delivered) return null;
    pending.delivered = true;
    return pending.command;
  }
  result(id: string, token: string, commandId: string, value: unknown, failed: boolean): void {
    const connection = this.authorized(id, token), pending = connection.pending;
    if (!pending || pending.command.id !== commandId || !pending.delivered) throw new BrowserSessionError("Stale browser result rejected.", 409);
    clearTimeout(pending.timer); connection.pending = undefined;
    if (failed) { connection.uncertain = true; pending.reject(new BrowserSessionError("The connected tab could not perform that action. Check it locally before retrying.", 409)); }
    else pending.resolve(value);
  }
  detached(id: string, token: string): void {
    const connection = this.authorized(id, token);
    connection.dto.connected = false;
    const pending = connection.pending;
    if (pending) { clearTimeout(pending.timer); connection.pending = undefined; pending.command.action === "disconnect" ? pending.resolve(null) : pending.reject(new BrowserSessionError("The local browser was disconnected.", 409)); }
    connection.wake?.();
  }
  state(id: string, token: string, paused: boolean, epoch: number): void {
    const connection = this.authorized(id, token);
    if (!connection.dto.connected || !Number.isSafeInteger(epoch) || epoch <= connection.epoch) throw new BrowserSessionError("Stale browser state rejected.", 409);
    if (connection.pending?.command.action === "disconnect") throw new BrowserSessionError("Browser is disconnecting.", 409);
    connection.epoch = epoch;
    connection.dto.paused = paused;
    const pending = connection.pending;
    if (pending) {
      clearTimeout(pending.timer); connection.pending = undefined;
      pending.reject(new BrowserSessionError("Local browser paused for manual control. Resume in the extension; this action will not be replayed.", 409));
    }
    connection.wake?.();
  }
  private call(connection: Connection, action: LocalBrowserAction, args: Record<string, unknown> = {}): Promise<unknown> {
    if (connection.dto.paused && action !== "disconnect") return Promise.reject(new BrowserSessionError("Local browser paused for manual control. Resume in the extension.", 409));
    if (!connection.dto.connected || connection.pending || (connection.uncertain && action !== "disconnect")) return Promise.reject(new BrowserSessionError("Local browser unavailable or busy. Disconnect and pair again.", 409));
    return new Promise((resolve, reject) => {
      const command = { id: randomUUID(), action, args, expiresAt: Date.now() + 15_000, connectionEpoch: connection.epoch };
      const timer = setTimeout(() => {
        if (connection.pending?.command.id === command.id) connection.pending = undefined;
        connection.uncertain = true;
        reject(new BrowserSessionError("Local browser did not confirm the action. It has not been retried.", 504));
      }, 15_000);
      connection.pending = { command, delivered: false, resolve, reject, timer };
      connection.wake?.();
    });
  }
  factory(projectId: string, id: string): BrowserDriverFactory {
    const connection = this.connections.get(id);
    if (!connection || connection.dto.projectId !== projectId || !connection.dto.connected || connection.dto.claimed) throw new BrowserSessionError("Connected tab is not available for this Chat.", 409);
    connection.dto.claimed = true;
    return async (_sessionId, _console, publish) => {
      const viewports = new Map<string, { width: number; height: number }>();
      let activePageId = "";
      let cachedPages: BrowserPagesInfo = { activePageId: "0", pages: [{ pageId: "0", url: "about:blank", title: "Local browser paused", active: true, isNew: false, closable: false }] };
      const info = async (pageId?: string): Promise<BrowserPageInfo> => {
        const result = await this.call(connection, "info", { pageId }) as { url?: unknown; title?: unknown; width?: unknown; height?: unknown };
        if (typeof result?.url !== "string" || typeof result.title !== "string" || !Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height) || Number(result.width) < 1 || Number(result.width) > 8192 || Number(result.height) < 1 || Number(result.height) > 8192) throw new BrowserSessionError("Invalid local browser response.");
        connection.viewport = { width: Number(result.width), height: Number(result.height) };
        viewports.set(pageId ?? activePageId, connection.viewport);
        const safe = redactPageInfo({ url: result.url, title: result.title });
        connection.dto.url = safe.url; connection.dto.title = safe.title;
        return safe;
      };
      const pages = async (action: LocalBrowserAction = "pages", pageId?: string): Promise<BrowserPagesInfo> => {
        if (connection.dto.paused && action === "pages") return cachedPages;
        let result: BrowserPagesInfo;
        try { result = await this.call(connection, action, { pageId }) as BrowserPagesInfo; }
        catch (error) { if (connection.dto.paused && action === "pages") return cachedPages; throw error; }
        if (!result || typeof result.activePageId !== "string" || !Array.isArray(result.pages) || !result.pages.length || result.pages.length > 50 || new Set(result.pages.map(page => page.pageId)).size !== result.pages.length || !result.pages.some(page => page.pageId === result.activePageId)) throw new BrowserSessionError("Invalid local browser tabs.");
        for (const page of result.pages) if (!/^\d+$/.test(page.pageId) || typeof page.url !== "string" || typeof page.title !== "string") throw new BrowserSessionError("Invalid local browser tab.");
        activePageId = result.activePageId;
        cachedPages = { activePageId, pages: result.pages.map(page => ({ ...redactPageInfo(page), pageId: page.pageId, active: page.pageId === activePageId, isNew: false, closable: result.pages.length > 1 })) };
        return cachedPages;
      };
      const uploadedPages = new Map<string, string>();
      const action = async (name: LocalBrowserAction, args: Record<string, unknown>) => { await this.call(connection, name, args); return info(); };
      const driver: BrowserDriver = {
        paused: () => connection.dto.paused,
        controlRevision: () => connection.epoch,
        isAlive: () => connection.dto.connected,
        close: async () => { if (connection.dto.connected) await this.call(connection, "disconnect"); connection.dto.connected = false; this.connections.delete(id); },
        pageInfo: info,
        pages: () => pages(), newPage: () => pages("newPage"),
        activatePage: pageId => pages("activatePage", pageId), closePage: pageId => pages("closePage", pageId),
        upload: async input => {
          const pageId = activePageId;
          if (!pageId || connection.dto.paused) throw new BrowserSessionError("Choose an active local tab before attaching a file.", 409);
          const body = await readFile(input.stagedPath);
          if (body.length !== input.expectedSize || body.length > 10 * 1024 * 1024) throw new BrowserSessionError("Invalid staged upload.");
          uploadedPages.set(input.uploadId, pageId);
          try {
            const result = await this.call(connection, "upload", { pageId, uploadId: input.uploadId, selector: input.selector, name: input.expectedName, type: input.expectedMediaType, size: body.length, base64: body.toString("base64") }) as BrowserUploadResult;
            if (result?.pageId !== pageId || result.input?.name !== input.expectedName || result.input?.size !== body.length || result.input?.count !== 1 || result.input?.type !== input.expectedMediaType) throw new Error("Upload verification failed");
            return { ...redactPageInfo(result), pageId, input: result.input };
          } catch { throw new BrowserDriverActionError("upload_verification_failed"); }
        },
        clearUploadedFiles: async (pageId, uploadId) => {
          for (const [id, target] of uploadedPages) {
            if ((pageId && pageId !== target) || (uploadId && uploadId !== id)) continue;
            await this.call(connection, "clearUploads", { pageId: target, uploadId: id });
            uploadedPages.delete(id);
          }
        }, cancelPendingFileChooser: async () => {},
        navigate: url => action("navigate", { url }),
        inspect: async selector => {
          const value = await this.call(connection, "inspect", { selector });
          if (typeof value !== "string" || value.length > 32_000) throw new BrowserSessionError("Invalid local browser observation.");
          return value;
        },
        click: selector => action("click", { selector }), fill: (selector, text) => action("fill", { selector, text }),
        key: key => action("key", { key }), pointer: (x, y) => action("pointer", { x, y }),
        type: text => action("type", { text }), scroll: (deltaX, deltaY) => action("scroll", { deltaX, deltaY }),
        viewport: pageId => viewports.get(pageId ?? activePageId) ?? connection.viewport,
        capture: async pageId => {
          const current = await pages();
          if (pageId && !current.pages.some(page => page.pageId === pageId)) throw new BrowserSessionError("This tab is no longer in the connected window.", 404);
          await info(pageId);
          const value = await this.call(connection, "capture", { pageId });
          if (typeof value !== "string" || value.length > 22_000_000 || !/^[A-Za-z0-9+/=]+$/.test(value)) throw new BrowserSessionError("Invalid local browser frame.");
          const body = Buffer.from(value, "base64");
          if (body.length < 24 || !body.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new BrowserSessionError("Invalid local browser image.");
          return body;
        },
      };
      publish?.(driver, { complete: true, coversReturnedDriver: true });
      return driver;
    };
  }
}

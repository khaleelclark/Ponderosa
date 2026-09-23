interface ChromeTab { id?: number; windowId?: number; url?: string; title?: string; active?: boolean }
declare const chrome: {
  debugger: {
    attach(target: { tabId: number }, version: string): Promise<void>;
    detach(target: { tabId: number }): Promise<void>;
    sendCommand(target: { tabId: number }, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
    onDetach: { addListener(callback: (target: { tabId?: number }) => void): void };
  };
  tabs: {
    get(id: number): Promise<ChromeTab>;
    query(query: { active?: boolean; currentWindow?: boolean; windowId?: number }): Promise<ChromeTab[]>;
    create(options: { windowId: number; url: string; active: boolean }): Promise<ChromeTab>;
    update(id: number, options: { active: boolean }): Promise<ChromeTab>;
    remove(id: number): Promise<void>;
    onDetached: { addListener(callback: (id: number, info: { oldWindowId: number }) => void): void };
    onUpdated: { addListener(callback: (id: number, changes: { url?: string }) => void): void };
    onRemoved: { addListener(callback: (id: number) => void): void };
  };
  windows: { onRemoved: { addListener(callback: (id: number) => void): void } };
  storage: { session: { get(key: string): Promise<Record<string, unknown>>; set(value: Record<string, unknown>): Promise<void>; remove(key: string): Promise<void> } };
  permissions: { request(value: { origins: string[] }): Promise<boolean> };
  runtime: {
    sendMessage(value: unknown): Promise<unknown>;
    onMessage: { addListener(callback: (message: Record<string, unknown>, sender: { id?: string; url?: string; tab?: ChromeTab }, respond: (response: unknown) => void) => boolean): void };
    id: string;
  };
  action: { setBadgeText(value: { text: string }): Promise<void>; setBadgeBackgroundColor(value: { color: string }): Promise<void> };
};

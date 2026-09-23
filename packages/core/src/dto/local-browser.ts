/** Commands accepted by the paired extension; arbitrary CDP/JavaScript is never forwarded. */
export type LocalBrowserAction = "info" | "pages" | "activatePage" | "closePage" | "newPage" | "inspect" | "click" | "fill" | "key" | "pointer" | "type" | "scroll" | "capture" | "navigate" | "disconnect" | "upload" | "clearUploads";
export interface LocalBrowserCommand {
  id: string;
  action: LocalBrowserAction;
  expiresAt: number;
  connectionEpoch: number;
  args: Record<string, unknown>;
}
export interface LocalBrowserConnectionDto {
  id: string;
  projectId: string;
  url: string;
  title: string;
  connected: boolean;
  claimed: boolean;
  paused: boolean;
}
export interface LocalBrowserPairingDto { code: string; expiresAt: string }

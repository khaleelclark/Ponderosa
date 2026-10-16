import { serverOrigin } from "./policy.js";
const status = document.querySelector<HTMLElement>("#status")!;
const connect = document.querySelector<HTMLButtonElement>("#connect")!;
const disconnect = document.querySelector<HTMLButtonElement>("#disconnect")!;
const pause = document.querySelector<HTMLButtonElement>("#pause")!;
const resume = document.querySelector<HTMLButtonElement>("#resume")!;
async function refresh() {
  const result = await chrome.runtime.sendMessage({ action: "status" }) as { connected?: boolean; paused?: boolean; site?: string; error?: string };
  status.textContent = result.error ?? (result.connected ? result.paused ? `Paired with ${result.site}. Browser control is detached. Sign in or browse normally, then choose Resume browser access.` : `Connected to ${result.site}. Pause for manual control whenever you need it.` : "Connect this window whenever you want, including before signing in.");
  connect.disabled = Boolean(result.connected);
  disconnect.hidden = !result.connected;
  pause.hidden = !result.connected || Boolean(result.paused);
  resume.hidden = !result.connected || !result.paused;
}
connect.addEventListener("click", async () => {
  try {
    const server = serverOrigin(document.querySelector<HTMLInputElement>("#server")!.value.trim());
    const code = document.querySelector<HTMLInputElement>("#code")!.value.trim();
    if (code.length !== 32) throw new Error("Paste the pairing code from Ponderosa.");
    if (!document.querySelector<HTMLInputElement>("#consent")!.checked) throw new Error("Confirm access to this window first.");
    if (!await chrome.permissions.request({ origins: [`https://${new URL(server).hostname}/*`] })) throw new Error("Permission to connect to Ponderosa was not granted.");
    connect.disabled = true;
    const result = await chrome.runtime.sendMessage({ action: "connect", server, code }) as { error?: string };
    if (result.error) throw new Error(result.error);
    document.querySelector<HTMLInputElement>("#code")!.value = "";
    await refresh();
  } catch (error) { status.textContent = error instanceof Error ? error.message : "Connection failed"; connect.disabled = false; }
});
disconnect.addEventListener("click", async () => { await chrome.runtime.sendMessage({ action: "disconnect" }); await refresh(); });
for (const [button, action] of [[pause, "pause"], [resume, "resume"]] as const) button.addEventListener("click", async () => {
  button.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ action }) as { error?: string };
    await refresh();
    if (result.error) status.textContent = result.error;
  } finally { button.disabled = false; }
});
void refresh();

// Qualification-only probes retained when the public Doctor tool was retired.
// No runtime command calls this module or changes startup validation.
import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

function filesystemProbe(nativeHost, root) {
  if (!nativeHost.secureFileAuthoritySupported()) return false;
  const relativeDirectory = `qualification-secure-${randomUUID()}`;
  const leaf = "authority.txt";
  try {
    nativeHost.writeSecureFileAtomic({ root, relativeDirectory, leaf,
      temporaryLeaf: `.authority.${randomUUID()}.tmp`, body: Buffer.from("retained-authority") });
    const body = nativeHost.readSecureFile({ root, relativePath: `${relativeDirectory}/${leaf}`,
      maxBytes: 64, requireNonEmpty: true });
    const entries = nativeHost.listSecureDirectory({ root, relativePath: relativeDirectory });
    return body?.toString() === "retained-authority" &&
      entries?.some(entry => entry.name === leaf && entry.kind === "file" && entry.size === body.length) === true &&
      nativeHost.removeSecureFile({ root, relativeDirectory, leaf });
  } finally {
    try { rmdirSync(path.join(root, relativeDirectory)); } catch { /* failed probes remain fail-closed */ }
  }
}

function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

async function processProbe(nativeHost, nodeExecutable) {
  if (process.platform === "win32") {
    if (!nativeHost.windowsJobObjectsSupported()) return false;
    const job = new nativeHost.WindowsProcessJob();
    const child = spawn(nodeExecutable, ["-e", [
      "const {spawn}=require('node:child_process');",
      "process.once('message',message=>{if(message!=='start'){process.exitCode=125;process.disconnect?.();return;}",
      "const descendant=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore',windowsHide:true});",
      "descendant.once('spawn',()=>process.send?.({ready:true,pid:descendant.pid}));",
      "descendant.once('error',()=>process.send?.({ready:false}));setInterval(()=>{},1000);});",
    ].join("")], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
    try {
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      if (!child.pid) return false;
      job.assign(child.pid);
      const ready = new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), 5000);
        child.once("message", message => { clearTimeout(timer); resolve(message?.ready === true); });
      });
      child.send("start");
      if (!await ready) return false;
      job.terminate();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && job.activeProcesses() > 0) await delay(25);
      return job.activeProcesses() === 0;
    } finally { job.close(); }
  }
  const child = spawn(nodeExecutable, ["-e", [
    "const {spawn}=require('node:child_process');",
    "process.on('SIGTERM',()=>{});",
    "const descendant=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});process.send?.({ready:true});setInterval(()=>{},1000)\"],{stdio:['ignore','ignore','ignore','ipc']});",
    "descendant.once('message',message=>process.send?.(message));",
    "descendant.once('error',()=>process.send?.({ready:false}));",
    "setInterval(()=>{},1000);",
  ].join("")], { stdio: ["ignore", "ignore", "ignore", "ipc"], detached: true });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  if (!child.pid) return false;
  try {
    const ready = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), 5000);
      child.once("message", message => { clearTimeout(timer); resolve(message?.ready === true); });
    });
    if (!ready) return false;
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* observe exit */ }
    await delay(100);
    if (groupAlive(child.pid)) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* observe exit */ } }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && groupAlive(child.pid)) await delay(25);
    return !groupAlive(child.pid);
  } finally {
    // Only the disposable group created above is eligible for cleanup.
    if (groupAlive(child.pid)) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* observe in the caller's result */ } }
    child.disconnect?.();
  }
}

export async function qualifyLauncherSafety(installRoot) {
  const nativeHost = createRequire(path.join(installRoot, "app", "server", "package.json"))("@ponderosa/native-host");
  const root = mkdtempSync(path.join(tmpdir(), "ponderosa-launcher-qualification-"));
  const checks = [];
  try {
    for (const [id, probe, detail] of [
      ["secure-filesystem", () => filesystemProbe(nativeHost, root), "Native secure read/write/list/remove authority"],
      ["process", () => processProbe(nativeHost, path.join(installRoot, "runtime", process.platform === "win32" ? "node.exe" : "node")), "Observed disposable process-tree exit"],
    ]) {
      try { checks.push({ id, status: await probe() ? "pass" : "fail", detail }); }
      catch (error) { checks.push({ id, status: "fail", detail: error.message }); }
    }
    return checks;
  } finally { try { rmdirSync(root); } catch { /* retain failed-probe evidence */ } }
}

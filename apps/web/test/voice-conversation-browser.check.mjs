import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { pluginReact } from "@rsbuild/plugin-react";
import { createRsbuild } from "@rsbuild/core";

const root = fileURLToPath(new URL("..", import.meta.url));
let output;
const serverRequire = createRequire(new URL("../../server/package.json", import.meta.url));
let browser; let server;
try {
  output = await mkdtemp(path.join(tmpdir(), "ponderosa-speech-browser-"));
  console.log("OWN ROOT", output);
  const playwrightModule = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH ?? pathToFileURL(serverRequire.resolve("playwright-core")).href);
  const chromium = playwrightModule.chromium ?? playwrightModule.default.chromium;
  const build = await createRsbuild({ cwd: root, rsbuildConfig: { plugins: [pluginReact()],
    source: { transformImport: [], entry: { index: path.join(root, "test/voice-conversation-browser-entry.tsx") } },
    output: { distPath: { root: output } }, logLevel: "error",
  } });
  await build.build();
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname.includes("..")) { response.writeHead(400).end(); return; }
    try {
      const file = path.join(output, pathname === "/" ? "index.html" : pathname);
      response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : "text/html");
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  console.log("OWN HTTP ADDRESS", JSON.stringify(server.address()));
  browser = await chromium.launch({ headless: true, executablePath: process.env.PONDEROSA_CHROMIUM_PATH, args: process.env.PONDEROSA_BROWSER_DISABLE_SANDBOX === "1" ? ["--no-sandbox"] : [] });
  const url = `http://127.0.0.1:${server.address().port}`;
  let cases = 0;
  async function scenario(name, run) {
    const page = await browser.newPage(); const errors=[]; page.on("pageerror",error=>errors.push(error.message));
    await page.goto(url); await page.waitForFunction(()=>Boolean(window.voiceTest));

    const open=async()=>{ await page.getByRole("button",{name:"Voice input",exact:true}).click(); await page.getByRole("menuitem",{name:"Call Agent",exact:true}).click(); await page.getByRole("dialog").waitFor(); };
    const type=async text=> { await page.getByLabel("Your next turn").fill(text); };
    const send=async()=>{ await page.getByRole("button",{name:"Send turn",exact:true}).click(); };
    await run(page,{open,type,send});
    await page.getByRole("button",{name:"End call",exact:true}).evaluateAll(buttons=>buttons.forEach(button=>button.click()));
    await page.evaluate(()=>window.voiceTest.stopRead());
    await page.evaluate(()=>window.voiceTest.unmount());
    await page.waitForTimeout(350);
    const resources=await page.evaluate(()=>window.voiceTest.resources());
    assert.equal(resources.recognition,0,`${name}: no recognition handlers`);
    assert.equal(resources.synthesis,0,`${name}: no synthesis handlers`);
    assert.equal(resources.intervals,0,`${name}: query fallback interval release`);
    assert.equal(resources.monitors,0,`${name}: observer release`);
    // Ordinary dictation's transient stopped notice is allowed until its documented 3s expiry.
    if(resources.timers) await page.waitForTimeout(3100);
    assert.equal((await page.evaluate(()=>window.voiceTest.resources())).timers,0,`${name}: timer release`);
    assert.ok(Object.values(await page.evaluate(()=>window.voiceTest.listenerCounts())).every(n=>n===0),`${name}: zero owned surface listeners`);
    assert.deepEqual(errors,[],`${name}: browser errors`);
    cases++; console.log(`PASS ${cases}: ${name}`); await page.close();
  }
  const startAutomatic = async p => { await p.getByRole("button",{name:"Start hands-free call",exact:true}).click(); await p.getByText("Listening…",{exact:true}).waitFor(); };
  await scenario("explicit consent enables two automatic turns; final duplicates once; settled playback re-arms",async(p,{open})=>{
    await open(); assert.equal(await p.evaluate(()=>window.voiceTest.stats.starts),0);
    await p.getByText(/send each finalized spoken turn automatically/).waitFor();
    await startAutomatic(p);
    await p.evaluate(()=>{window.voiceTest.interim("Never send partial");window.voiceTest.final("First final turn");window.voiceTest.final("First final turn");});
    assert.equal(await p.evaluate(()=>window.voiceTest.stats.sends.length),0);
    await p.evaluate(()=>window.voiceTest.speechEnd());
    await p.waitForFunction(()=>window.voiceTest.stats.spoken.length===1);
    assert.equal(await p.evaluate(()=>window.voiceTest.stats.sends.length),1);
    assert.equal(await p.evaluate(()=>window.voiceTest.stats.sends[0].text),"First final turn");
    assert.equal(await p.evaluate(()=>window.voiceTest.stats.starts),1);
    assert.equal((await p.evaluate(()=>window.voiceTest.resources())).recognition,0);
    const first=await p.getByLabel("Call timing").innerText(); assert.match(first,/settled → accepted \d+ ms.*canonical reply \d+ ms.*speech started \d+ ms/);console.log("SYNTHETIC MONOTONIC SEGMENTS",first);
    await p.evaluate(()=>window.voiceTest.complete()); await p.waitForFunction(()=>window.voiceTest.stats.starts===2);
    await p.evaluate(()=>window.voiceTest.recognized("Second automatic turn"));await p.waitForFunction(()=>window.voiceTest.stats.spoken.length===2);
    const sends=await p.evaluate(()=>window.voiceTest.stats.sends);assert.equal(sends.length,2);assert.notEqual(sends[0].idempotencyKey,sends[1].idempotencyKey);assert.equal(sends[1].text,"Second automatic turn");
    assert.ok(sends.every(s=>s.activeRunDelivery==="queue"&&s.recipients.length===1&&s.recipients[0].agentId==="agent"));
    assert.equal(await p.evaluate(()=>window.voiceTest.stats.echoCapture),0);
  });
  await scenario("speechend waits for late final settlement; no partial automatic submission",async(p,{open})=>{
    await open();await startAutomatic(p);await p.evaluate(()=>{window.voiceTest.stats.finalOnStop=true;window.voiceTest.interim("Pending partial");window.voiceTest.speechEnd();});
    await p.waitForFunction(()=>window.voiceTest.stats.sends.length===1);assert.equal(await p.evaluate(()=>window.voiceTest.stats.sends[0].text),"Final words on finish");
  });
  for(const mode of ["empty","interim","no-speech"])await scenario(`automatic ${mode} pauses without send or restart loop`,async(p,{open})=>{
    await open();await startAutomatic(p);await p.evaluate(mode=>{if(mode==="interim")window.voiceTest.interim("Unfinished");if(mode==="no-speech")window.voiceTest.failRecognition("no-speech");else window.voiceTest.emptyEnd();},mode);
    await p.getByRole("button",{name:"Resume call",exact:true}).waitFor();assert.equal(await p.evaluate(()=>window.voiceTest.stats.sends.length),0);assert.equal(await p.evaluate(()=>window.voiceTest.stats.starts),1);
  });
  await scenario("Interrupt / Talk now fences old playback and captures next finalized turn",async(p,{open})=>{
    await open();await startAutomatic(p);await p.evaluate(()=>window.voiceTest.recognized("First interrupt turn"));await p.waitForFunction(()=>window.voiceTest.stats.spoken.length===1);
    await p.evaluate(()=>{window.oldSpeech=window.voiceTest.staleSpeech();});await p.getByRole("button",{name:"Interrupt / Talk now",exact:true}).click();await p.waitForFunction(()=>window.voiceTest.stats.starts===2);
    await p.evaluate(()=>window.oldSpeech());assert.equal(await p.evaluate(()=>window.voiceTest.stats.starts),2);assert.equal((await p.evaluate(()=>window.voiceTest.resources())).synthesis,0);
    await p.evaluate(()=>window.voiceTest.recognized("Interrupted second turn"));await p.waitForFunction(()=>window.voiceTest.stats.sends.length===2);assert.equal(await p.evaluate(()=>window.voiceTest.stats.echoCapture),0);
  });
  for(const boundary of ["Mute","End","pagehide","background","popstate","deleteAgent","switchChat"])await scenario(`automatic playback never re-arms after ${boundary}`,async(p,{open})=>{
    await open();await startAutomatic(p);await p.evaluate(()=>window.voiceTest.recognized("Lifecycle automatic turn"));await p.waitForFunction(()=>window.voiceTest.stats.spoken.length===1);await p.evaluate(()=>{window.oldSpeech=window.voiceTest.staleSpeech();});
    if(boundary==="Mute"||boundary==="End")await p.getByRole("button",{name:boundary==="Mute"?"Mute microphone":"End call",exact:true}).click();
    else await p.evaluate(boundary=>{if(["deleteAgent","switchChat"].includes(boundary))window.voiceTest[boundary]();else if(boundary==="background"){Object.defineProperty(document,"visibilityState",{value:"hidden",configurable:true});document.dispatchEvent(new Event("visibilitychange"));}else window.dispatchEvent(new Event(boundary));},boundary);
    await p.evaluate(()=>window.oldSpeech());assert.equal(await p.evaluate(()=>window.voiceTest.stats.starts),1);assert.equal(await p.evaluate(()=>window.voiceTest.stats.sends.length),1);
    if(boundary==="Mute"){await p.getByRole("button",{name:"Unmute microphone",exact:true}).click();assert.equal(await p.evaluate(()=>window.voiceTest.stats.starts),1);}
  });
  for(const mode of ["not-allowed","failSpeech","hangSpeech","cancelThrows"])await scenario(`automatic ${mode} disables loop with readable/manual recovery`,async(p,{open})=>{
    await open();await startAutomatic(p);
    if(mode==="not-allowed")await p.evaluate(()=>window.voiceTest.failRecognition("not-allowed"));
    else {await p.evaluate(mode=>{window.voiceTest.stats[mode]=true;window.voiceTest.recognized("Failure turn");},mode);if(mode==="cancelThrows"){await p.waitForFunction(()=>window.voiceTest.stats.spoken.length===1);await p.evaluate(()=>window.voiceTest.complete());}}
    await p.getByRole("alert").filter({hasText:mode==="not-allowed"?/permission was denied/:mode==="cancelThrows"?/cleanup could not be confirmed/:/could not read/}).waitFor({timeout:5000});
    assert.equal(await p.getByText("Hands-free call active · automatic finalized turns",{exact:true}).count(),0);assert.equal(await p.evaluate(()=>window.voiceTest.stats.starts),1);
    await p.evaluate(()=>{window.voiceTest.stats.cancelThrows=false;});
  });
  await scenario("unknown auto-send acknowledgment blocks new capture; deliberate retry retains same body/key",async(p,{open})=>{
    await open();await startAutomatic(p);await p.evaluate(()=>{window.voiceTest.stats.fail=true;window.voiceTest.recognized("Unknown automatic turn");});await p.getByRole("button",{name:"Retry same turn",exact:true}).waitFor();
    assert.equal(await p.getByRole("button",{name:"Start hands-free call",exact:true}).isEnabled(),false);assert.equal(await p.getByText("Hands-free call active · automatic finalized turns",{exact:true}).count(),0);
    await p.evaluate(()=>{window.voiceTest.stats.fail=false;});await p.getByRole("button",{name:"Retry same turn",exact:true}).click();await p.waitForFunction(()=>window.voiceTest.stats.spoken.length===1);
    const sends=await p.evaluate(()=>window.voiceTest.stats.sends);assert.equal(sends.length,2);assert.deepEqual(sends[0],sends[1]);await p.evaluate(()=>window.voiceTest.complete());assert.equal(await p.evaluate(()=>window.voiceTest.stats.starts),1);
    assert.ok((await p.evaluate(()=>[...Object.values(sessionStorage),...Object.values(localStorage)])).every(s=>!s.includes("Unknown automatic turn")));
  });
  await scenario("existing query invalidation wakes canonical reply before fallback; unrelated scope does not read",async(p,{open})=>{
    await open();await startAutomatic(p);await p.evaluate(()=>{window.voiceTest.stats.waiting=true;window.voiceTest.recognized("Event wake turn");});await p.getByText(/Agent working/).waitFor();
    const before=await p.evaluate(()=>window.voiceTest.stats.reads);await p.evaluate(()=>window.voiceTest.wakeOther());assert.equal(await p.evaluate(()=>window.voiceTest.stats.reads),before);
    const start=await p.evaluate(()=>performance.now());await p.evaluate(()=>{window.voiceTest.stats.waiting=false;return window.voiceTest.wake();});await p.waitForFunction(()=>window.voiceTest.stats.spoken.length===1);
    const elapsed=await p.evaluate(start=>performance.now()-start,start);assert.ok(elapsed<1500,`synthetic wake ${elapsed}ms avoids old 1500ms polling`);console.log("SYNTHETIC QUERY WAKE MS",elapsed);
  });
  await scenario("bounded fallback reads canonical reply when stream wake missing",async(p,{open})=>{
    await open();await startAutomatic(p);await p.evaluate(()=>{window.voiceTest.stats.waiting=true;window.voiceTest.recognized("Fallback turn");});await p.getByText(/Agent working/).waitFor();await p.evaluate(()=>{window.voiceTest.stats.waiting=false;});await p.waitForFunction(()=>window.voiceTest.stats.spoken.length===1,{timeout:6500});
    assert.equal(await p.evaluate(()=>window.voiceTest.stats.sends.length),1);
  });
  await scenario("Review / type instead pauses automatic capture preserving final words for manual Send",async(p,{open,send})=>{
    await open();await startAutomatic(p);await p.evaluate(()=>window.voiceTest.final("Review these final words"));await p.getByRole("button",{name:"Review / type instead",exact:true}).click();
    assert.equal(await p.getByLabel("Your next turn").inputValue(),"Review these final words");assert.equal(await p.evaluate(()=>window.voiceTest.stats.sends.length),0);await send();await p.waitForFunction(()=>window.voiceTest.stats.spoken.length===1);await p.evaluate(()=>window.voiceTest.complete());assert.equal(await p.evaluate(()=>window.voiceTest.stats.starts),1);
  });
  for(const boundary of ["Mute","End","pagehide","background","popstate","deleteAgent","switchChat"])await scenario(`automatic capture final/end callbacks fenced after ${boundary}`,async(p,{open})=>{
    await open();await startAutomatic(p);await p.evaluate(()=>{window.oldResult=window.voiceTest.staleResult();window.oldEnd=window.voiceTest.staleEnd();});
    if(boundary==="Mute"||boundary==="End")await p.getByRole("button",{name:boundary==="Mute"?"Mute microphone":"End call",exact:true}).click();
    else await p.evaluate(boundary=>{if(["deleteAgent","switchChat"].includes(boundary))window.voiceTest[boundary]();else if(boundary==="background"){Object.defineProperty(document,"visibilityState",{value:"hidden",configurable:true});document.dispatchEvent(new Event("visibilitychange"));}else window.dispatchEvent(new Event(boundary));},boundary);
    await p.evaluate(()=>{window.oldResult({results:[{isFinal:true,0:{transcript:"Forbidden automatic stale turn"}}]});window.oldEnd();});assert.equal(await p.evaluate(()=>window.voiceTest.stats.sends.length),0);assert.equal((await p.evaluate(()=>window.voiceTest.resources())).recognition,0);
  });
  await scenario("automatic unknown marker after reload forbids capture and replacement send",async(p,{open})=>{
    await open();await startAutomatic(p);await p.evaluate(()=>{window.voiceTest.stats.fail=true;window.voiceTest.recognized("Unknown before reload");});await p.getByRole("button",{name:"Retry same turn",exact:true}).waitFor();await p.reload();await open();await p.getByRole("alert").filter({hasText:/requires Chat review/}).waitFor();
    assert.equal(await p.getByRole("button",{name:"Start hands-free call",exact:true}).isEnabled(),false);assert.equal(await p.evaluate(()=>window.voiceTest.stats.starts),0);assert.equal(await p.evaluate(()=>window.voiceTest.stats.sends.length),0);
  });
  await scenario("fresh deliberate call after synthesis failure can capture; never automatic",async(p,{open})=>{
    await open();await startAutomatic(p);await p.evaluate(()=>{window.voiceTest.stats.failSpeech=true;window.voiceTest.recognized("Speech error recovery turn");});await p.getByRole("button",{name:"Play reply",exact:true}).waitFor();assert.equal(await p.evaluate(()=>window.voiceTest.stats.starts),1);
    await p.evaluate(()=>{window.voiceTest.stats.failSpeech=false;});await startAutomatic(p);assert.equal(await p.evaluate(()=>window.voiceTest.stats.starts),2);
  });
  await scenario("playback end before onset fails closed; stale end cannot capture; recovery is deliberate",async(p,{open})=>{
    await open();await startAutomatic(p);
    await p.evaluate(()=>{window.voiceTest.stats.hangSpeech=true;window.voiceTest.recognized("Terminal before playback onset");});
    await p.getByText("Loading speech…",{exact:true}).waitFor();
    await p.evaluate(()=>{window.oldSpeech=window.voiceTest.staleSpeech();window.voiceTest.complete();});
    await p.getByRole("alert").filter({hasText:/could not read.*Use Play reply or read the transcript/}).waitFor();
    assert.equal(await p.getByText("Hands-free call active · automatic finalized turns",{exact:true}).count(),0);
    assert.equal(await p.evaluate(()=>window.voiceTest.stats.starts),1);
    assert.equal(await p.evaluate(()=>window.voiceTest.stats.sends.length),1);
    assert.equal((await p.evaluate(()=>window.voiceTest.resources())).recognition,0);
    assert.equal((await p.evaluate(()=>window.voiceTest.resources())).synthesis,0);
    assert.equal((await p.evaluate(()=>window.voiceTest.resources())).timers,0);
    assert.doesNotMatch(await p.getByLabel("Call timing").innerText(),/speech started/);
    await p.evaluate(()=>window.oldSpeech());
    assert.equal(await p.evaluate(()=>window.voiceTest.stats.starts),1);
    assert.equal(await p.evaluate(()=>window.voiceTest.stats.sends.length),1);
    await p.evaluate(()=>{window.voiceTest.stats.hangSpeech=false;});
    await p.getByRole("button",{name:"Play reply",exact:true}).click();
    await p.getByText("Speaking…",{exact:true}).waitFor();
    await p.evaluate(()=>window.voiceTest.complete());
    await p.getByRole("button",{name:"Start hands-free call",exact:true}).waitFor();
    assert.equal(await p.evaluate(()=>window.voiceTest.stats.starts),1,"deliberate replay does not restore automatic consent");
    await startAutomatic(p);assert.equal(await p.evaluate(()=>window.voiceTest.stats.starts),2);
  });
  await scenario("manual Listen preserves typed draft; hands-free never silently sends preexisting draft",async(p,{open,type})=>{
    await open();await type("Existing typed draft");assert.equal(await p.getByRole("button",{name:"Start hands-free call",exact:true}).isEnabled(),false);
    await p.getByRole("button",{name:"Listen",exact:true}).click();await p.evaluate(()=>window.voiceTest.recognized("Additional final words"));
    await p.waitForFunction(draft=>!draft.disabled&&draft.value==="Existing typed draft Additional final words",await p.getByLabel("Your next turn").elementHandle());
    assert.equal(await p.getByLabel("Your next turn").inputValue(),"Existing typed draft Additional final words");assert.equal(await p.evaluate(()=>window.voiceTest.stats.sends.length),0);
  });
  await scenario("burst query wakeups share one nonabortable canonical HTTP read",async(p,{open})=>{
    await open();await startAutomatic(p);await p.evaluate(()=>{window.voiceTest.stats.waiting=true;window.voiceTest.recognized("Read serialization turn");});await p.getByText(/Agent working/).waitFor();
    const before=await p.evaluate(()=>window.voiceTest.stats.reads);await p.evaluate(()=>{window.voiceTest.stats.holdRead=true;void window.voiceTest.wake();});await p.waitForFunction(before=>window.voiceTest.stats.reads>before,before);
    await p.evaluate(()=>{void window.voiceTest.wake();void window.voiceTest.wake();void window.voiceTest.wake();});assert.equal(await p.evaluate(()=>window.voiceTest.stats.reads),before+1);
    await p.evaluate(()=>{window.voiceTest.stats.waiting=false;window.voiceTest.releaseRead();});await p.waitForFunction(()=>window.voiceTest.stats.spoken.length===1);assert.equal(await p.evaluate(()=>window.voiceTest.stats.sends.length),1);
  });
  await scenario("pinned call opening never captures; typed canonical transcript and explicit next Listen",async(p,{open,type,send})=>{
    await open(); assert.equal(await p.evaluate(()=>window.voiceTest.stats.starts),0);
    assert.equal(await p.getByLabel("Call Agent").isEnabled(),false);
    await type("Typed private turn"); await send(); await p.waitForFunction(()=>window.voiceTest.stats.spoken.length===1);
    assert.equal((await p.getByLabel("Call transcript").innerText()).replace(/\n+/g,"\n"),"You\nTyped private turn\nAgent\nYour exact reply.");
    assert.equal(await p.evaluate(()=>window.voiceTest.stats.starts),0);
    await p.getByRole("button",{name:"Stop speaking",exact:true}).click();
    assert.match(await p.getByLabel("Call transcript").innerText(),/Your exact reply/);
    assert.equal(await p.evaluate(()=>window.voiceTest.stats.echoCapture),0);
  });
  await scenario("interim words never send; final review; Finish retains late final words",async(p,{open,send})=>{
    await open(); await p.getByRole("button",{name:"Listen",exact:true}).click();
    await p.evaluate(()=>{window.voiceTest.interim("Interim words");window.voiceTest.stats.finalOnStop=true;});
    assert.equal(await p.getByLabel("Your next turn").inputValue(),"");
    assert.equal(await p.getByRole("button",{name:"Send turn",exact:true}).isEnabled(),false);
    await p.getByRole("button",{name:"Finish turn",exact:true}).click();
    assert.equal(await p.getByLabel("Your next turn").inputValue(),"Final words on finish");
    assert.equal(await p.evaluate(()=>window.voiceTest.stats.sends.length),0); await send();
    await p.waitForFunction(()=>window.voiceTest.stats.spoken.length===1);
    await p.evaluate(()=>window.voiceTest.complete());
    assert.equal(await p.evaluate(()=>window.voiceTest.stats.starts),1);
  });
  await scenario("double Send and lost acknowledgement retry retain exact request and key",async(p,{open,type,send})=>{
    await open();await type("Retry unchanged turn");await p.evaluate(()=>{window.voiceTest.stats.fail=true;window.voiceTest.stats.holdSend=true;});
    await p.getByRole("button",{name:"Send turn",exact:true}).evaluate(b=>{b.click();b.click();});
    await p.waitForFunction(()=>window.voiceTest.stats.sends.length===1);await p.evaluate(()=>window.voiceTest.releaseSend());
    await p.getByRole("button",{name:"Retry same turn",exact:true}).waitFor();await p.evaluate(()=>{window.voiceTest.stats.fail=false;});
    await p.getByRole("button",{name:"Retry same turn",exact:true}).click();await p.waitForFunction(()=>window.voiceTest.stats.sends.length===2);
    const sends=await p.evaluate(()=>window.voiceTest.stats.sends);assert.deepEqual(sends[0],sends[1]);assert.deepEqual(sends[0].recipients,[{agentId:"agent"}]);assert.equal(sends[0].activeRunDelivery,"queue");
  });
  await scenario("End and reopen recovers pending attempt for inspection; no unproven retry",async(p,{open,type,send})=>{
    await open();await type("Reopen pending");await p.evaluate(()=>{window.voiceTest.stats.fail=true;});await send();await p.getByRole("button",{name:"Retry same turn",exact:true}).waitFor();
    await p.getByRole("button",{name:"End call",exact:true}).click();await open();await p.getByRole("alert").filter({hasText:/requires Chat review/}).waitFor();
    assert.equal(await p.getByLabel("Your next turn").inputValue(),"");assert.equal(await p.evaluate(()=>window.voiceTest.stats.sends.length),1);
    assert.equal(await p.getByRole("button",{name:"Send turn",exact:true}).isEnabled(),false);
    await p.getByRole("alert").filter({hasText:/requires Chat review/}).waitFor();
  });
  await scenario("reload refuses restored retry without fresh server identity proof",async(p,{open,type,send})=>{
    await open();await type("Reload pending");await p.evaluate(()=>{window.voiceTest.stats.fail=true;});await send();await p.getByRole("button",{name:"Retry same turn",exact:true}).waitFor();
    await p.reload();await open();await p.getByRole("alert").filter({hasText:/requires Chat review/}).waitFor();
    assert.equal(await p.getByRole("button",{name:"Send turn",exact:true}).isEnabled(),false);assert.equal(await p.evaluate(()=>window.voiceTest.stats.sends.length),0);
  });
  await scenario("late acknowledgement settles record after End but never revives audio",async(p,{open,type,send})=>{
    await open();await type("Late ack");await p.evaluate(()=>{window.voiceTest.stats.holdSend=true;});await send();await p.getByRole("button",{name:"End call",exact:true}).click();
    await p.evaluate(()=>window.voiceTest.releaseSend());await p.waitForTimeout(100);
    assert.equal(await p.evaluate(()=>window.voiceTest.stats.spoken.length),0);await open();await p.getByLabel("Your next turn").waitFor();
    assert.equal(await p.getByLabel("Your next turn").inputValue(),"");assert.equal(await p.getByRole("button",{name:"Retry same turn",exact:true}).count(),0);
  });
  await scenario("Mute immediately fences old callbacks; Unmute never starts capture",async(p,{open})=>{
    await open();await p.getByRole("button",{name:"Listen",exact:true}).click();await p.evaluate(()=>{window.voiceTest.final("Final retained");window.oldResult=window.voiceTest.staleResult();window.oldEnd=window.voiceTest.staleEnd();});
    await p.getByRole("button",{name:"Mute microphone",exact:true}).click();await p.evaluate(()=>{window.oldResult({results:[{isFinal:true,0:{transcript:"Old"}},{isFinal:true,0:{transcript:"Late"}}]});window.oldEnd();});
    assert.equal(await p.getByLabel("Your next turn").inputValue(),"Final retained");assert.equal((await p.evaluate(()=>window.voiceTest.resources())).recognition,0);
    await p.getByRole("button",{name:"Unmute microphone",exact:true}).click();assert.equal(await p.evaluate(()=>window.voiceTest.stats.starts),1);
  });
  for(const boundary of ["End","pagehide","popstate","background","deleteAgent","switchChat"]) await scenario(`late recognition fence on ${boundary}`,async(p,{open})=>{
    await open();await p.getByRole("button",{name:"Listen",exact:true}).click();await p.evaluate(()=>{window.oldResult=window.voiceTest.staleResult();window.oldEnd=window.voiceTest.staleEnd();});
    if(boundary==="End") await p.getByRole("button",{name:"End call",exact:true}).click();
    else await p.evaluate(boundary=>{ if(["deleteAgent","switchChat"].includes(boundary))window.voiceTest[boundary]();else if(boundary==="background"){Object.defineProperty(document,"visibilityState",{value:"hidden",configurable:true});document.dispatchEvent(new Event("visibilitychange"));}else window.dispatchEvent(new Event(boundary));},boundary);
    await p.evaluate(()=>{window.oldResult({results:[{isFinal:true,0:{transcript:"Forbidden late words"}}]});window.oldEnd();});
    assert.equal(await p.evaluate(()=>window.voiceTest.stats.sends.length),0);assert.equal((await p.evaluate(()=>window.voiceTest.resources())).recognition,0);
    assert.ok((await p.getByLabel("Your next turn").evaluateAll(nodes=>nodes.map(node=>node.value))).every(value=>value===""));
  });
  await scenario("competing Read aloud abandons capture; fresh Listen cancels playback",async(p,{open})=>{
    await open();await p.getByRole("button",{name:"Listen",exact:true}).click();await p.evaluate(()=>{window.oldResult=window.voiceTest.staleResult();window.voiceTest.readAloud();});
    assert.equal((await p.evaluate(()=>window.voiceTest.resources())).recognition,0);
    await p.getByRole("button",{name:"Resume call",exact:true}).click();await p.getByRole("button",{name:"Listen",exact:true}).click();
    assert.equal((await p.evaluate(()=>window.voiceTest.resources())).synthesis,0);
    await p.evaluate(()=>window.oldResult({results:[{isFinal:true,0:{transcript:"Old capture"}}]}));assert.equal(await p.getByLabel("Your next turn").inputValue(),"");
  });
  for(const failure of ["not-allowed","network","audio-capture","service-not-allowed","language-not-supported","no-speech","start-timeout","settle-timeout"]) await scenario(`recognition ${failure} remains actionable with typed fallback`,async(p,{open})=>{
    if(failure==="start-timeout")await p.evaluate(()=>{window.voiceTest.stats.hangStart=true;});
    await open();await p.getByRole("button",{name:"Listen",exact:true}).click();
    if(failure==="settle-timeout"){await p.evaluate(()=>{window.voiceTest.stats.hangStop=true;});await p.getByRole("button",{name:"Finish turn",exact:true}).click();}
    else if(failure!=="start-timeout")await p.evaluate(f=>window.voiceTest.failRecognition(f),failure);
    await p.getByText(/Pending speech may not/).waitFor({timeout:5000});assert.equal(await p.getByLabel("Your next turn").isEnabled(),true);assert.equal((await p.evaluate(()=>window.voiceTest.resources())).recognition,0);
  });
  for(const mode of ["noWindow","ambiguous","artifact","wrongReply"]) await scenario(`canonical ${mode} never speaks an unrelated reply`,async(p,{open,type,send})=>{
    await open();await type("Exact turn");await p.evaluate(mode=>{window.voiceTest.stats[mode]=true;window.voiceTest.stats.fastDeadline=true;},mode);await send();
    await p.getByRole("button",{name:"Resume call",exact:true}).waitFor({timeout:5000});assert.equal(await p.evaluate(()=>window.voiceTest.stats.spoken.length),0);
  });
  await scenario("queued/waiting timeout and late read after End do not cancel work or speak",async(p,{open,type,send})=>{
    await open();await type("Long work");await p.evaluate(()=>{window.voiceTest.stats.waiting=true;window.voiceTest.stats.fastDeadline=true;});await send();
    await p.getByText(/still working after 120 seconds/).waitFor();assert.equal(await p.evaluate(()=>window.voiceTest.stats.sends.length),1);
    await p.getByRole("button",{name:"End call",exact:true}).click();await open();await type("Late read");await p.evaluate(()=>{window.voiceTest.stats.waiting=false;window.voiceTest.stats.fastDeadline=false;window.voiceTest.stats.holdRead=true;});await send();
    await p.getByRole("button",{name:"End call",exact:true}).click();await p.evaluate(()=>window.voiceTest.releaseRead());await p.waitForTimeout(100);assert.equal(await p.evaluate(()=>window.voiceTest.stats.spoken.length),0);
  });
  for(const flag of ["hangSpeech","failSpeech"]) await scenario(`speech ${flag} retains transcript and offers Play reply`,async(p,{open,type,send})=>{
    await open();await type("Playback failure");await p.evaluate(flag=>{window.voiceTest.stats[flag]=true;},flag);await send();
    if(flag==="hangSpeech")await p.getByText("Loading speech…",{exact:true}).waitFor();
    await p.getByRole("button",{name:"Play reply",exact:true}).waitFor({timeout:5000});assert.match(await p.getByLabel("Call transcript").innerText(),/Your exact reply/);assert.equal(await p.evaluate(()=>window.voiceTest.stats.starts),0);
  });
  for(const mode of ["noSTT","noTTS","insecure"]) await scenario(`${mode} permits typed canonical task`,async(p,{open,type,send})=>{
    await p.evaluate(mode=>window.voiceTest[mode](),mode);await open();await type("Typed fallback");await send();
    await p.getByLabel("Call transcript").getByText("Your exact reply.",{exact:true}).waitFor();assert.equal(await p.evaluate(()=>window.voiceTest.stats.starts),0);
    if(mode==="noTTS")assert.equal(await p.evaluate(()=>window.voiceTest.stats.spoken.length),0);
  });
  await scenario("storage denial warns honestly and same-page retry remains exact",async(p,{open,type,send})=>{
    await open();await type("Denied storage");await p.evaluate(()=>{window.voiceTest.stats.storageDenied=true;window.voiceTest.stats.fail=true;});await send();
    await p.getByText(/reload recovery cannot be guaranteed/).waitFor();await p.evaluate(()=>{window.voiceTest.stats.fail=false;});await p.getByRole("button",{name:"Retry same turn",exact:true}).click();
    await p.waitForFunction(()=>window.voiceTest.stats.sends.length===2);const sends=await p.evaluate(()=>window.voiceTest.stats.sends);assert.deepEqual(sends[0],sends[1]);
  });
  await scenario("ordinary dictation still gracefully finishes without sending",async(p)=>{
    await p.getByRole("button",{name:"Voice input",exact:true}).click();await p.getByRole("menuitem",{name:"Dictate",exact:true}).click();await p.evaluate(()=>{window.voiceTest.stats.finalOnStop=true;});await p.getByRole("button",{name:"Stop voice dictation",exact:true}).click();
    assert.equal(await p.locator("#draft").textContent(),"Final words on finish");assert.equal(await p.evaluate(()=>window.voiceTest.stats.sends.length),0);
  });
  await scenario("transcript retains only ten canonical turns",async(p,{open,type,send})=>{
    await open();
    for(let i=0;i<11;i++){await type(`Turn ${i}`);await send();await p.getByRole("button",{name:"Stop speaking",exact:true}).waitFor();await p.evaluate(()=>window.voiceTest.complete());}
    const transcript=await p.getByLabel("Call transcript").innerText();assert.ok(!transcript.includes("Turn 0"));assert.ok(transcript.includes("Turn 10"));assert.equal(await p.getByLabel("Call transcript").getByText("Your exact reply.",{exact:true}).count(),10);
  });
  await scenario("late synthesis completion after End cannot start listening or revive a call",async(p,{open,type,send})=>{
    await open();await type("Speak once");await send();await p.getByRole("button",{name:"Stop speaking",exact:true}).waitFor();await p.evaluate(()=>{window.oldSpeech=window.voiceTest.staleSpeech();});await p.getByRole("button",{name:"End call",exact:true}).click();await p.evaluate(()=>window.oldSpeech());assert.equal(await p.getByRole("dialog").count(),0);assert.equal(await p.evaluate(()=>window.voiceTest.stats.starts),0);
  });
  await scenario("changed server hint blocks mounted retry without replacing its key",async(p,{open,type,send})=>{
    await open();await type("Server change");await p.evaluate(()=>{window.voiceTest.stats.fail=true;});await send();await p.getByRole("button",{name:"Retry same turn",exact:true}).waitFor();await p.evaluate(()=>{window.sessionStorage.setItem("ponderosa.workspace.instance.v1","foreign-server");});await p.getByRole("button",{name:"Retry same turn",exact:true}).click();await p.getByText(/Server identity changed/).waitFor();assert.equal(await p.evaluate(()=>window.voiceTest.stats.sends.length),1);
  });
  await scenario("expired marker persists without words and repeated reopen still requires Chat review",async(p,{open,type,send})=>{
    await open();await type("Expire");await p.evaluate(()=>{window.voiceTest.stats.fail=true;});await send();await p.getByRole("button",{name:"Retry same turn",exact:true}).waitFor();await p.getByRole("button",{name:"End call",exact:true}).click();
    await p.evaluate(()=>{const key=Object.keys(sessionStorage).find(k=>k.startsWith("ponderosa.voice.pending"));const record=JSON.parse(sessionStorage.getItem(key));record.createdAt=Date.now()-86400000;sessionStorage.setItem(key,JSON.stringify(record));});await open();await p.getByText(/expired after 24 hours/).waitFor();assert.equal(await p.getByRole("button",{name:"Send turn",exact:true}).isEnabled(),false);assert.equal(await p.evaluate(()=>Object.keys(sessionStorage).some(k=>k.startsWith("ponderosa.voice.pending"))),true);await p.getByRole("button",{name:"End call",exact:true}).click();await open();await p.getByText(/expired after 24 hours/).waitFor();assert.equal(await p.getByRole("button",{name:"Send turn",exact:true}).isEnabled(),false);
  });
  async function noStoredWords(page, words) {
    const stored=await page.evaluate(()=>[...Object.values(sessionStorage),...Object.values(localStorage)]);
    assert.ok(stored.every(value=>!value.includes(words)),"real browser storage contains no private words");
    for(const raw of await page.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith("ponderosa.voice.pending")).map(k=>sessionStorage.getItem(k)))) {
      const marker=JSON.parse(raw);assert.equal(marker.request,undefined);assert.equal(marker.text,undefined);assert.equal(marker.recipients,undefined);
    }
  }
  await scenario("Option B rendered disclosure; failed send, End, reopen and reload persist no private words",async(p,{open,type,send})=>{
    const words="SYNTHETIC PRIVATE FULL REQUEST FOR OPTION B";
    await open();await p.getByText(/full private words only in this mounted call/).waitFor();await type(words);await p.evaluate(()=>{window.voiceTest.stats.fail=true;});await send();
    await p.getByRole("button",{name:"Retry same turn",exact:true}).waitFor();await noStoredWords(p,words);
    assert.equal(await p.getByLabel("Your next turn").inputValue(),words); // Deliberate mounted review; never persisted.
    await p.getByRole("button",{name:"End call",exact:true}).click();await noStoredWords(p,words);await open();await p.getByRole("alert").filter({hasText:/requires Chat review/}).waitFor();
    assert.equal(await p.getByLabel("Your next turn").inputValue(),"");assert.equal(await p.getByRole("button",{name:"Send turn",exact:true}).isEnabled(),false);await noStoredWords(p,words);
    await p.reload();await open();await p.getByRole("alert").filter({hasText:/requires Chat review/}).waitFor();assert.equal(await p.getByLabel("Your next turn").inputValue(),"");await noStoredWords(p,words);assert.equal(await p.evaluate(()=>window.voiceTest.stats.starts),0);
  });
  await scenario("unmount/remount drops private retry draft and blocks replacement even under storage denial",async(p,{open,type,send})=>{
    const words="SYNTHETIC PRIVATE UNMOUNTED PAYLOAD";await open();await type(words);await p.evaluate(()=>{window.voiceTest.stats.fail=true;window.voiceTest.stats.storageDenied=true;});await send();
    await p.getByRole("button",{name:"Retry same turn",exact:true}).waitFor();assert.equal((await p.evaluate(()=>window.voiceTest.fallbackMarker())).includes(words),false);
    await p.evaluate(()=>window.voiceTest.unmount());await p.evaluate(()=>window.voiceTest.remount());await open();await p.getByRole("alert").filter({hasText:/requires Chat review/}).waitFor();
    assert.equal(await p.getByLabel("Your next turn").inputValue(),"");assert.equal(await p.getByRole("button",{name:"Send turn",exact:true}).isEnabled(),false);
    await p.evaluate(()=>{window.voiceTest.stats.storageDenied=false;});await noStoredWords(p,words);
  });
  for(const mode of ["valid","expired","future","corrupt","oversized"])await scenario(`legacy ${mode} inspection removes private bytes and never restores payload`,async(p,{open})=>{
    const words="SYNTHETIC PRIVATE LEGACY PAYLOAD";await p.evaluate(async({words,mode})=>{
      await window.voiceTest.seedLegacy(words,mode==="expired"?{createdAt:Date.now()-86400000}:mode==="future"?{createdAt:Date.now()+86400000}:{});
      const key=Object.keys(sessionStorage).find(k=>k.startsWith("ponderosa.voice.pending"));
      if(mode==="corrupt")sessionStorage.setItem(key,"{broken "+words);if(mode==="oversized")sessionStorage.setItem(key,words.repeat(5000));
    },{words,mode});
    await open();await p.getByRole("alert").filter({hasText:/requires Chat review|expired after 24 hours/}).waitFor();await noStoredWords(p,words);assert.equal(await p.getByLabel("Your next turn").inputValue(),"");assert.equal(await p.getByRole("button",{name:"Send turn",exact:true}).isEnabled(),false);
    await p.getByRole("button",{name:"End call",exact:true}).click();await open();await p.getByRole("alert").filter({hasText:/requires Chat review|expired after 24 hours/}).waitFor();assert.equal(await p.getByRole("button",{name:"Send turn",exact:true}).isEnabled(),false);await noStoredWords(p,words);
  });
  for(const status of [400,404,409,413])await scenario(`definitive ${status} denies mounted retry without fresh key`,async(p,{open,type,send})=>{
    await open();await type("Synthetic denied request");await p.evaluate(status=>{window.voiceTest.stats.fail=true;window.voiceTest.stats.failureStatus=status;},status);await send();await p.getByText(/Could not confirm this turn/).waitFor();
    assert.equal(await p.getByRole("button",{name:"Retry same turn",exact:true}).isEnabled(),false);assert.equal(await p.evaluate(()=>window.voiceTest.stats.sends.length),1);await noStoredWords(p,"Synthetic denied request");
  });
  await scenario("mounted expiry refuses deliberate retry while keeping text-free unknown marker",async(p,{open,type,send})=>{
    await open();await type("Synthetic mounted expiry");await p.evaluate(()=>{window.voiceTest.stats.fail=true;});await send();await p.getByRole("button",{name:"Retry same turn",exact:true}).waitFor();
    await p.evaluate(()=>{const now=Date.now();Date.now=()=>now+86400001;});await p.getByRole("button",{name:"Retry same turn",exact:true}).click();await p.getByText(/unconfirmed turn expired/).waitFor();assert.equal(await p.getByRole("button",{name:"Send turn",exact:true}).isEnabled(),false);assert.equal(await p.evaluate(()=>window.voiceTest.stats.sends.length),1);await noStoredWords(p,"Synthetic mounted expiry");
  });
  await scenario("late acknowledgement after unmount settles marker without audio resurrection",async(p,{open,type,send})=>{
    await open();await type("Synthetic inert late acknowledgement");await p.evaluate(()=>{window.voiceTest.stats.holdSend=true;});await send();await p.waitForFunction(()=>window.voiceTest.stats.sends.length===1);await p.evaluate(()=>window.voiceTest.unmount());await noStoredWords(p,"Synthetic inert late acknowledgement");
    await p.evaluate(()=>window.voiceTest.releaseSend());await p.waitForFunction(()=>!Object.keys(sessionStorage).some(k=>k.startsWith("ponderosa.voice.pending")));assert.equal(await p.evaluate(()=>window.voiceTest.stats.spoken.length),0);assert.equal(await p.evaluate(()=>window.voiceTest.stats.starts),0);
  });
  await scenario("late acknowledgement cannot delete a replacement marker",async(p,{open,type,send})=>{
    await open();await type("Synthetic original attempt");await p.evaluate(()=>{window.voiceTest.stats.holdSend=true;});await send();await p.waitForFunction(()=>window.voiceTest.stats.sends.length===1);await p.getByRole("button",{name:"End call",exact:true}).click();
    await p.evaluate(()=>{const key=Object.keys(sessionStorage).find(k=>k.startsWith("ponderosa.voice.pending"));const marker=JSON.parse(sessionStorage.getItem(key));marker.idempotencyKey="replacement-key";sessionStorage.setItem(key,JSON.stringify(marker));window.voiceTest.releaseSend();});
    await p.waitForTimeout(100);assert.equal(await p.evaluate(()=>{const key=Object.keys(sessionStorage).find(k=>k.startsWith("ponderosa.voice.pending"));return JSON.parse(sessionStorage.getItem(key)).idempotencyKey;}),"replacement-key");assert.equal(await p.evaluate(()=>window.voiceTest.stats.spoken.length),0);await noStoredWords(p,"Synthetic original attempt");
  });
  await scenario("changed stored key denies mounted retry without replacing or sending",async(p,{open,type,send})=>{
    await open();await type("Synthetic stored-key collision");await p.evaluate(()=>{window.voiceTest.stats.fail=true;});await send();await p.getByRole("button",{name:"Retry same turn",exact:true}).waitFor();
    await p.evaluate(()=>{const key=Object.keys(sessionStorage).find(k=>k.startsWith("ponderosa.voice.pending"));const marker=JSON.parse(sessionStorage.getItem(key));marker.idempotencyKey="other-key";sessionStorage.setItem(key,JSON.stringify(marker));});
    await p.getByRole("button",{name:"Retry same turn",exact:true}).click();await p.getByText(/retry identity could not be confirmed/).waitFor();assert.equal(await p.evaluate(()=>window.voiceTest.stats.sends.length),1);assert.equal(await p.getByRole("button",{name:"Send turn",exact:true}).isEnabled(),false);await noStoredWords(p,"Synthetic stored-key collision");
  });
  await scenario("marker created after initial inspection blocks a new send before key preparation",async(p,{open,type,send})=>{
    await open();await type("Synthetic unsent replacement");await p.evaluate(()=>window.voiceTest.seedLegacy("Synthetic existing legacy turn"));await send();await p.getByRole("alert").filter({hasText:/requires Chat review/}).waitFor();
    assert.equal(await p.evaluate(()=>window.voiceTest.stats.sends.length),0);assert.equal(await p.getByLabel("Your next turn").inputValue(),"");await noStoredWords(p,"Synthetic existing legacy turn");await noStoredWords(p,"Synthetic unsent replacement");
  });
  console.log(`PASS ${cases} synthetic call cases. Qualified physical devices: NONE.`);

} finally {
  await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve());
  console.log("OWN HTTP LISTENER CLOSED", server?.listening === false);
  if (output) await rm(output, { recursive: true, force: true });
  console.log("RELEASED ROOT", output);
}

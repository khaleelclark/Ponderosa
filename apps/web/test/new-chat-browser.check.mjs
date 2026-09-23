import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { pluginReact } from "@rsbuild/plugin-react";
import { createRsbuild } from "@rsbuild/core";
const root=fileURLToPath(new URL("..",import.meta.url));
const output=await mkdtemp(path.join(tmpdir(),"new-chat-browser-"));
const {chromium}=await import(process.env.PONDEROSA_PLAYWRIGHT_PATH??"playwright");
let browser,server;
try {
  const build=await createRsbuild({cwd:root,rsbuildConfig:{plugins:[pluginReact()],source:{transformImport:[],entry:{index:path.join(root,"test/new-chat-browser-entry.tsx")}},output:{distPath:{root:output}},logLevel:"error"}});
  await build.build();
  server=createServer(async(req,res)=>{try{const pathname=new URL(req.url,"http://localhost").pathname;const file=path.join(output,!path.extname(pathname)?"index.html":pathname);res.setHeader("Content-Type",file.endsWith(".js")?"text/javascript":file.endsWith(".css")?"text/css":"text/html");res.end(await readFile(file));}catch{res.writeHead(404).end();}}).listen(0,"127.0.0.1");
  await new Promise(resolve=>server.once("listening",resolve));
  browser=await chromium.launch({headless:true,executablePath:process.env.PONDEROSA_CHROMIUM_PATH});
  for(const width of [1440,390]) {
    const page=await browser.newPage({viewport:{width,height:900}});
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByText("What would you like to work on?").waitFor();
    assert.equal(await page.evaluate(()=>window.calls.length),0,"Opening composer persists nothing");
    const editor=page.locator('[contenteditable="true"]');
    await editor.fill("Keep this exact first message");
    await page.getByRole("button",{name:"Send message",exact:true}).click();
    await page.getByText("Simulated lost response; retry safely",{exact:false}).first().waitFor();
    assert.match(await editor.innerText(),/Keep this exact first message/);
    await page.getByRole("button",{name:"Send message",exact:true}).click();
    await page.waitForFunction(()=>document.body.dataset.created==="true");
    const calls=await page.evaluate(()=>window.calls);
    assert.equal(calls.filter(c=>c.kind==="chat").length,1);
    const attempts=calls.filter(c=>c.kind==="agent");
    assert.equal(attempts.length,2);
    assert.equal(attempts[0].options.idempotencyKey,attempts[1].options.idempotencyKey);
    assert.equal(await page.evaluate(()=>sessionStorage.getItem("ponderosa.new-chat-attempt.v1")),null);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.close();
  }
  console.log("PASS unsaved composer, retained draft and idempotent first-Send retry at desktop/mobile widths");
} finally {await browser?.close();server?.close();await rm(output,{recursive:true,force:true});}

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { pluginReact } from "@rsbuild/plugin-react";
import { createRsbuild } from "@rsbuild/core";
const root=fileURLToPath(new URL("..",import.meta.url));
const output=await mkdtemp(path.join(tmpdir(),"chat-first-browser-"));
const {chromium}=await import(process.env.PONDEROSA_PLAYWRIGHT_PATH??"playwright");
let browser,server;
try {
  const build=await createRsbuild({cwd:root,rsbuildConfig:{plugins:[pluginReact()],source:{transformImport:[],entry:{index:path.join(root,"test/landing-browser-entry.tsx")}},output:{distPath:{root:output}},logLevel:"error"}});
  await build.build();
  server=createServer(async(req,res)=>{try{const pathname=new URL(req.url,"http://localhost").pathname;const file=path.join(output,!path.extname(pathname)?"index.html":pathname);res.setHeader("Content-Type",file.endsWith(".js")?"text/javascript":file.endsWith(".css")?"text/css":"text/html");res.end(await readFile(file));}catch{res.writeHead(404).end();}}).listen(0,"127.0.0.1");
  await new Promise(resolve=>server.once("listening",resolve));
  browser=await chromium.launch({headless:true,executablePath:process.env.PONDEROSA_CHROMIUM_PATH});


  const page=await browser.newPage();
  const origin=`http://127.0.0.1:${server.address().port}`;
  await page.goto(origin);
  await page.waitForFunction(()=>document.querySelector("#route")?.textContent.includes('"kind":"create"'));
  await page.goto(origin+"/projects/old-project?view=settings");
  await page.waitForURL("**/home");
  assert.equal(JSON.parse(await page.locator("#route").innerText()).kind,"home");
  await page.getByRole("button",{name:"Home",exact:true}).click();
  await page.waitForURL("**/home");
  await page.goto(origin);
  await page.waitForURL("**/home");
  await page.goto(origin+"/projects/p/chats/c");
  await page.waitForFunction(()=>document.querySelector("#route")?.textContent.includes("conversation"));
  await page.getByRole("button",{name:"Logo",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector("#route")?.textContent.includes('"kind":"create"'));
  await page.goBack();
  await page.waitForURL("**/projects/p/chats/c");
  assert.equal(JSON.parse(await page.locator("#route").innerText()).kind,"conversation");
  await page.close();
  console.log("PASS launch: unsaved Chat default, restored workspace, direct link precedence, logo and browser Back");
}finally{await browser?.close();server?.close();await rm(output,{recursive:true,force:true});}

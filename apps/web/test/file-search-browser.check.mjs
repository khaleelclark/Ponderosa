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
  const build=await createRsbuild({cwd:root,rsbuildConfig:{plugins:[pluginReact()],source:{transformImport:[],entry:{index:path.join(root,"test/file-search-browser-entry.tsx")}},output:{distPath:{root:output}},logLevel:"error"}});
  await build.build();
  server=createServer(async(req,res)=>{try{const pathname=new URL(req.url,"http://localhost").pathname;const file=path.join(output,pathname==="/"?"index.html":pathname);res.setHeader("Content-Type",file.endsWith(".js")?"text/javascript":file.endsWith(".css")?"text/css":"text/html");res.end(await readFile(file));}catch{res.writeHead(404).end();}}).listen(0,"127.0.0.1");
  await new Promise(resolve=>server.once("listening",resolve));
  browser=await chromium.launch({headless:true,executablePath:process.env.PONDEROSA_CHROMIUM_PATH});

  for(const width of [1440,390]){
    const page=await browser.newPage({viewport:{width,height:900}});
    const errors=[];page.on("pageerror",e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    assert.equal(await page.getByRole("button",{name:/Projects/}).count(),0);
    await page.getByRole("button",{name:"Files",exact:true}).click();
    await page.getByRole("group",{name:"Recent files",exact:true}).waitFor();
    await page.getByRole("option",{name:"Open file report.txt in Workspace",exact:true}).waitFor();
    const input=page.getByRole("combobox",{name:"Search Ponderosa"});
    await input.fill("report");
    await page.getByRole("option",{name:"Open file report.txt in Workspace",exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:`/tmp/file-search-${width}.png`});
    await input.press("ArrowDown");await input.press("Enter");
    assert.deepEqual(JSON.parse(await page.locator("#selected-route").innerText()),{kind:"workspaceFile",projectId:"p",path:"docs/report.txt"});
    await page.getByRole("button",{name:"Open search",exact:true}).click();
    await page.getByRole("button",{name:"All",exact:true}).click();
    await page.getByRole("option",{name:"Open file report.txt in Workspace",exact:true}).waitFor();
    await page.getByRole("button",{name:"Chats",exact:true}).click();
    assert.equal(await page.getByRole("option",{name:"Open file report.txt in Workspace",exact:true}).count(),0);
    assert.deepEqual(errors,[]);
    await page.close();console.log(`PASS ${width}: Files and All, scope isolation, keyboard file navigation, no Projects or overflow`);
  }
}finally{await browser?.close();server?.close();await rm(output,{recursive:true,force:true});}

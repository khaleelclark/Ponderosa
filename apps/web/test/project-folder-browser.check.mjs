import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { pluginReact } from "@rsbuild/plugin-react";
import { createRsbuild } from "@rsbuild/core";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "ponderosa-table-browser-"));
const { chromium } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH ?? "playwright");
let browser, server;
try {
  const build = await createRsbuild({ cwd: root, rsbuildConfig: {
    plugins: [pluginReact()], source: { transformImport: [], entry: { index: path.join(root, "test/project-folder-browser-entry.tsx") } },
    output: { distPath: { root: output } }, logLevel: "error",
  } });
  await build.build();
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    try {
      const file = path.join(output, pathname === "/" ? "index.html" : pathname);
      response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  browser = await chromium.launch({ headless: true, executablePath: process.env.PONDEROSA_CHROMIUM_PATH });
  const page = await browser.newPage();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const button = name => page.getByRole("button", { name, exact: true });
    const folders = async () => JSON.parse(await page.locator("#folders").innerText());
    await button("Alpha").waitFor();
    for (const [label, result] of [["Rename Project", "rename:Alpha"], ["Project Settings", "settings:Alpha"], ["Delete Project", "delete:Alpha"]]) {
      if (width === 390) await button("Project actions for Alpha").click();
      else await button("Alpha").click({ button: "right" });
      await page.getByRole("menuitem", { name: label, exact: true }).click();
      assert.equal(await page.locator("#action").innerText(), result);
    }
    const drag = async (source, destination, ratio=.5) => {
      const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
      await source.dispatchEvent("dragstart", { dataTransfer });
      const rect = await destination.boundingBox();
      await destination.dispatchEvent("dragover", { dataTransfer, clientY: rect.y + rect.height * ratio });
      await destination.dispatchEvent("drop", { dataTransfer, clientY: rect.y + rect.height * ratio });
      await page.waitForTimeout(30);
    };
    await drag(button("Alpha"),button("Beta"),.05);
    assert.equal((await folders()).length,0,"Edge drop reorders instead of grouping");
    assert.equal(await page.locator("#action").innerText(),"reorder:Alpha:Beta:before");
    await drag(button("Alpha"),button("Beta"));
    assert.deepEqual((await folders())[0].projectIds,["Beta","Alpha"]);
    const folderButton = button("Folder Project folder");
    await folderButton.click();
    assert.equal(await button("Alpha").count(),0);
    await page.screenshot({path:path.join(tmpdir(),`project-folder-collapsed-${width}.png`)});
    await drag(button("Gamma"),folderButton);
    assert.deepEqual((await folders())[0].projectIds,["Beta","Alpha","Gamma"]);
    await folderButton.click();
    assert.equal((await button("Alpha").boundingBox()).height,48);
    await page.screenshot({path:path.join(tmpdir(),`project-folder-expanded-${width}.png`)});
    await button("Alpha").click({button:"right"});
    await page.getByRole("menuitem",{name:"Remove from Folder",exact:true}).click();
    assert.deepEqual((await folders())[0].projectIds,["Beta","Gamma"]);
    await folderButton.click({button:"right"});
    await page.getByRole("menuitem",{name:"Rename Folder",exact:true}).click();
    await page.getByRole("textbox").fill("Work");
    await page.getByRole("dialog").getByRole("button",{name:"Rename",exact:true}).click();
    assert.equal((await folders())[0].name,"Work");
    await button("Folder Work").click({button:"right"});
    await page.getByRole("menuitem",{name:"Ungroup Projects",exact:true}).click();
    assert.deepEqual(await folders(),[]);
    for(const name of ["Alpha","Beta","Gamma"])await button(name).waitFor();
    await drag(button("Alpha"),button("Gamma"));
    const order=await page.locator("#order").innerText();
    const top=await button("Folder Project folder").boundingBox();
    await drag(button("Alpha"),button("Gamma"),.05);
    assert.equal(await page.locator("#order").innerText(),order,"Member order must not change global order");
    assert.equal((await button("Folder Project folder").boundingBox()).y,top.y,"Folder must not jump");
    const sourceId=(await folders())[0].id;
    await button("Alpha").click({button:"right"});
    await page.getByRole("menuitem",{name:"Remove from Folder",exact:true}).click();
    await drag(button("Beta"),button("Delta"));
    const destinationId=(await folders()).find(f=>f.id!==sourceId).id;
    await drag(button("Gamma"),button("Delta"));
    assert.deepEqual((await folders()).find(f=>f.id===sourceId).projectIds,[],"Last-member move must retain empty source intent for conflict rebasing");
    assert.deepEqual((await folders()).find(f=>f.id===destinationId).projectIds,["Delta","Beta","Gamma"]);
    console.log({width,grouping:true,edgeReorder:true,contextActions:true,ungroupPreservesProjects:true});
  }
  await page.goto(`http://127.0.0.1:${server.address().port}/?pagination`);
  await page.waitForFunction(()=>document.getElementById("loaded")?.textContent==="26");
  const later=page.getByRole("button",{name:"Project 26",exact:true});
  assert.equal(await later.getByRole("img").count(),1,"Later-page project activity must be present");
  const folder=page.getByRole("button",{name:"Folder Later",exact:true});await folder.click();
  assert.equal(await folder.getByRole("img").count(),1,"Collapsed folder aggregates later-page activity");
  await page.getByRole("button",{name:"Complete work",exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('[aria-label="Folder Later"] [role="img"]'));
  console.log("PASS 26-project pagination, collapsed aggregation and completion refresh");
} finally {
  await browser?.close(); server?.close(); await rm(output, { recursive: true, force: true });
}

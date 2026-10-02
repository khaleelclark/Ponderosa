import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRsbuild } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "ponderosa-ux-check-"));
const { chromium } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH ?? "playwright");
let browser;
let server;
try {
  const build = await createRsbuild({ cwd: root, rsbuildConfig: {
    plugins: [pluginReact()], source: { entry: { index: path.join(root, "test/notification-menu-ux-entry.tsx") } },
    output: { distPath: { root: output } }, logLevel: "error",
  } });
  await build.build();
  server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://localhost").pathname;
      const file = path.join(output, pathname === "/" ? "index.html" : pathname);
      response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  browser = await chromium.launch({ headless: true, executablePath: process.env.PONDEROSA_CHROMIUM_PATH,
    args: process.env.PONDEROSA_BROWSER_DISABLE_SANDBOX === "1" ? ["--no-sandbox"] : [] });
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.getByRole("button", { name: "Chat settings and actions" }).click();
    const rows = page.getByRole("menuitem");
    await rows.first().waitFor();
    await page.waitForTimeout(250);
    for (let index = 0; index < await rows.count(); index += 1) {
      const bounds = await rows.nth(index).boundingBox();
      const style = await rows.nth(index).evaluate(element => ({ minHeight: getComputedStyle(element).minHeight, className: element.className, innerWidth }));
      assert.ok(bounds && bounds.height >= (width === 390 ? 44 : 36), `menu row ${index} has ${bounds?.height}px target at ${width}px; ${JSON.stringify(style)}`);
    }
    await page.keyboard.press("Escape");
    for (const [label, name, mimeType] of [
      ["Photos", "photo.jpg", "image/jpeg"],
      ["Photos", "photo.jpg", "image/jpeg"],
      ["Files", "report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ]) {
      await page.getByRole("button", { name: "Open capability picker" }).click();
      const choosing = page.waitForEvent("filechooser");
      await page.getByRole("menuitem", { name: new RegExp(`^${label}\\b`) }).click();
      const chooser = await choosing;
      assert.equal(chooser.isMultiple(), true);
      assert.equal(await chooser.element().getAttribute("capture"), null, "photo selection must not force camera capture");
      const accepted = await chooser.element().getAttribute("accept");
      if (label === "Photos") assert.equal(accepted, "image/*", "Photos uses an image-only native picker hint");
      else assert.ok(accepted.includes(".docx") && accepted.includes("application/pdf"), "Files retains supported documents");
      await chooser.setFiles({ name, mimeType, buffer: Buffer.from("disposable picker fixture") });
      assert.equal(await chooser.element().inputValue(), "", "selection resets so the same file can be chosen again");
      assert.equal(await page.getByRole("menu").count(), 0, "choosing closes the action menu");
    }
    assert.equal(await page.locator("[data-selected-files]").innerText(), "photo.jpg,photo.jpg,report.docx",
      "both picker paths deliver to the same attachment callback, including reselection");
    await page.getByRole("button", { name: "Open capability picker" }).click();
    const cancelling = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: /^Photos\b/ }).click();
    await (await cancelling).setFiles([]);
    assert.equal(await page.locator("[data-selected-files]").innerText(), "photo.jpg,photo.jpg,report.docx", "cancelling preserves selected attachments");
    await page.getByRole("button", { name: "Open capability picker" }).click();
    if (width === 390) await page.getByRole("menuitem", { name: "Skills & connectors" }).click();
    await page.getByText("Available skills", { exact: true }).waitFor();
    await page.getByText("Google Docs", { exact: true }).waitFor();
    await page.getByText("Connected apps", { exact: true }).waitFor();
    await page.getByText("Unavailable options", { exact: true }).waitFor();
    assert.equal(await page.getByText("google-drive:google-docs", { exact: true }).count(), 0,
      "technical skill identifier is not the visible option label");
    for (const mode of ["disabled", "full"]) {
      await page.goto(`http://127.0.0.1:${server.address().port}/?attachments=${mode}`);
      await page.getByRole("button", { name: "Open capability picker" }).click();
      for (const label of ["Photos", "Files"]) {
        assert.equal(await page.getByRole("menuitem", { name: new RegExp(`^${label}\\b`) }).getAttribute("aria-disabled"), "true",
          `${label} respects ${mode} attachment admission`);
      }
    }
    await page.close();
  }
  console.log("Separate Photos/Files picker paths, reselection, cancellation and admission checks passed at 390px and 1280px");
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(output, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pluginReact } from "@rsbuild/plugin-react";
import { createRsbuild } from "@rsbuild/core";

const { chromium } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
const web = fileURLToPath(new URL("..", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "workspace-sidebar-chrome-"));
const output = path.join(temporary, "web");
let browser;
let server;

try {
  const build = await createRsbuild({
    cwd: web,
    rsbuildConfig: {
      plugins: [pluginReact()],
      source: { entry: { index: path.join(web, "test/workspace-sidebar-chrome-entry.tsx") } },
      output: { distPath: { root: output } },
      logLevel: "error",
    },
  });
  await build.build();
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const file = path.resolve(output, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(output + "/")) { response.writeHead(404).end(); return; }
    try {
      const content = await readFile(file);
      response.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html" }).end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ headless: true, executablePath: process.env.PONDEROSA_CHROMIUM_PATH, args: ["--no-sandbox"] });
  for (const width of [320, 390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 720 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/${width < 768 ? "?drawer" : ""}`);
    const header = page.locator("[data-workspace-sidebar-header]");
    const sections = page.locator("[data-workspace-sidebar-sections]");
    const profile = page.locator("[data-workspace-sidebar-profile]");
    await header.waitFor();
    const metrics = await page.evaluate(() => {
      const header = document.querySelector("[data-workspace-sidebar-header]");
      const sections = document.querySelector("[data-workspace-sidebar-sections]");
      const profile = document.querySelector("[data-workspace-sidebar-profile]");
      const messagesButton = document.querySelector('button[aria-label^="Messages across Ponderosa"]');
      const sectionButtons = [...sections.querySelectorAll("button")]
        .filter(button => button !== messagesButton)
        .map(button => button.getBoundingClientRect());
      const messagesBox = messagesButton.getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth > innerWidth,
        headerRight: header.getBoundingClientRect().right,
        sidebarRight: header.closest("aside").getBoundingClientRect().right,
        sectionRows: new Set(sectionButtons.map(box => Math.round(box.top))).size,
        messagesInHeader: header.contains(messagesButton),
        messagesInSections: sections.contains(messagesButton),
        messagesAboveSections: !sections.contains(messagesButton) || messagesBox.bottom <= Math.min(...sectionButtons.map(box => box.top)),
        profileBottom: Math.round(profile.getBoundingClientRect().bottom),
      };
    });
    assert.equal(metrics.overflow, false, `${width}: no horizontal document overflow`);
    assert.ok(metrics.headerRight <= metrics.sidebarRight, `${width}: header controls fit the sidebar`);
    assert.equal(metrics.sectionRows, 1, `${width}: section buttons remain on one row`);
    assert.equal(metrics.messagesAboveSections, true, `${width}: global Messages sits above the section tabs`);
    assert.equal(metrics.messagesInHeader, width < 768, `${width}: mobile places Messages beside the Ponderosa logo`);
    assert.equal(metrics.messagesInSections, width >= 768, `${width}: desktop keeps the labeled Messages row`);
    assert.equal(metrics.profileBottom, 720, `${width}: profile remains pinned to the bottom`);
    assert.equal(await page.getByRole("button", { name: "Search", exact: true }).count(), 1, `${width}: Search moved to the header`);
    assert.equal(await page.getByRole("button", { name: /Notifications/ }).count(), 1, `${width}: Notifications moved to the header`);
    assert.equal(await page.getByRole("button", { name: /Notifications/ }).locator(".MuiBadge-badge").evaluate(node => getComputedStyle(node).backgroundColor), "rgb(214, 106, 92)", `${width}: action count uses the red badge`);
    assert.equal(await page.getByRole("button", { name: "Settings", exact: true }).count(), 0, `${width}: Settings is no longer a standalone sidebar button`);
    assert.equal(await page.getByText("Ponderosa", { exact: true }).count(), width < 768 ? 0 : 1, `${width}: brand text appears only when the header has room`);
    await page.getByRole("button", { name: "Home", exact: true }).click();
    assert.equal(await page.locator("#action").innerText(), "home", `${width}: Ponderosa brand opens Home`);
    await page.getByRole("button", { name: "Messages across Ponderosa", exact: true }).click();
    assert.equal(await page.locator("#action").innerText(), "all-messages", `${width}: dedicated Messages row opens the combined feed`);
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Create Agent", exact: true }).count(), 1, `${width}: create action follows the active section at the top`);
    await page.getByRole("button", { name: "Open operator menu", exact: true }).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).waitFor();
    assert.equal(await page.getByRole("menuitem", { name: "All Messages", exact: true }).count(), 0, `${width}: Messages is not duplicated in the profile menu`);
    assert.equal(await page.getByRole("menuitem", { name: "Home", exact: true }).count(), 0, `${width}: Home is not duplicated in the profile menu`);
    await page.keyboard.press("Escape");
    if (width >= 768) {
      await page.getByRole("button", { name: "Collapse workspace navigation", exact: true }).click();
      assert.equal(await page.getByRole("complementary", { name: "Workspace navigation fixture" }).count(), 0, "desktop: collapse removes the sidebar rather than restoring the spine");
      const reopen = page.getByRole("button", { name: "Open workspace navigation", exact: true });
      await reopen.waitFor();
      await reopen.click();
      await page.getByRole("button", { name: "Collapse workspace navigation", exact: true }).waitFor();
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}×720: unified chrome, one-row sections, top actions, bottom profile menu${width >= 768 ? ", full collapse and reopen" : ""}`);
    await page.close();
    for (const scenario of ["updates", "updates&light", "empty"]) {
      const colorPage = await browser.newPage({ viewport: { width, height: 720 } });
      await colorPage.goto(`http://127.0.0.1:${server.address().port}/?${width < 768 ? "drawer&" : ""}${scenario}`);
      const bell = colorPage.getByRole("button", { name: scenario === "empty" ? "Notifications" : "Notifications, 3 unread", exact: true });
      await bell.waitFor();
      const badge = bell.locator(".MuiBadge-badge");
      if (scenario === "empty") {
        assert.equal(await badge.evaluate(node => node.classList.contains("MuiBadge-invisible")), true, `${width}: zero counts remain hidden`);
      } else {
        assert.equal(await badge.innerText(), "3", `${width}: unread-update count unchanged`);
        assert.equal(await badge.evaluate(node => getComputedStyle(node).backgroundColor), scenario.includes("light") ? "rgb(183, 77, 67)" : "rgb(214, 106, 92)", `${width}: unread-update badge is red in ${scenario.includes("light") ? "light" : "dark"} mode`);
      }
      await colorPage.close();
    }
    console.log(`PASS ${width}: notification bell is red for actions and updates in light/dark themes; zero stays hidden`);
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server?.close(resolve) ?? resolve());
  await rm(temporary, { recursive: true, force: true });
}

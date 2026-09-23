// Read-only browser qualification against an explicitly selected experimental host.
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH ?? "playwright");
const base = process.env.PONDEROSA_TEST_URL;
assert.ok(base, "Set PONDEROSA_TEST_URL to the experimental preview");
const browser = await chromium.launch({ headless: true, executablePath: process.env.PONDEROSA_CHROMIUM_PATH });
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 600, serviceWorkers: "block" });
    await context.route("**/api/**", route => ["GET", "HEAD", "OPTIONS"].includes(route.request().method()) ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}/home`);
    await page.getByText("Working Now", { exact: true }).waitFor({ timeout: 60000 });
    assert.equal(new URL(page.url()).pathname, "/home");
    await page.goto(`${base}/create/chat?surface=workspace`);
    await page.getByText("What would you like to work on?", { exact: true }).waitFor();
    const options = page.getByRole("button", { name: /^Chat options/ });
    await options.waitFor();
    assert.ok((await options.innerText()).includes(" · "));
    assert.equal(await page.getByRole("combobox", { name: /^Model/ }).isVisible(), false);
    await options.click();
    for (const name of ["Model", "Reasoning"]) {
      const select = page.getByRole("combobox", { name: new RegExp(`^${name}`) });
      await select.waitFor();
      assert.ok((await select.innerText()).replace(/\u200b/g, "").trim().length > 0, `${name} default is visible`);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "New Chat has no horizontal overflow");
    if (width < 600) await page.getByRole("button", { name: "Open workspace navigation", exact: true }).click();
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await page.getByText("Working Now", { exact: true }).waitFor();
    if (width < 600) await page.getByRole("button", { name: "Open workspace navigation", exact: true }).click();
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await page.getByRole("heading", { name: "Agents", exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/home", "Rail does not navigate the workspace");
    assert.equal(await page.getByText("Browse · select an item to open it", { exact: true }).count(), 0);
    await page.screenshot({ path: `/tmp/home-sidebar-${width}.png` });
    const row = page.locator('[data-resource-id^="sidebar-agent:"]:visible').first();
    await row.waitFor();
    const actions = row.locator("..").locator(".sidebar-secondary").last();
    if (width >= 600) {
      await page.mouse.move(1200, 800);
      assert.equal(await actions.evaluate(el => getComputedStyle(el).opacity), "0");
      await row.hover();
      assert.equal(await actions.evaluate(el => getComputedStyle(el).opacity), "1");
      await page.getByRole("tooltip").filter({ hasText: (await row.innerText()).trim() }).first().waitFor();
      await page.mouse.move(1200, 800);
      await row.focus();
      assert.equal(await actions.evaluate(el => getComputedStyle(el).opacity), "1");
    } else assert.equal(await actions.evaluate(el => getComputedStyle(el).opacity), "1", "Touch actions stay available");
    await page.getByRole("button", { name: "View All Agents", exact: true }).click();
    await page.getByRole("heading", { name: "All Agents", exact: true }).first().waitFor();
    assert.equal(await page.getByRole("combobox", { name: /^Project/ }).count(), 0);
    for (const resource of ["agent", "trigger"]) {
      await page.goto(`${base}/create/${resource}?surface=workspace`);
      await page.getByRole("combobox", { name: resource === "agent" ? "Chat" : "Destination Chat", exact: true }).first().waitFor();
      assert.equal(await page.getByRole("combobox", { name: "Project", exact: true }).count(), 0);
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}: Home, defaults, sidebar navigation/actions, chat destinations`);
    await context.close();
  }
  console.log("PASS Home, effective defaults, sidebar/workspace separation, hover/focus/touch actions, chat-based creation at desktop/mobile widths");
} finally { await browser.close(); }

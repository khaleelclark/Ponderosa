import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { createRsbuild } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";
import { ProjectFileAuthority, registerProjectFileRoutes } from "../../server/dist/routes/project-files.js";
import { registerFilesRoute } from "../../server/dist/routes/workspace-files.js";

const require = createRequire(new URL("../../server/package.json", import.meta.url));
const Fastify = require("fastify");
const root = fileURLToPath(new URL("..", import.meta.url));
const pdfjsRoot = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
const output = await mkdtemp(path.join(tmpdir(), "ponderosa-rendered-preview-"));
const files = await mkdtemp(path.join(tmpdir(), "ponderosa-preview-files-"));
const { chromium } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH ?? "playwright");
const app = Fastify(); let browser;
function pdf(amplified = false) {
  const text = amplified ? Array.from({ length: 10_000 }, (_, i) => `BT /F1 12 Tf 20 ${20 + i % 100 * 12} Td (${"x".repeat(92)}) Tj ET`).join("\n")
    : "BT /F1 24 Tf 40 120 Td (Ponderosa rendered PDF) Tj ET";
  const stream = deflateSync(text);
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${amplified ? "2000 1400" : "400 200"}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n${stream.toString("latin1")}\nendstream`];
  let body = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body, "latin1")); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body, "latin1"); body += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
try {
  await mkdir(path.join(files, "docs/images"), { recursive: true });
  await writeFile(path.join(files, "docs/images/photo.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7f8AAAAASUVORK5CYII=", "base64"));
  await writeFile(path.join(files, "report.pdf"), pdf());
  const amplified = pdf(true); assert.ok(amplified.length < 15_000);
  await writeFile(path.join(files, "amplified.pdf"), amplified);
  const store = { getProject: id => id === "project" ? { id, hostPath: files } : undefined, getAgent: () => undefined,
    getConversation: id => id === "chat" ? { id, projectId: "project", workingDirectory: files } : undefined, projectHasArtifactSourcePath: () => false };
  registerProjectFileRoutes(app, new ProjectFileAuthority(store, {}), store);
  registerFilesRoute(app, { store });
  const build = await createRsbuild({ cwd: root, rsbuildConfig: { plugins: [pluginReact()], source: { transformImport: [], entry: { index: path.join(root, "test/ui-audit-browser-entry.tsx") } }, output: { distPath: { root: output }, copy: [
    { from: path.join(pdfjsRoot, "cmaps"), to: "static/pdfjs/6.3.289/cmaps" },
    { from: path.join(pdfjsRoot, "standard_fonts"), to: "static/pdfjs/6.3.289/standard_fonts" },
    { from: path.join(pdfjsRoot, "wasm", "openjpeg_nowasm_fallback.js"), to: "static/pdfjs/6.3.289/decoders/openjpeg_nowasm_fallback.js" },
    { from: path.join(pdfjsRoot, "wasm", "jbig2_nowasm_fallback.js"), to: "static/pdfjs/6.3.289/decoders/jbig2_nowasm_fallback.js" },
  ] }, logLevel: "error" } });
  await build.build();
  app.addHook("onSend", async (_request, reply, payload) => {
    // Same strict policy as the app; do not accidentally qualify via an
    // unrestricted fixture which permits a worker the product would block.
    if (!reply.hasHeader("Content-Security-Policy")) reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    return payload;
  });
  app.get("/*", async (request, reply) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const file = path.join(output, pathname === "/" ? "index.html" : pathname);
    try { return reply.type(file.endsWith(".html") ? "text/html" : /\.m?js$/u.test(file) ? "text/javascript" : file.endsWith(".css") ? "text/css" : "application/octet-stream").send(await readFile(file)); } catch { return reply.code(404).send(); }
  });
  const origin = await app.listen({ port: 0, host: "127.0.0.1" });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PONDEROSA_CHROMIUM_PATH, args: process.env.PONDEROSA_BROWSER_DISABLE_SANDBOX === "1" ? ["--no-sandbox"] : [] });
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (/Refused to|sandbox.*blocked/i.test(message.text())) errors.push(message.text()); });
    await page.goto(`${origin}/?case=preview`);
    await page.waitForFunction(() => { const image = document.querySelector('img[alt="Nested photo"]'); return image?.naturalWidth > 0; });
    await page.getByText("Image unavailable: Missing photo", { exact: true }).waitFor();
    await page.getByText("Image unavailable: Rejected escape", { exact: true }).waitFor();
    await page.getByText("report.pdf", { exact: true }).click();
    const canvas = page.locator('canvas[aria-label="report.pdf, page 1"]'); await canvas.waitFor({ state: "visible" });
    assert.equal(await page.locator("iframe").count(), 0);
    assert.ok(await canvas.evaluate(node => node.getContext("2d").getImageData(0, 0, node.width, node.height).data
      .some((value, index) => index % 4 !== 3 && value < 200)), "scoped PDF content is actually painted");
    assert.equal(errors.length, 0, errors.join("\n"));
    await page.screenshot({ path: `/tmp/ponderosa-ui-audit-pdf-${width}.png` });
    const response = await page.request.get(`${origin}/api/projects/project/workspace-files/preview?path=report.pdf&conversationId=chat`);
    assert.match(response.headers()["content-security-policy"], /frame-ancestors 'self'/);
    assert.equal((await page.request.get(`${origin}/api/projects/project/workspace-files/preview?path=report.pdf&conversationId=another`)).status(), 404);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByText("amplified.pdf", { exact: true }).click();
    await page.locator('canvas[aria-label="amplified.pdf, page 1"]').waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector('[aria-label="PDF preview: amplified.pdf"]')?.lastElementChild?.textContent.length === 64_000);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByText("report.pdf", { exact: true }).click();
    await page.locator('canvas[aria-label="report.pdf, page 1"]').waitFor({ state: "visible" });
    assert.deepEqual(errors, [], "bounded extraction cancellation and reopening produce no browser errors");
    await page.close();
  }
  console.log("Passed: real scoped route renders nested Markdown image and painted PDF canvas under strict CSP at 390/1440px; compressed amplified text is bounded, cancellation/reopening is clean, missing/escaped images are honest and wrong-Chat preview is denied.");
} finally { await browser?.close(); await app.close(); await rm(output, { recursive: true, force: true }); await rm(files, { recursive: true, force: true }); }

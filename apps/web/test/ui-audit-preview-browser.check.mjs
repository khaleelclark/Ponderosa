import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRsbuild } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";
import { ProjectFileAuthority, registerProjectFileRoutes } from "../../server/dist/routes/project-files.js";
import { registerFilesRoute } from "../../server/dist/routes/workspace-files.js";

const require = createRequire(new URL("../../server/package.json", import.meta.url));
const Fastify = require("fastify");
const root = fileURLToPath(new URL("..", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "ponderosa-rendered-preview-"));
const files = await mkdtemp(path.join(tmpdir(), "ponderosa-preview-files-"));
const { chromium } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH ?? "playwright");
const app = Fastify(); let browser;
function pdf() {
  const stream = "BT /F1 24 Tf 40 120 Td (Ponderosa rendered PDF) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let body = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body); body += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return body;
}
try {
  await mkdir(path.join(files, "docs/images"), { recursive: true });
  await writeFile(path.join(files, "docs/images/photo.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7f8AAAAASUVORK5CYII=", "base64"));
  await writeFile(path.join(files, "report.pdf"), pdf());
  const store = { getProject: id => id === "project" ? { id, hostPath: files } : undefined, getAgent: () => undefined,
    getConversation: id => id === "chat" ? { id, projectId: "project", workingDirectory: files } : undefined, projectHasArtifactSourcePath: () => false };
  registerProjectFileRoutes(app, new ProjectFileAuthority(store, {}), store);
  registerFilesRoute(app, { store });
  const build = await createRsbuild({ cwd: root, rsbuildConfig: { plugins: [pluginReact()], source: { transformImport: [], entry: { index: path.join(root, "test/ui-audit-browser-entry.tsx") } }, output: { distPath: { root: output } }, logLevel: "error" } });
  await build.build();
  app.get("/*", async (request, reply) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const file = path.join(output, pathname === "/" ? "index.html" : pathname);
    try { return reply.type(file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html").send(await readFile(file)); } catch { return reply.code(404).send(); }
  });
  const origin = await app.listen({ port: 0, host: "127.0.0.1" });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PONDEROSA_CHROMIUM_PATH, args: process.env.PONDEROSA_BROWSER_DISABLE_SANDBOX === "1" ? ["--no-sandbox"] : [] });
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors = []; page.on("console", message => { if (/Refused to (?:frame|display)|sandbox.*blocked/i.test(message.text())) errors.push(message.text()); });
    await page.goto(`${origin}/?case=preview`);
    await page.waitForFunction(() => { const image = document.querySelector('img[alt="Nested photo"]'); return image?.naturalWidth > 0; });
    await page.getByText("Image unavailable: Missing photo", { exact: true }).waitFor();
    await page.getByText("Image unavailable: Rejected escape", { exact: true }).waitFor();
    await page.getByText("report.pdf", { exact: true }).click();
    const frame = page.locator('iframe[title="Preview report.pdf"]'); await frame.waitFor();
    await page.waitForTimeout(300);
    const viewerFrame = page.frames().find(item => item.url().startsWith("chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/"));
    assert.ok(viewerFrame, "Chrome's PDF renderer was instantiated");
    await viewerFrame.locator("embed").waitFor({ timeout: 5000 });
    const embedded = await viewerFrame.locator("embed").evaluate(node => ({ src: node.getAttribute("src"), width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }));
    assert.ok(embedded.width > 0 && embedded.height > 0, "Chrome instantiated its PDF renderer inside the live modal");
    assert.equal(errors.length, 0, errors.join("\n"));
    await page.screenshot({ path: `/tmp/ponderosa-ui-audit-pdf-${width}.png` });
    const response = await page.request.get(`${origin}/api/projects/project/workspace-files/preview?path=report.pdf&conversationId=chat`);
    assert.match(response.headers()["content-security-policy"], /frame-ancestors 'self'/);
    assert.equal((await page.request.get(`${origin}/api/projects/project/workspace-files/preview?path=report.pdf&conversationId=another`)).status(), 404);
    await page.close();
  }
  console.log("Passed: real scoped route renders nested Markdown image and Chrome PDF plugin in live Workspace Files modal at 390/1440px; missing/escaped images are honest and wrong-Chat preview is denied.");
} finally { await browser?.close(); await app.close(); await rm(output, { recursive: true, force: true }); await rm(files, { recursive: true, force: true }); }

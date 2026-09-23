#!/usr/bin/env node
import { brotliCompressSync, constants } from "node:zlib";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "dist");
const index = readFileSync(path.join(root, "index.html"), "utf8");
const scripts = [...index.matchAll(/<script[^>]+src=["']([^"']+)["']/gu)]
  .map((match) => match[1])
  .filter((source) => source.startsWith("/static/js/"));
const uniqueScripts = [...new Set(scripts)];
if (uniqueScripts.length === 0) throw new Error("built index does not reference application JavaScript");

const synchronous = uniqueScripts.map((source) => {
  const file = path.join(root, source.slice(1));
  const bytes = readFileSync(file);
  return {
    source,
    raw: bytes.length,
    brotli: brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).length,
  };
});
const javascriptDirectory = path.join(root, "static", "js");
const visit = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const target = path.join(directory, entry.name);
  return entry.isDirectory() ? visit(target) : entry.name.endsWith(".js") ? [target] : [];
});
const allJavascript = visit(javascriptDirectory);
const totalRaw = allJavascript.reduce((sum, file) => sum + statSync(file).size, 0);
const synchronousRaw = synchronous.reduce((sum, item) => sum + item.raw, 0);
const synchronousBrotli = synchronous.reduce((sum, item) => sum + item.brotli, 0);
const largest = Math.max(...synchronous.map((item) => item.raw));

const budgets = {
  largestSynchronousRaw: 900 * 1024,
  synchronousRaw: 2 * 1024 * 1024,
  synchronousBrotli: 600 * 1024,
  totalJavascriptRaw: 4 * 1024 * 1024,
};
const observed = { largestSynchronousRaw: largest, synchronousRaw, synchronousBrotli, totalJavascriptRaw: totalRaw };
for (const [name, limit] of Object.entries(budgets)) {
  if (observed[name] > limit) {
    throw new Error(`${name} exceeded its production budget: ${observed[name]} > ${limit}`);
  }
}
const worker = readFileSync(path.join(root, "sw.js"), "utf8");
if (allJavascript.some((file) => {
  const relative = path.relative(root, file).split(path.sep).join("/");
  return worker.includes(`url:\"${relative}\"`) || worker.includes(`\"url\":\"${relative}\"`);
})) {
  throw new Error("service-worker installation precache contains application JavaScript");
}
process.stdout.write(`${JSON.stringify({ status: "pass", observed, budgets, scripts: synchronous }, null, 2)}\n`);

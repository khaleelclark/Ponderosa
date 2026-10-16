import { copyFile, mkdir } from "node:fs/promises";
import { writeDependencyNotices } from "../../packaging/third-party-notices.mjs";
import { fileURLToPath } from "node:url";
await mkdir(new URL("./dist/", import.meta.url), { recursive: true });
for (const file of ["manifest.json", "popup.html", "popup.css", "README.md"]) await copyFile(new URL(file, import.meta.url), new URL(`dist/${file}`, import.meta.url));
writeDependencyNotices([fileURLToPath(new URL("./package.json", import.meta.url))],
  fileURLToPath(new URL("./dist/notices", import.meta.url)));

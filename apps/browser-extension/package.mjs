import { copyFile, mkdir } from "node:fs/promises";
await mkdir(new URL("./dist/", import.meta.url), { recursive: true });
for (const file of ["manifest.json", "popup.html", "popup.css", "README.md"]) await copyFile(new URL(file, import.meta.url), new URL(`dist/${file}`, import.meta.url));

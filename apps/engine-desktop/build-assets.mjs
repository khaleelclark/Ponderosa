import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(root, "dist");
mkdirSync(output, { recursive: true });
for (const asset of ["index.html", "styles.css"]) {
  cpSync(path.join(root, "src", asset), path.join(output, asset));
}

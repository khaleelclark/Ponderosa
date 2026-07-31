import { cpSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");

rmSync(path.join(dist, "migrations"), { recursive: true, force: true });
rmSync(path.join(dist, "schema"), { recursive: true, force: true });
cpSync(path.join(root, "src", "schema"), path.join(dist, "schema"), { recursive: true });

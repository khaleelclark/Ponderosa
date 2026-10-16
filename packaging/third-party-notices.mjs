import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const supplementsRoot = fileURLToPath(new URL("./notices/", import.meta.url));
const supplements = JSON.parse(readFileSync(path.join(supplementsRoot, "supplements.json"), "utf8"));
const noticeName = /^(?:licen[sc]e|copying|copyright|notice|authors|patents)(?:$|[._-])/iu;
const noticeDirectories = new Set(["licenses", "docs", "lib", "libheif", "libheif-wasm", "standard_fonts", "cmaps", "wasm"]);
const hash = body => createHash("sha256").update(body).digest("hex");

function resolvePackage(name, from) {
  for (let directory = from; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, "node_modules", name, "package.json");
    if (existsSync(candidate)) return realpathSync(candidate);
    if (directory === path.dirname(directory)) return undefined;
  }
}

function noticeFiles(root, relative = "", depth = 0) {
  return readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(entry => {
    const name = path.join(relative, entry.name);
    if (entry.isFile() && (noticeName.test(entry.name) ||
        /^(?:licen[sc]es?)$/iu.test(path.basename(relative)))) return [name];
    if (entry.isDirectory() && depth < 3 &&
        (noticeDirectories.has(entry.name.toLowerCase()) || noticeName.test(entry.name))) {
      return noticeFiles(root, name, depth + 1);
    }
    return [];
  });
}

// Follow installed production dependencies, including nested versions, rather
// than scanning build tools or unrelated package.json fixtures by filename.
export function writeDependencyNotices(packageJsonPaths, output, excludedDependencies = []) {
  const visited = new Set();
  const records = new Map();
  const missing = [];
  function visit(packageJson) {
    packageJson = realpathSync(packageJson);
    if (visited.has(packageJson)) return;
    visited.add(packageJson);
    const root = path.dirname(packageJson);
    const metadata = JSON.parse(readFileSync(packageJson, "utf8"));
    if (!metadata.name?.startsWith("@ponderosa/")) {
      const key = `${metadata.name}@${metadata.version}`;
      if (metadata.name === "pdfjs-dist" && metadata.version !== "6.3.289") {
        throw new Error(`Review bundled font sources and notices for ${key} before packaging.`);
      }
      if (metadata.name === "pdfjs-dist") {
        for (const [filename, expected] of Object.entries(supplements.liberationFontSha256)) {
          if (hash(readFileSync(path.join(root, "standard_fonts", filename))) !== expected) {
            throw new Error(`Liberation font differs from its reviewed Debian source provenance: ${filename}`);
          }
        }
      }
      if (metadata.name === "libheif-js" && metadata.version !== "1.23.2") {
        throw new Error(`Review WASM license/source references for ${key} before packaging.`);
      }
      if (metadata.name.startsWith("@img/sharp-libvips-") || metadata.name === "@img/sharp-win32-x64") {
        const versions = JSON.parse(readFileSync(path.join(root, "versions.json"), "utf8"));
        if (JSON.stringify(Object.entries(versions).sort()) !==
            JSON.stringify(Object.entries(supplements.nativeVersions).sort())) {
          throw new Error(`Review native upstream license/source references for ${key} before packaging.`);
        }
      }
      const files = noticeFiles(root).map(file => ({
        file: file.split(path.sep).join("/"),
        body: readFileSync(path.join(root, file)),
        provenance: "installed package",
      }));
      for (const supplement of supplements.packages.filter(item => item.name === metadata.name)) {
        if (!supplement.versions.includes(metadata.version)) {
          throw new Error(`Review supplemental notices for ${key} before packaging this version.`);
        }
        const body = readFileSync(path.join(supplementsRoot, supplement.file));
        if (hash(body) !== supplement.sha256) throw new Error(`Supplemental notice hash mismatch: ${supplement.file}`);
        files.push({ file: `supplemental/${path.basename(supplement.file)}`, body, provenance: supplement.url });
      }
      if (!files.some(file => file.body.length > 0 && (file.provenance !== "installed package" ||
          /^(?:licen[sc]e|copying|copyright|notice)/iu.test(path.basename(file.file))))) {
        missing.push(key);
      }
      const signature = files.map(file => `${file.file}:${hash(file.body)}`).sort().join("\n");
      if (records.has(key) && records.get(key).signature !== signature) {
        throw new Error(`Different notice contents for installed copies of ${key}.`);
      }
      records.set(key, { name: metadata.name, version: metadata.version, license: metadata.license, files, signature });
    }
    for (const name of Object.keys({ ...metadata.dependencies, ...metadata.optionalDependencies }).sort()) {
      if (excludedDependencies.includes(name)) continue;
      const dependency = resolvePackage(name, root);
      if (!dependency) {
        if (Object.hasOwn(metadata.optionalDependencies ?? {}, name)) continue;
        throw new Error(`Cannot resolve ${name} from ${metadata.name} for notice collection.`);
      }
      visit(dependency);
    }
  }
  for (const packageJson of packageJsonPaths) visit(packageJson);
  if (missing.length) throw new Error(`No license/notice text found; review before packaging: ${missing.join(", ")}`);
  // This generated directory is owned by this build, not a user-selected tree.
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const index = [];
  const text = [
    "Third-party dependency notices",
    "These components retain their respective licenses. This collection does not license Ponderosa's original code.",
    "Includes installed production dependency closure; browser tree shaking may omit some modules.",
    "Native embedded libraries and source/replacement requirements need separate review; this is not release clearance.",
    "",
  ];
  for (const record of [...records.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))) {
    text.push(`===== ${record.name}@${record.version} =====`, `Package: https://www.npmjs.com/package/${record.name}/v/${record.version}`);
    const files = record.files.map(file => {
      text.push(`--- ${file.file} (${file.provenance}) ---`, file.body.toString("utf8"), "");
      return { file: file.file, sha256: hash(file.body), provenance: file.provenance };
    });
    index.push({ name: record.name, version: record.version, license: record.license, files });
  }
  writeFileSync(path.join(output, "THIRD-PARTY-NOTICES.txt"), text.join("\n"));
  writeFileSync(path.join(output, "dependency-notices.json"), `${JSON.stringify(index, null, 2)}\n`);
  return output;
}

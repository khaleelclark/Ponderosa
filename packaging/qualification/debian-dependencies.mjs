import { execFileSync } from "node:child_process";
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function debianDependencies(application) {
  const executables = [];
  const libraryDirectories = new Set();
  const magic = Buffer.alloc(4);
  for (const entry of readdirSync(application, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const filename = path.join(entry.parentPath, entry.name);
    if (!(lstatSync(filename).mode & 0o111) && !/\.(?:node|so(?:\.\d+)*)$/u.test(filename)) continue;
    const descriptor = openSync(filename, "r");
    try {
      if (readSync(descriptor, magic, 0, 4, 0) === 4 && magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
        executables.push(`-e${filename}`);
        libraryDirectories.add(path.dirname(filename));
      }
    } finally { closeSync(descriptor); }
  }
  if (!executables.length) throw new Error("Debian package contains no ELF executables.");
  const root = mkdtempSync(path.join(os.tmpdir(), "ponderosa-shlibdeps-"));
  try {
    mkdirSync(path.join(root, "debian"));
    writeFileSync(path.join(root, "debian", "control"), "Source: ponderosa-beta\n\nPackage: ponderosa-beta\nArchitecture: any\nDescription: Ponderosa Engine\n");
    // Private bundled libraries have no dpkg owner. System libraries still
    // resolve through the build host's native shlibs/symbols database.
    const output = execFileSync("dpkg-shlibdeps", ["-O", "--ignore-missing-info",
      ...[...libraryDirectories].map(directory => `-l${directory}`), ...executables], {
      cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
    });
    const dependencies = output.match(/^shlibs:Depends=(.+)$/mu)?.[1];
    if (!dependencies) throw new Error("dpkg-shlibdeps produced no runtime dependencies.");
    return `${dependencies}, xdg-utils`;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

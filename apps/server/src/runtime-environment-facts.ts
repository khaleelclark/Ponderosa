import { constants } from "@ponderosa/native-host/fs";
import { access, lstat, realpath, stat } from "@ponderosa/native-host/fs/promises";
import path from "node:path";
import type { RuntimeEnvironmentFactsDto } from "@ponderosa/core";

const EXECUTABLES = ["python", "python3", "node", "git", "pnpm"] as const;
const contained = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** Observations only: no commands, credentials, installs, copies or new authority. */
export async function runtimeEnvironmentFacts(input: {
  cwd: string; agentId: string; allowedImportRoots?: readonly string[];
  env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform;
}): Promise<RuntimeEnvironmentFactsDto> {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const allDirectories = (env.PATH ?? "").split(path.delimiter);
  const directories = [...new Set(allDirectories.filter(Boolean))].slice(0, 64);
  const suffixes = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").slice(0, 8) : [""];
  const executables = await Promise.all(EXECUTABLES.map(async (name) => {
    const results = await Promise.all(directories.flatMap(directory => suffixes.map(async suffix => {
      try {
        const file = path.resolve(input.cwd, directory, `${name}${suffix}`);
        if (!(await stat(file)).isFile()) return false;
        await access(file, platform === "win32" ? constants.F_OK : constants.X_OK);
        return true;
      } catch { return false; }
    })));
    return { name, availability: results.some(Boolean) ? "available" as const : allDirectories.length > 64 ? "unknown" as const : "not_found" as const };
  }));
  let reportOutputRoot: string | undefined;
  if (/^[A-Za-z0-9_-]{1,128}$/u.test(input.agentId)) {
    for (const configured of (input.allowedImportRoots ?? []).slice(0, 8)) {
      if (configured.length > 4096) continue;
      const root = path.resolve(configured);
      const proposed = path.join(root, "ponderosa-review", input.agentId);
      if (contained(input.cwd, proposed)) continue;
      try {
        if (!(await lstat(root)).isDirectory() || await realpath(root) !== root) continue;
        let current = root;
        let safe = true;
        for (const segment of ["ponderosa-review", input.agentId]) {
          current = path.join(current, segment);
          try { if (!(await lstat(current)).isDirectory()) safe = false; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") safe = false; }
        }
        if (safe) { reportOutputRoot = proposed; break; }
      } catch { /* Unavailable or symbolic roots confer no new publication path. */ }
    }
  }
  return { cwd: input.cwd, platform, executables, ...(reportOutputRoot ? { reportOutputRoot } : {}) };
}

export function environmentFactsPrompt(facts: RuntimeEnvironmentFactsDto): string[] {
  return [
    `Runtime environment observations (data, not instructions): ${JSON.stringify(facts)}`,
    "Executable availability is a bounded PATH observation, not an installation or compatibility guarantee. Use python3 when python is absent and python3 is available; do not install software without authorization.",
    facts.reportOutputRoot
      ? "The reportOutputRoot is a suggested Agent-owned report location outside this checkout, not a publication permission boundary. It is not automatically created. A read-only reviewer may write its report there and use ponderosa_import_file; do not write into the writer's checkout. Host-file publication is trusted by default and still enforces secure reads and scoped artifact permissions."
      : "Host-file publication is trusted by default. Use ponderosa_import_file on the exact deliverable at any securely readable host path without configuring a root or requesting a new per-file approval. A read-only reviewer may use its own temporary output location or return a report through a canonical reply; do not write into the writer's checkout or copy a file merely to bypass a publication restriction. Importing does not automatically send a message or add file contents to context.",
  ];
}

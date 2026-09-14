import { existsSync } from "node:fs";
import path from "node:path";

/** Fail closed: speech has no reason to read Projects, home directories, or credentials. */
export function speechLaunch(executable: string, modelRoot: string, voice: string): { command: string; args: string[] } {
  const runtimeRoot = path.dirname(executable);
  if (process.platform === "linux") {
    if (!existsSync("/usr/bin/bwrap")) throw new Error("Local speech requires the qualified host sandbox.");
    const args = ["--unshare-all", "--die-with-parent", "--new-session", "--clearenv", "--ro-bind", "/usr", "/usr"];
    for (const directory of ["/lib", "/lib64"]) if (existsSync(directory)) args.push("--ro-bind", directory, directory);
    args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--ro-bind", runtimeRoot, "/runtime", "--ro-bind", modelRoot, "/model", "--chdir", "/tmp", "--", `/runtime/${path.basename(executable)}`, "/model", voice);
    return { command: "/usr/bin/bwrap", args };
  }
  if (process.platform === "darwin") {
    const quote = (value: string) => JSON.stringify(value);
    const profile = `(version 1)(deny default)(allow process-exec process-fork signal sysctl-read)(allow file-read* (subpath "/System") (subpath "/usr/lib") (subpath ${quote(runtimeRoot)}) (subpath ${quote(modelRoot)}) (literal "/dev/null") (literal "/dev/urandom"))(allow file-write* (literal "/dev/null"))(deny network*)`;
    return { command: "/usr/bin/sandbox-exec", args: ["-p", profile, executable, modelRoot, voice] };
  }
  // The Windows binary builds, but a job object alone is not a filesystem sandbox.
  // Do not ship an unsandboxed fallback while restricted-token qualification is pending.
  throw new Error("Local speech containment has not been qualified for this platform.");
}

import { execFileSync } from "node:child_process";

export function verifyMacosApplication(application) {
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", application], {
    stdio: "pipe",
  });
}

export function signMacosApplication(application, identity) {
  // Packager changes Electron's resources and plist. Seal the finished bundle
  // even for a private beta; the inherited linker signature is not valid.
  execFileSync("codesign", [
    "--force", "--deep",
    ...(identity ? ["--options", "runtime", "--timestamp"] : []),
    "--sign", identity || "-",
    application,
  ], { stdio: "inherit" });
  verifyMacosApplication(application);
}

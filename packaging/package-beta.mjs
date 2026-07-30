#!/usr/bin/env node

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  auditPortableSymlinkTree,
  copyPortableTree,
} from "./qualification/symlink-portability.mjs";
import { macosInfoPlist } from "./macos-bundle-metadata.mjs";
import { macosLauncherEntry } from "./qualification/macos-gui-entry.mjs";

function option(name, fallback) {
  const inline = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function run(command, args) {
  execFileSync(command, args, { stdio: "inherit", windowsHide: true });
}

function writeExecutable(pathname, content) {
  writeFileSync(pathname, content, { mode: 0o755 });
  try { chmodSync(pathname, 0o755); } catch { /* Windows ignores POSIX modes. */ }
}

function finalizeArtifact(target, security) {
  if (!existsSync(target)) throw new Error(`Installer was not produced: ${target}`);
  const checksum = createHash("sha256").update(readFileSync(target)).digest("hex");
  const checksumPath = `${target}.sha256`;
  const metadataPath = `${target}.metadata.json`;
  writeFileSync(checksumPath, `${checksum}  ${path.basename(target)}\n`);
  writeFileSync(metadataPath, `${JSON.stringify({
    schemaVersion: 1,
    artifact: path.basename(target),
    sha256: checksum,
    version: manifest.version,
    commit: manifest.commit,
    target: manifest.target,
    ...security,
  }, null, 2)}\n`);
  process.stdout.write(`${target}\n${checksumPath}\n${metadataPath}\n`);
}

const bundle = path.resolve(option(
  "bundle",
  path.join("dist", "beta", `${process.platform}-${process.arch}`, "Ponderosa"),
));
const output = path.resolve(option("output", path.join("dist", "installers")));
const format = option("format", process.platform === "darwin" ? "dmg" : process.platform === "win32" ? "exe" : "appimage");
const manifest = JSON.parse(readFileSync(path.join(bundle, "build-manifest.json"), "utf8"));
const artifactBase = `Ponderosa-${manifest.version}-${manifest.target.platform}-${manifest.target.arch}`;
mkdirSync(output, { recursive: true });
auditPortableSymlinkTree(bundle, { label: "pre-package native bundle" });

if (format === "dmg") {
  if (process.platform !== "darwin") throw new Error("DMG packages must be built on macOS.");
  const stage = path.join(os.tmpdir(), `ponderosa-dmg-${process.pid}`);
  const app = path.join(stage, "Ponderosa Beta.app");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true });
  copyPortableTree(bundle, path.join(app, "Contents", "Resources", "Ponderosa"), {
    label: "staged macOS application bundle",
  });
  const iconset = path.join(stage, "Ponderosa.iconset");
  const iconSource = path.join(bundle, "app", "web", "dist", "icons", "app-icon.png");
  mkdirSync(iconset);
  for (const [pixels, name] of [
    [16, "icon_16x16.png"],
    [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],
    [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"],
    [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"],
    [1024, "icon_512x512@2x.png"],
  ]) {
    run("sips", [
      "-z", String(pixels), String(pixels),
      iconSource,
      "--out", path.join(iconset, name),
    ]);
  }
  run("iconutil", [
    "--convert", "icns",
    "--output", path.join(app, "Contents", "Resources", "Ponderosa.icns"),
    iconset,
  ]);
  rmSync(iconset, { recursive: true, force: true });
  writeExecutable(
    path.join(app, "Contents", "MacOS", "Ponderosa"),
    macosLauncherEntry(),
  );
  writeFileSync(path.join(app, "Contents", "Info.plist"), macosInfoPlist(manifest));
  const signingIdentity = process.env.PONDEROSA_MACOS_SIGN_IDENTITY?.trim();
  if (signingIdentity) {
    run("codesign", [
      "--force",
      "--deep",
      "--options", "runtime",
      "--timestamp",
      "--sign", signingIdentity,
      app,
    ]);
    run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  }
  const target = path.join(output, `${artifactBase}.dmg`);
  rmSync(target, { force: true });
  run("hdiutil", ["create", "-volname", "Ponderosa Beta", "-srcfolder", stage, "-ov", "-format", "UDZO", target]);
  rmSync(stage, { recursive: true, force: true });
  const notaryProfile = process.env.PONDEROSA_MACOS_NOTARY_PROFILE?.trim();
  if (notaryProfile) {
    if (!signingIdentity) throw new Error("Notarization requires PONDEROSA_MACOS_SIGN_IDENTITY.");
    run("xcrun", ["notarytool", "submit", target, "--keychain-profile", notaryProfile, "--wait"]);
    run("xcrun", ["stapler", "staple", target]);
  }
  finalizeArtifact(target, {
    signed: Boolean(signingIdentity),
    notarized: Boolean(notaryProfile),
    warning: notaryProfile
      ? null
      : "Unsigned or unnotarized private-beta build: macOS Gatekeeper may block first launch.",
  });
} else if (format === "appimage") {
  if (process.platform !== "linux") throw new Error("AppImage packages must be built on Linux.");
  const appDir = path.join(os.tmpdir(), `ponderosa-appimage-${process.pid}.AppDir`);
  rmSync(appDir, { recursive: true, force: true });
  mkdirSync(path.join(appDir, "usr", "lib"), { recursive: true });
  mkdirSync(path.join(appDir, "usr", "share", "icons", "hicolor", "256x256", "apps"), { recursive: true });
  copyPortableTree(bundle, path.join(appDir, "usr", "lib", "ponderosa-beta"), {
    label: "staged AppImage application bundle",
  });
  cpSync(
    path.join(bundle, "app", "web", "dist", "icons", "app-icon.png"),
    path.join(appDir, "ponderosa-beta.png"),
  );
  writeExecutable(path.join(appDir, "AppRun"), `#!/bin/sh
set -eu
ROOT="$APPDIR/usr/lib/ponderosa-beta"
exec "$ROOT/runtime/node" "$ROOT/app/launcher/dist/cli.js" open --install-root "$ROOT"
`);
  writeFileSync(path.join(appDir, "ponderosa-beta.desktop"), `[Desktop Entry]
Type=Application
Name=Ponderosa Beta
Exec=ponderosa-beta
Icon=ponderosa-beta
Categories=Development;
Terminal=false
`);
  const tool = process.env.APPIMAGETOOL?.trim() || "appimagetool";
  const target = path.join(output, `${artifactBase}.AppImage`);
  run(tool, [appDir, target]);
  chmodSync(target, 0o755);
  rmSync(appDir, { recursive: true, force: true });
  finalizeArtifact(target, {
    signed: false,
    notarized: false,
    warning: "Unsigned private-beta AppImage.",
  });
} else if (format === "deb") {
  if (process.platform !== "linux") throw new Error("Debian packages must be built on Linux.");
  const root = path.join(os.tmpdir(), `ponderosa-deb-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(path.join(root, "DEBIAN"), { recursive: true });
  mkdirSync(path.join(root, "opt"), { recursive: true });
  mkdirSync(path.join(root, "usr", "bin"), { recursive: true });
  mkdirSync(path.join(root, "usr", "share", "applications"), { recursive: true });
  copyPortableTree(bundle, path.join(root, "opt", "ponderosa-beta"), {
    label: "staged Debian application bundle",
  });
  writeExecutable(path.join(root, "usr", "bin", "ponderosa-beta"), `#!/bin/sh
exec /opt/ponderosa-beta/runtime/node /opt/ponderosa-beta/app/launcher/dist/cli.js open --install-root /opt/ponderosa-beta "$@"
`);
  writeFileSync(path.join(root, "usr", "share", "applications", "ponderosa-beta.desktop"), `[Desktop Entry]
Type=Application
Name=Ponderosa Beta
Exec=ponderosa-beta
Icon=/opt/ponderosa-beta/app/web/dist/icons/app-icon.png
Categories=Development;
Terminal=false
`);
  writeFileSync(path.join(root, "DEBIAN", "control"), [
    "Package: ponderosa-beta",
    `Version: ${manifest.version.replace(/[^0-9A-Za-z.+~:-]/gu, "-")}`,
    `Architecture: ${manifest.target.arch === "x64" ? "amd64" : manifest.target.arch === "arm64" ? "arm64" : manifest.target.arch}`,
    "Maintainer: Ponderosa Private Beta",
    "Section: devel",
    "Priority: optional",
    "Description: Self-hosted AI Agent orchestration workbench (private beta)",
    "",
  ].join("\n"));
  const target = path.join(output, `${artifactBase}.deb`);
  run("dpkg-deb", ["--root-owner-group", "--build", root, target]);
  rmSync(root, { recursive: true, force: true });
  finalizeArtifact(target, {
    signed: false,
    notarized: false,
    warning: "Unsigned private-beta Debian package.",
  });
} else if (format === "exe") {
  if (process.platform !== "win32") throw new Error("Windows installers must be built on Windows.");
  const iscc = process.env.ISCC?.trim() || "ISCC.exe";
  const script = path.join(os.tmpdir(), `ponderosa-${process.pid}.iss`);
  const escapedBundle = bundle.replaceAll("\\", "\\\\");
  const escapedOutput = output.replaceAll("\\", "\\\\");
  writeFileSync(script, `#define MyAppVersion "${manifest.version}"
[Setup]
AppId={{F6108742-BCEE-4C42-89D5-642384612310}
AppName=Ponderosa Beta
AppVersion={#MyAppVersion}
DefaultDirName={localappdata}\\Programs\\Ponderosa Beta
PrivilegesRequired=lowest
OutputDir=${escapedOutput}
OutputBaseFilename=${artifactBase}
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Files]
Source: "${escapedBundle}\\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\\Ponderosa Beta"; Filename: "{sys}\\wscript.exe"; Parameters: """{app}\\ponderosa.vbs"""; WorkingDir: "{app}"

[Run]
Filename: "{sys}\\wscript.exe"; Parameters: """{app}\\ponderosa.vbs"""; Description: "Open Ponderosa Beta"; Flags: nowait postinstall skipifsilent runhidden
`);
  run(iscc, [script]);
  rmSync(script, { force: true });
  const target = path.join(output, `${artifactBase}.exe`);
  const signingCertificate = process.env.PONDEROSA_WINDOWS_CERT_SHA1?.trim();
  if (signingCertificate) {
    const signtool = process.env.PONDEROSA_SIGNTOOL?.trim() || "signtool.exe";
    const timestampUrl = process.env.PONDEROSA_WINDOWS_TIMESTAMP_URL?.trim() ||
      "http://timestamp.digicert.com";
    run(signtool, [
      "sign",
      "/fd", "SHA256",
      "/td", "SHA256",
      "/tr", timestampUrl,
      "/sha1", signingCertificate,
      target,
    ]);
    run(signtool, ["verify", "/pa", "/v", target]);
  }
  finalizeArtifact(target, {
    signed: Boolean(signingCertificate),
    notarized: false,
    warning: signingCertificate
      ? null
      : "Unsigned private-beta build: Windows SmartScreen may warn or block first launch.",
  });
} else {
  throw new Error(`Unknown package format: ${format}`);
}

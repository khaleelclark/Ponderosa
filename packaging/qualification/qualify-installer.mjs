#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

function option(name, fallback) {
  const inline = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    stdio: "inherit",
    ...options,
  });
}

function defaultDataDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Ponderosa Beta");
  }
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local"),
      "Ponderosa Beta",
    );
  }
  return path.join(
    process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share"),
    "ponderosa-beta",
  );
}

const artifact = path.resolve(option("artifact", ""));
if (!artifact || !existsSync(artifact)) throw new Error(`Installer artifact is missing: ${artifact}`);
const reportPath = path.resolve(option(
  "report",
  path.join("dist", "qualification", `${process.platform}-${process.arch}-installer.json`),
));
const disposable = mkdtempSync(path.join(os.tmpdir(), "ponderosa-installer-qualification-"));
const project = path.join(disposable, "selected-project");
const projectSentinel = path.join(project, "PONDEROSA_MUST_NOT_DELETE.txt");
const dataSentinelDirectory = path.join(defaultDataDir(), `qualification-${process.pid}-${Date.now()}`);
const dataSentinel = path.join(dataSentinelDirectory, "PONDEROSA_MUST_NOT_DELETE.txt");
mkdirSync(project, { recursive: true, mode: 0o700 });
mkdirSync(dataSentinelDirectory, { recursive: true, mode: 0o700 });
writeFileSync(projectSentinel, "selected Project source folders survive uninstall\n");
writeFileSync(dataSentinel, "Ponderosa user data survives uninstall\n");

let installedRoot;
let uninstall = () => undefined;
let mounted;
let installed = false;
let removed = false;
try {
  if (process.platform === "linux") {
    if (!artifact.endsWith(".deb")) throw new Error("Linux installer qualification requires a .deb.");
    installedRoot = "/opt/ponderosa-beta";
    if (existsSync(installedRoot)) throw new Error(`${installedRoot} already exists; refusing to replace it.`);
    run("sudo", ["dpkg", "--install", artifact]);
    uninstall = () => run("sudo", ["dpkg", "--remove", "ponderosa-beta"]);
    installed = true;
  } else if (process.platform === "darwin") {
    if (!artifact.endsWith(".dmg")) throw new Error("macOS installer qualification requires a .dmg.");
    mounted = path.join(disposable, "mounted");
    mkdirSync(mounted);
    run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mounted, artifact]);
    const sourceApp = path.join(mounted, "Ponderosa Beta.app");
    const installedApp = path.join(disposable, "Applications", "Ponderosa Beta.app");
    mkdirSync(path.dirname(installedApp), { recursive: true });
    cpSync(sourceApp, installedApp, { recursive: true });
    installedRoot = path.join(installedApp, "Contents", "Resources", "Ponderosa");
    uninstall = () => rmSync(installedApp, { recursive: true, force: true });
    installed = true;
  } else if (process.platform === "win32") {
    if (!artifact.endsWith(".exe")) throw new Error("Windows installer qualification requires an .exe.");
    const installDirectory = path.join(disposable, "Programs", "Ponderosa Beta");
    run(artifact, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", `/DIR=${installDirectory}`]);
    installedRoot = installDirectory;
    uninstall = () => {
      const uninstaller = readdirSync(installDirectory)
        .find((name) => /^unins\d+\.exe$/iu.test(name));
      if (!uninstaller) throw new Error("Inno Setup uninstaller was not installed.");
      run(path.join(installDirectory, uninstaller), ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"]);
    };
    installed = true;
  } else {
    throw new Error(`Unsupported installer qualification host: ${process.platform}/${process.arch}`);
  }

  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  const nativeReport = path.join(disposable, "native-bundle-report.json");
  run(path.join(installedRoot, "runtime", nodeName), [
    path.join(installedRoot, "qualification", "verify-installed-bundle.mjs"),
    "--install-root", installedRoot,
    "--report", nativeReport,
  ]);
  const nativeQualification = JSON.parse(readFileSync(nativeReport, "utf8"));
  const lifecycleReportPath = path.join(disposable, "launcher-lifecycle-report.json");
  run(path.join(installedRoot, "runtime", nodeName), [
    path.join(installedRoot, "qualification", "qualify-launcher-lifecycle.mjs"),
    "--install-root", installedRoot,
    "--data-dir", path.join(disposable, "Ponderosa Data"),
    "--report", lifecycleReportPath,
  ]);
  const lifecycleQualification = JSON.parse(readFileSync(lifecycleReportPath, "utf8"));
  uninstall();
  removed = true;
  if (!existsSync(projectSentinel)) throw new Error("Installer removal deleted the selected Project source folder.");
  if (!existsSync(dataSentinel)) throw new Error("Installer removal deleted Ponderosa user data.");

  const report = {
    ...nativeQualification,
    qualification: "native-installed-artifact",
    artifact: path.basename(artifact),
    checks: [
      ...nativeQualification.checks,
      ...lifecycleQualification.checks,
      {
        id: "install-without-checkout",
        status: "pass",
        detail: "qualified runtime and application bytes from the platform installer staging location",
      },
      {
        id: "uninstall-preserves-data",
        status: "pass",
        detail: "uninstall preserved a disposable Ponderosa data sentinel and selected Project source folder",
      },
    ],
    releaseQualified: lifecycleQualification.releaseQualified,
    releaseBlockers: lifecycleQualification.releaseBlockers,
  };
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`Installed-artifact qualification passed; report=${reportPath}\n`);
} finally {
  if (installed && !removed) {
    try { uninstall(); } catch { /* preserve the primary qualification failure */ }
  }
  if (mounted) {
    try { run("hdiutil", ["detach", mounted]); } catch { /* preserve the primary qualification failure */ }
  }
  rmSync(dataSentinelDirectory, { recursive: true, force: true });
  rmSync(disposable, { recursive: true, force: true });
}

#!/usr/bin/env node
import {
  createOfflineDataDirectoryBackup,
  restoreOfflineDataDirectoryBackup,
} from "@ponderosa/agents";

const [command, ...args] = process.argv.slice(2);
const value = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const dataDir = value("--data-dir");
if (!dataDir) throw new Error("--data-dir is required");

if (command === "backup") {
  const output = value("--output");
  if (!output) throw new Error("--output is required");
  const externalProjects = value("--external-projects");
  if (externalProjects !== "copy" && externalProjects !== "exclude") {
    throw new Error("--external-projects must be explicitly set to copy or exclude");
  }
  const manifest = createOfflineDataDirectoryBackup(dataDir, output, { externalProjects });
  console.log(JSON.stringify({ status: "created", output, files: manifest.entries.filter(entry => entry.type === "file").length }));
} else if (command === "restore") {
  const backup = value("--backup");
  if (!backup) throw new Error("--backup is required");
  const manifest = restoreOfflineDataDirectoryBackup(backup, dataDir, {
    restoreExternalProjects: args.includes("--restore-external-projects"),
    externalRootParent: value("--external-project-root"),
  });
  console.log(JSON.stringify({ status: "restored", dataDir, files: manifest.entries.filter(entry => entry.type === "file").length }));
} else {
  throw new Error("usage: data-directory.mjs backup --data-dir PATH --output PATH --external-projects copy|exclude | restore --backup PATH --data-dir PATH [--restore-external-projects] [--external-project-root PATH]");
}

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isDirectInvocation, parseArguments } from "./cli.js";

describe("launcher CLI entry identity", () => {
  const disposable: string[] = [];

  afterEach(() => {
    for (const directory of disposable.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recognizes the direct module path", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ponderosa-cli-direct-"));
    disposable.push(directory);
    const entry = path.join(directory, "cli.js");
    writeFileSync(entry, "");

    expect(isDirectInvocation(entry, pathToFileURL(entry).href)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("recognizes an equivalent symlinked parent path", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ponderosa-cli-symlink-"));
    disposable.push(directory);
    const realDirectory = path.join(directory, "real");
    const aliasDirectory = path.join(directory, "alias");
    mkdirSync(realDirectory);
    const realEntry = path.join(realDirectory, "cli.js");
    writeFileSync(realEntry, "");
    symlinkSync(realDirectory, aliasDirectory, "dir");

    expect(isDirectInvocation(
      path.join(aliasDirectory, "cli.js"),
      pathToFileURL(realEntry).href,
    )).toBe(true);
  });

  it("rejects a different entry path", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ponderosa-cli-other-"));
    disposable.push(directory);
    const entry = path.join(directory, "cli.js");
    const other = path.join(directory, "other.js");
    writeFileSync(entry, "");
    writeFileSync(other, "");

    expect(isDirectInvocation(other, pathToFileURL(entry).href)).toBe(false);
  });

  it("recognizes the Engine dashboard command", () => {
    expect(parseArguments(["engine"])).toMatchObject({
      command: "engine",
      openBrowser: true,
    });
  });
});

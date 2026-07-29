import assert from "node:assert/strict";
import test from "node:test";
import {
  MACOS_GUI_PATH,
  macosLauncherEntry,
} from "./macos-gui-entry.mjs";

test("macOS packaged entry sanitizes GUI PATH and forwards explicit qualification arguments", () => {
  const entry = macosLauncherEntry();
  assert.match(entry, new RegExp(`PATH="${MACOS_GUI_PATH.replaceAll("/", "\\/")}"`, "u"));
  assert.match(entry, /open --install-root "\$ROOT" "\$@"/u);
  assert.doesNotMatch(entry, /opt\/homebrew/u);
});

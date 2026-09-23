import assert from "node:assert/strict";
import test from "node:test";
import {
  browserDockIsAvailable,
  clampBrowserDockWidth,
  maximumBrowserDockWidth,
} from "../src/components/browser/browserWindowSizing.js";

test("browser docking preserves the workspace shell and a usable Chat width", () => {
  assert.equal(browserDockIsAvailable(1280), false);
  assert.equal(browserDockIsAvailable(1399), false);
  assert.equal(browserDockIsAvailable(1400), true);
  assert.equal(maximumBrowserDockWidth(1400), 360);
  assert.equal(clampBrowserDockWidth(720, 1400), 360);
  assert.equal(clampBrowserDockWidth(900, 1920), 880);
});

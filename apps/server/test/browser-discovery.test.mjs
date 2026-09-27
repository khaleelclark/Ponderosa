import assert from "node:assert/strict";
import test from "node:test";
import { findBrowserExecutable } from "../dist/chrome-cdp-driver.js";

test("host browser discovery accepts standard macOS applications and explicit overrides", () => {
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const local = "/Users/operator/Applications/Chromium.app/Contents/MacOS/Chromium";
  assert.equal(findBrowserExecutable("", { platform: "darwin", home: "/Users/operator", exists: value => value === chrome }), chrome);
  assert.equal(findBrowserExecutable("", { platform: "darwin", home: "/Users/operator", exists: value => value === local }), local);
  assert.equal(findBrowserExecutable("/custom/chrome", { platform: "darwin", exists: value => value === "/custom/chrome" || value === chrome }), "/custom/chrome");
});

test("host browser discovery accepts Windows machine and user installations", () => {
  const env = { PROGRAMFILES: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\operator\\AppData\\Local" };
  const machine = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const user = "C:\\Users\\operator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
  assert.equal(findBrowserExecutable("", { platform: "win32", env, exists: value => value === machine }), machine);
  assert.equal(findBrowserExecutable("", { platform: "win32", env, exists: value => value === user }), user);
  assert.equal(findBrowserExecutable("C:\\custom\\chrome.exe", { platform: "win32", env, exists: value => value === "C:\\custom\\chrome.exe" || value === machine }), "C:\\custom\\chrome.exe");
});

test("Linux browser discovery retains the existing paths", () => {
  assert.equal(findBrowserExecutable("", { platform: "linux", exists: value => value === "/usr/bin/google-chrome" }), "/usr/bin/google-chrome");
});

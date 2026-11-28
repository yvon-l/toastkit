// The Firefox build's manifest: same extension, with what Firefox needs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { firefoxManifest, FIREFOX_ID, FIREFOX_DESCRIPTION } from "../scripts/package.mjs";

const EXT = join(dirname(fileURLToPath(import.meta.url)), "..");
const chrome = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
const ff = firefoxManifest(chrome);

test("Firefox runs background.js as a background script", () => {
  assert.deepEqual(ff.background, { scripts: ["background.js"] });
});

test("Firefox gets an add-on ID and says no data is collected", () => {
  assert.equal(ff.browser_specific_settings.gecko.id, FIREFOX_ID);
  assert.deepEqual(ff.browser_specific_settings.gecko.data_collection_permissions, { required: ["none"] });
});

test("Firefox doesn't ask for contentSettings, which it doesn't have", () => {
  assert.ok(!ff.permissions.includes("contentSettings"));
  assert.deepEqual(ff.permissions, chrome.permissions.filter(p => p !== "contentSettings"));
});

test("the Firefox description only promises what Firefox can do", () => {
  assert.equal(ff.description, FIREFOX_DESCRIPTION);
  assert.ok(!/permission|cache/i.test(ff.description));
  assert.ok(ff.description.length <= 132);
});

test("everything else matches the Chrome manifest", () => {
  for (const k of ["name", "version", "manifest_version", "icons", "action", "host_permissions", "commands"]) {
    assert.deepEqual(ff[k], chrome[k], k);
  }
});

test("the Chrome manifest is left unchanged", () => {
  assert.equal(chrome.background.service_worker, "background.js");
  assert.ok(chrome.permissions.includes("contentSettings"));
  assert.ok(!("browser_specific_settings" in chrome));
});

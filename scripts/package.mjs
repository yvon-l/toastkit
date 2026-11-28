// Builds the store zips in dist/: one for the Chrome Web Store and one for
// Firefox Add-ons. The code is the same in both; only the manifest differs.
//
//   node scripts/package.mjs
//
// Needs the zip command (macOS and most Linux systems have it).
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = ["manifest.json", "background.js", "popup.html", "popup.js", "icons", "LICENSE"];

export const FIREFOX_ID = "toastkit@kimberly-wood.com";
export const FIREFOX_DESCRIPTION = "Clear cookies, storage and service workers for the current site. Everything else in your browser stays untouched.";

// Firefox runs background code as a background script, not a service worker,
// and needs an add-on ID and a statement that the extension collects no data.
// It has no contentSettings API, so that permission is left out, and it
// needs scripting to clear storage exactly for the page's origin. Desktop only:
// the toolbar popup and Alt+T are what ToastKit is.
export function firefoxManifest(chrome) {
  const m = structuredClone(chrome);
  delete m.minimum_chrome_version;
  // scripting clears storage from inside the page (see background.js).
  m.permissions = [...m.permissions.filter(p => p !== "contentSettings"), "scripting"];
  m.description = FIREFOX_DESCRIPTION;
  m.background = { scripts: ["background.js"] };
  m.browser_specific_settings = {
    gecko: {
      id: FIREFOX_ID,
      strict_min_version: "140.0",
      data_collection_permissions: { required: ["none"] }
    }
  };
  return m;
}

function build(name, manifest) {
  const dir = mkdtempSync(join(tmpdir(), "toastkit-"));
  try {
    for (const f of FILES) cpSync(join(ROOT, f), join(dir, f), { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    const out = join(ROOT, "dist", name);
    rmSync(out, { force: true });
    execFileSync("zip", ["-q", "-r", "-X", out, ...FILES], { cwd: dir });
    console.log("dist/" + name);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const chrome = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  mkdirSync(join(ROOT, "dist"), { recursive: true });
  build(`toastkit-${chrome.version}-chrome.zip`, chrome);
  build(`toastkit-${chrome.version}-firefox.zip`, firefoxManifest(chrome));
}

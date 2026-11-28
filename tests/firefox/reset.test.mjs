// End-to-end tests in real Firefox: the Firefox build, and a local server
// answering, as Firefox's proxy, for made-up sites (site.test, sub.site.test,
// other.test), so their addresses have no port, like real sites.
// Needs Firefox and geckodriver (GitHub's Ubuntu runners have both); skipped
// where Firefox isn't installed.
//
//   npm run test:firefox
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Builder } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { FIREFOX_ID } from "../../scripts/package.mjs";

const EXT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function which(cmd) {
  try { return execFileSync("which", [cmd], { encoding: "utf8" }).trim() || null; } catch { return null; }
}

const FIREFOX = process.env.FIREFOX_BIN || which("firefox");
const GECKODRIVER = process.env.GECKOWEBDRIVER ? join(process.env.GECKOWEBDRIVER, "geckodriver") : which("geckodriver");
const skip = !FIREFOX || !GECKODRIVER ? "Firefox or geckodriver not installed" : false;

const UUID = "7d0c2f4e-1a3b-4c5d-8e9f-0a1b2c3d4e5f";
const POPUP = `moz-extension://${UUID}/popup.html`;
const version = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8")).version;
const XPI = join(EXT, "dist", `toastkit-${version}-firefox.zip`);
const HOSTS = ["site.test", "sub.site.test", "other.test"];

let server, port, driver, webTab, helperTab, activeTab;
const pause = ms => new Promise(r => setTimeout(r, ms));
const url = host => `http://${host}/`;

before(async () => {
  if (skip) return;
  execFileSync("node", [join(EXT, "scripts", "package.mjs")]);
  assert.ok(existsSync(XPI));
  server = http.createServer((req, res) => {
    // As a proxy it's asked for whole addresses: http://site.test/sw.js
    if (new URL(req.url, "http://proxy/").pathname === "/sw.js") {
      res.setHeader("Content-Type", "text/javascript");
      return res.end("self.addEventListener('fetch', () => {});");
    }
    res.setHeader("Content-Type", "text/html");
    res.end("<!doctype html><html><body>site</body></html>");
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  const options = new firefox.Options()
    .setBinary(FIREFOX)
    .addArguments("-headless")
    // A fixed internal ID, so the tests know the extension's page addresses.
    .setPreference("extensions.webextensions.uuids", JSON.stringify({ [FIREFOX_ID]: UUID }))
    // Every http request goes to the test server, and the made-up sites count
    // as secure so they can use Cache Storage and service workers over http.
    .setPreference("network.proxy.type", 1)
    .setPreference("network.proxy.http", "127.0.0.1")
    .setPreference("network.proxy.http_port", port)
    .setPreference("network.proxy.no_proxies_on", "")
    .setPreference("dom.securecontext.allowlist", HOSTS.join(","))
    .setPreference("dom.serviceWorkers.testing.enabled", true)
    .setPreference("privacy.userContext.enabled", true);
  driver = await new Builder()
    .forBrowser("firefox")
    .setFirefoxOptions(options)
    .setFirefoxService(new firefox.ServiceBuilder(GECKODRIVER).addArguments("--allow-system-access"))
    .build();
  await driver.installAddon(XPI, true);
  await pause(1000);
  webTab = activeTab = await driver.getWindowHandle();
  // An extension page that stays open, used to talk to the extension.
  const known = new Set(await driver.getAllWindowHandles());
  await openTab(POPUP);
  await pause(1000);
  helperTab = (await driver.getAllWindowHandles()).find(h => !known.has(h));
  assert.ok(helperTab, "extension page opened");
  await driver.switchTo().window(webTab);
});

after(async () => {
  await driver?.quit();
  server?.close();
});

// Open a tab without selecting it, so the test page stays the active tab.
// geckodriver won't navigate to extension pages itself, so the browser does it.
async function openTab(address, { userContextId = 0, select = false } = {}) {
  driver.setContext(firefox.Context.CHROME);
  try {
    await driver.executeScript(`const t = gBrowser.addTab(arguments[0], {
      userContextId: arguments[1],
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      if (arguments[2]) gBrowser.selectedTab = t;`, address, userContextId, select);
  } finally {
    driver.setContext(firefox.Context.CONTENT);
  }
}

// Make a tab the browser's selected one without moving Selenium out of the
// window it's in. Window handles are the remote agent's IDs for each tab's browser.
async function selectInBrowser(handle) {
  driver.setContext(firefox.Context.CHROME);
  try {
    await driver.executeScript(`let idOf = null, seen = [];
      for (const [path, name] of [
        ["chrome://remote/content/shared/NavigableManager.sys.mjs", "NavigableManager"],
        ["chrome://remote/content/shared/TabManager.sys.mjs", "TabManager"]]) {
        try {
          const M = ChromeUtils.importESModule(path)[name];
          seen.push(name + ": " + Object.getOwnPropertyNames(M).join(" "));
          if (typeof M.getIdForBrowser === "function") { idOf = b => M.getIdForBrowser(b); break; }
        } catch (e) { seen.push(name + ": " + e); }
      }
      if (!idOf) throw new Error("no way to read window handles. " + seen.join(" | "));
      const t = [...gBrowser.tabs].find(t => idOf(t.linkedBrowser) === arguments[0]);
      if (!t) throw new Error("no tab for handle " + arguments[0]);
      gBrowser.selectedTab = t;`, handle);
  } finally {
    driver.setContext(firefox.Context.CONTENT);
  }
}

// The tab a reset should act on: the active one, and the one Selenium is in.
async function useTab(handle) {
  activeTab = handle;
  await driver.switchTo().window(handle);
}

async function goto(host) {
  await useTab(webTab);
  await driver.get(url(host));
  await pause(300);
}

function inPage(fn, ...args) {
  return driver.executeAsyncScript(
    `const done = arguments[arguments.length - 1];
     (${fn}).apply(null, Array.from(arguments).slice(0, -1)).then(done, e => done({ error: String(e) }));`,
    ...args);
}

// Run code in the extension's own page, with the test's tab still the active
// one (switching windows in Selenium selects the tab, so it's put back first).
async function inHelper(fn, ...args) {
  await driver.switchTo().window(helperTab);
  await selectInBrowser(activeTab);
  const out = await inPage(fn, ...args);
  await driver.switchTo().window(activeTab);
  return out;
}

// Everything a reset can clear, on the current page.
const seed = (withSW) => inPage(async (withSW) => {
  document.cookie = "a=1; path=/";
  document.cookie = "b=2; path=/";
  localStorage.setItem("k", "v");
  await new Promise((resolve, reject) => {
    const r = indexedDB.open("tk", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("s");
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const tx = r.result.transaction("s", "readwrite");
      tx.objectStore("s").put("v", "k");
      tx.oncomplete = () => { r.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  });
  await (await caches.open("tk")).put("/x", new Response("v"));
  if (withSW) {
    await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
  }
  return "ok";
}, withSW);

const read = () => inPage(async () => ({
  cookie: document.cookie,
  localStorage: localStorage.getItem("k"),
  indexedDB: (await indexedDB.databases()).some(d => d.name === "tk"),
  cacheStorage: await caches.has("tk"),
  serviceWorkers: (await navigator.serviceWorker.getRegistrations()).length,
}));

async function stateOf(host) {
  await goto(host);
  return read();
}

const reset = payload => inHelper(p => chrome.runtime.sendMessage({ type: "RESET_NOW", payload: p }), payload);
const DARK = { scope: "origin", wipeCookies: true, wipeStorage: true, wipeSW: true, wipePerms: true };
const FULL = { cookie: "a=1; b=2", localStorage: "v", indexedDB: true, cacheStorage: true, serviceWorkers: 1 };
const EMPTY = { cookie: "", localStorage: null, indexedDB: false, cacheStorage: false, serviceWorkers: 0 };

test("Dark clears one site in Firefox and leaves another site alone", { skip }, async () => {
  for (const h of HOSTS) { await goto(h); assert.equal(await seed(true), "ok", h); }
  await goto("site.test");
  const r = await reset(DARK);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.origin, "http://site.test");
  assert.equal(r.cookies.cleared, 2);
  assert.equal(r.perms.ran, false, "Firefox can't reset permissions, so it doesn't claim to");
  await pause(1000);
  const after = {};
  for (const h of HOSTS) after[h] = await stateOf(h);
  console.log("# state after Dark on site.test: " + JSON.stringify(after));
  assert.deepEqual(after["site.test"], EMPTY);
  assert.deepEqual(after["other.test"], FULL);
  // A subdomain is its own site: current site only leaves it alone.
  assert.deepEqual(after["sub.site.test"], FULL);
});

test("current site only keeps the port in Firefox, for storage", { skip }, async () => {
  await goto("other.test");
  await seed(false);
  await goto("other.test:8080");
  assert.equal(await seed(false), "ok");
  const r = await reset(DARK);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.origin, "http://other.test:8080");
  await pause(1000);
  const ported = await stateOf("other.test:8080");
  const plain = await stateOf("other.test");
  console.log("# with a port: " + JSON.stringify({ ported, plain }));
  assert.deepEqual(ported, EMPTY);
  // Cookies ignore ports, so those go on both. Storage is the origin's own.
  assert.equal(plain.cookie, "");
  assert.equal(plain.localStorage, "v");
  assert.equal(plain.indexedDB, true);
  assert.equal(plain.cacheStorage, true);
});

test("Light clears cookies and keeps storage in Firefox", { skip }, async () => {
  await goto("other.test");
  const r = await reset({ scope: "origin", wipeCookies: true, wipeStorage: false, wipeSW: false, wipePerms: false });
  assert.equal(r.ok, true, JSON.stringify(r));
  await pause(500);
  const s = await stateOf("other.test");
  assert.equal(s.cookie, "");
  assert.equal(s.localStorage, "v");
  assert.equal(s.indexedDB, true);
});

test("the wider scope clears the parent domain and its usual subdomains in Firefox", { skip }, async () => {
  for (const h of ["site.test", "sub.site.test"]) { await goto(h); assert.equal(await seed(false), "ok", h); }
  // site.test has no public suffix with a dot, so the base domain is site.test.
  await goto("sub.site.test");
  const r = await reset({ ...DARK, scope: "family" });
  assert.equal(r.ok, true, JSON.stringify(r));
  await pause(1000);
  const s = await stateOf("site.test");
  const sub = await stateOf("sub.site.test");
  console.log("# wider scope from sub.site.test: " + JSON.stringify({ "site.test": s, "sub.site.test": sub }));
  assert.deepEqual(sub, EMPTY);
  // The parent domain is cleared by host name, which Firefox does for
  // localStorage and IndexedDB but not Cache Storage.
  assert.equal(s.cookie, "");
  assert.equal(s.localStorage, null);
  assert.equal(s.indexedDB, false);
});

test("a container tab's cookies are cleared, and the same site outside it is left alone", { skip }, async () => {
  await goto("other.test");
  await seed(false);
  const known = new Set(await driver.getAllWindowHandles());
  await openTab(url("other.test"), { userContextId: 1, select: true });
  await pause(1000);
  const boxTab = (await driver.getAllWindowHandles()).find(h => !known.has(h));
  await useTab(boxTab);
  await inPage(async () => { document.cookie = "boxed=1; path=/"; return "ok"; });
  const r = await reset({ scope: "origin", wipeCookies: true, wipeStorage: false, wipeSW: false, wipePerms: false });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.cookies.cleared, 1);
  await driver.navigate().refresh();
  assert.equal(await inPage(async () => document.cookie), "");
  await driver.close();
  const s = await stateOf("other.test");
  assert.equal(s.cookie, "a=1; b=2");
});

test("the popup leaves out what Firefox can't do", { skip }, async () => {
  await goto("other.test");
  const r = await inHelper(async () => {
    const d = document;
    return {
      permsHidden: d.getElementById("permsRow").classList.contains("hidden"),
      settingsHidden: d.getElementById("siteSettings").classList.contains("hidden"),
      dark: d.getElementById("darkLabel").textContent,
      grantHidden: d.getElementById("grantBtn").classList.contains("hidden"),
      version: d.getElementById("versionLabel").textContent,
    };
  });
  assert.deepEqual(r, {
    permsHidden: true,
    settingsHidden: true,
    dark: "Dark — cookies + storage + service workers",
    grantHidden: true,
    version: "v" + version,
  });
});

test("pages that aren't websites are refused in Firefox", { skip }, async () => {
  await useTab(webTab);
  await driver.get("about:blank");
  const r = await reset(DARK);
  assert.equal(r.ok, false);
  assert.match(r.error, /Unsupported URL/);
});

// Last, because access can only be given back from a click.
test("without access to websites it says so instead of claiming a reset", { skip }, async () => {
  await goto("other.test");
  await seed(false);
  const removed = await inHelper(() => chrome.permissions.remove({ origins: chrome.runtime.getManifest().host_permissions }));
  assert.equal(removed, true);
  const r = await reset(DARK);
  assert.equal(r.ok, false);
  assert.equal(r.error, "No site access");
  const s = await read();
  assert.equal(s.cookie, "a=1; b=2", "nothing was cleared");
  const shown = await inHelper(async () => {
    document.getElementById("run").click();
    await new Promise(r => setTimeout(r, 1000));
    return {
      grantShown: !document.getElementById("grantBtn").classList.contains("hidden"),
      text: document.getElementById("stats").textContent.replace(/\s+/g, " ").trim(),
    };
  });
  assert.equal(shown.grantShown, true);
  assert.match(shown.text, /can't reach this site/);
});

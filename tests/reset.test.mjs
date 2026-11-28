// End-to-end: real Chromium with ToastKit loaded, two local "sites" on different hosts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const EXT = join(dirname(fileURLToPath(import.meta.url)), "..");
let server, port, ctx, helper, siteA, siteB;

before(async () => {
  server = http.createServer((req, res) => { res.setHeader("Content-Type", "text/html"); res.end("<html><body>site</body></html>"); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "tk-")), {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  helper = await ctx.newPage();
  await helper.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
  // Two sites on a port, like dev servers: 127.0.0.1 (the one we reset) and localhost (left alone).
  siteB = await ctx.newPage();
  await siteB.goto(`http://localhost:${port}/`);
  siteA = ctx.pages()[0];
  await siteA.goto(`http://127.0.0.1:${port}/`);
});
after(async () => { await ctx?.close(); server?.close(); });

const seed = page => page.evaluate(() => {
  document.cookie = "a=1; path=/";
  document.cookie = "b=2; path=/";
  localStorage.setItem("k", "v");
});
const reset = payload => helper.evaluate(p => new Promise(r => chrome.runtime.sendMessage({ type: "RESET_NOW", payload: p }, r)), payload);

test("doesn't ask for the tabs permission", () => {
  const m = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
  assert.ok(!m.permissions.includes("tabs"));
});

test("a reset clears cookies and storage for one site with a port, and leaves other sites alone", async () => {
  await seed(siteA);
  await seed(siteB);
  await siteA.bringToFront();
  const r = await reset({ scope: "origin", wipeCookies: true, wipeStorage: true, wipeSW: true, wipePerms: true });
  assert.equal(r.ok, true);
  assert.equal(r.origin, `http://127.0.0.1:${port}`);
  assert.equal(r.cookies.cleared, 2);

  await siteA.waitForTimeout(800);
  await siteA.reload();
  assert.equal(await siteA.evaluate(() => document.cookie), "");
  assert.equal(await siteA.evaluate(() => localStorage.getItem("k")), null);

  assert.equal(await siteB.evaluate(() => document.cookie), "a=1; b=2");
  assert.equal(await siteB.evaluate(() => localStorage.getItem("k")), "v");
});

test("Light clears cookies and keeps storage", async () => {
  await seed(siteA);
  await siteA.bringToFront();
  await reset({ scope: "origin", wipeCookies: true, wipeStorage: false, wipeSW: false, wipePerms: false });
  await siteA.reload();
  assert.equal(await siteA.evaluate(() => document.cookie), "");
  assert.equal(await siteA.evaluate(() => localStorage.getItem("k")), "v");
});

test("pages that aren't websites are refused", async () => {
  await siteA.goto("about:blank");
  await siteA.bringToFront();
  const r = await reset({ scope: "origin", wipeCookies: true });
  assert.equal(r.ok, false);
  await siteA.goto(`http://127.0.0.1:${port}/`);
});

test("the popup offers permissions and site settings in Chrome", async () => {
  const r = await helper.evaluate(() => ({
    permsHidden: document.getElementById("permsRow").classList.contains("hidden"),
    settingsHidden: document.getElementById("siteSettings").classList.contains("hidden"),
    grantHidden: document.getElementById("grantBtn").classList.contains("hidden"),
  }));
  assert.deepEqual(r, { permsHidden: false, settingsHidden: false, grantHidden: true });
});

test("the popup reports a reset as text", async () => {
  await siteA.bringToFront();
  const r = await helper.evaluate(async () => {
    document.getElementById("run").click();
    await new Promise(r => setTimeout(r, 1000));
    const s = document.getElementById("stats");
    return { lines: [...s.children].map(e => e.textContent), tags: [...s.querySelectorAll("*")].map(e => e.tagName) };
  });
  assert.equal(r.lines[0], `Toasted Cleaned: http://127.0.0.1:${port}`);
  assert.match(r.lines[1], /^Level: light · Wiped: cookies \(\d+\/\d+\) · scope: current site$/);
  assert.deepEqual(r.tags, ["DIV", "SPAN", "STRONG", "DIV"]);
});

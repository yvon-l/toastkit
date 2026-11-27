// Which origins a reset touches, for each scope. Runs the functions from background.js directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "background.js"), "utf8");
const grab = name => {
  const i = src.indexOf("function " + name);
  let depth = 0;
  for (let k = src.indexOf("{", i); k < src.length; k++) {
    if (src[k] === "{") depth++;
    if (src[k] === "}" && --depth === 0) return src.slice(i, k + 1);
  }
};
const second = src.slice(src.indexOf("const SECOND_LEVEL"), src.indexOf(";", src.indexOf("const SECOND_LEVEL")) + 1);
const { getBaseDomain, buildTargetOrigins } =
  new Function(`${second}\n${grab("getBaseDomain")}\n${grab("buildTargetOrigins")}\nreturn { getBaseDomain, buildTargetOrigins };`)();

test("base domains", () => {
  assert.equal(getBaseDomain("mail.proton.me"), "proton.me");
  assert.equal(getBaseDomain("shop.example.co.uk"), "example.co.uk");
  assert.equal(getBaseDomain("127.0.0.1"), null);
  assert.equal(getBaseDomain("localhost"), null);
});

test("current site only keeps the port", () => {
  assert.deepEqual(buildTargetOrigins("http://localhost:3000/app", "origin"), ["http://localhost:3000"]);
});

test("the wider scope adds the parent domain and common subdomains", () => {
  assert.deepEqual(buildTargetOrigins("https://app.example.co.uk/x", "family"), [
    "https://app.example.co.uk",
    "https://example.co.uk", "https://www.example.co.uk", "https://mail.example.co.uk",
    "https://account.example.co.uk", "https://auth.example.co.uk", "https://login.example.co.uk",
  ]);
});

test("the wider scope does nothing extra for IP addresses and localhost", () => {
  assert.deepEqual(buildTargetOrigins("http://127.0.0.1:8080/", "family"), ["http://127.0.0.1:8080"]);
  assert.deepEqual(buildTargetOrigins("http://localhost:3000/", "family"), ["http://localhost:3000"]);
});

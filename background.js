// background.js

// We'll keep a timer so we can revert the icon after we show the burnt/flame icon.
let iconResetTimerId = null;

// Firefox has the same extension APIs under chrome.*, with a few differences
// handled below: storage is cleared by host name rather than origin, cookies
// can live in containers or be isolated by first-party domain, and there is no
// API for resetting a site's permissions.
const FIREFOX = typeof browser !== "undefined" && typeof browser.runtime?.getBrowserInfo === "function";
const CAN_RESET_PERMS = typeof chrome.contentSettings !== "undefined";

// ----------------------
// Utility: get active tab
// ----------------------
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ----------------------
// Helpers: URL / origin / domain
// ----------------------
function getOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function getHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// "Base domain": the registrable part of a hostname, e.g. mail.proton.me -> proton.me.
// Handles common two-part country suffixes (example.co.uk -> example.co.uk).
// Returns null for IP addresses and single-label hosts like localhost, where
// there is no family of subdomains to clear.
const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "ac", "edu", "ne", "or", "go"]);

function getBaseDomain(hostname) {
  if (!hostname) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":")) return null; // IPv4 / IPv6
  const parts = hostname.split(".");
  if (parts.length < 2) return null;
  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  const take = tld.length === 2 && SECOND_LEVEL.has(sld) && parts.length >= 3 ? 3 : 2;
  return parts.slice(-take).join(".");
}

// Build a list of relevant origins based on scope choice:
// scope === "origin": just the active tab's exact origin (including any port)
// scope === "family": active origin, base domain, and some common sibling subdomains
function buildTargetOrigins(tabUrl, scope) {
  const urlObj = new URL(tabUrl);
  const protocol = urlObj.protocol;               // "https:"
  const port = urlObj.port ? `:${urlObj.port}` : ""; // keep dev-server ports
  const base = getBaseDomain(urlObj.hostname);    // "proton.me"

  const origins = new Set();

  // always include the exact origin
  origins.add(urlObj.origin);

  if (scope === "family" && base) {
    for (const sub of ["", "www.", "mail.", "account.", "auth.", "login."]) {
      origins.add(`${protocol}//${sub}${base}${port}`);
    }
  }

  return Array.from(origins);
}

function patternFromOrigin(origin) {
  return `${origin}/*`;
}

// ----------------------
// Cookies: count + clear
// We try multiple candidate origins and cookie domains.
// ----------------------
async function getCookiesForOrigin(origin, storeId) {
  const query = { url: origin };
  if (storeId) query.storeId = storeId;
  // In Firefox, null matches cookies whatever their first-party domain, so
  // first-party isolation doesn't hide them. Chrome doesn't know the field.
  if (FIREFOX) query.firstPartyDomain = null;
  try {
    const cookies = await chrome.cookies.getAll(query);
    return cookies || [];
  } catch {
    return [];
  }
}

function cookieRemovalUrlFromCookie(cookie, fallbackOrigin) {
  // cookie.domain might start with ".proton.me". We want a valid URL host.
  let hostFromCookie = cookie.domain || "";
  hostFromCookie = hostFromCookie.replace(/^\./, ""); // strip leading dot

  try {
    const u = new URL(fallbackOrigin);
    // Prefer cookie's domain if possible, keep protocol from fallbackOrigin
    if (hostFromCookie) {
      return `${u.protocol}//${hostFromCookie}${cookie.path || "/"}`;
    }
  } catch {
    // ignore
  }

  // fallback to just origin + cookie.path
  return `${fallbackOrigin}${cookie.path || "/"}`;
}

async function clearCookiesForOrigins(origins, storeId) {
  let totalBefore = 0;
  let totalCleared = 0;

  // collect all cookies across candidate origins and dedupe
  const cookieKey = c => `${c.domain}|${c.path}|${c.name}|${c.storeId || ""}|${c.firstPartyDomain || ""}|${JSON.stringify(c.partitionKey || null)}`;
  const allCookiesMap = new Map();

  for (const origin of origins) {
    const cookies = await getCookiesForOrigin(origin, storeId);
    for (const c of cookies) {
      totalBefore++;
      allCookiesMap.set(cookieKey(c), { cookie: c, origin });
    }
  }

  // attempt removal for each unique cookie
  for (const { cookie, origin } of allCookiesMap.values()) {
    const removalUrl = cookieRemovalUrlFromCookie(cookie, origin);
    try {
      const details = { url: removalUrl, name: cookie.name, storeId: cookie.storeId };
      if (FIREFOX) details.firstPartyDomain = cookie.firstPartyDomain || "";
      if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
      const res = await chrome.cookies.remove(details);
      if (res) {
        totalCleared++;
      }
    } catch {
      // ignore failures for special cookies
    }
  }

  return { before: totalBefore, cleared: totalCleared };
}

// ----------------------
// Storage + service workers clearing
// We'll call browsingData.remove() on each target origin.
// ----------------------
// Firefox takes host names, not origins, and only for some data types:
// localStorage, IndexedDB and service workers. A host name covers every
// scheme and port of that host.
function firefoxHostnames(origins) {
  const hosts = new Set();
  for (const o of origins) {
    const h = getHostname(o);
    if (h) hosts.add(h.replace(/^\[|\]$/g, ""));
  }
  return Array.from(hosts);
}

async function clearStorageAndSWFirefox(origins, opts) {
  const dataToRemove = {};
  if (opts.storage) {
    dataToRemove.localStorage = true;
    dataToRemove.indexedDB = true;
  }
  if (opts.serviceWorkers) dataToRemove.serviceWorkers = true;
  if (Object.keys(dataToRemove).length) {
    await chrome.browsingData.remove({ hostnames: firefoxHostnames(origins) }, dataToRemove);
  }
  return { storageCleared: !!opts.storage, swCleared: !!opts.serviceWorkers };
}

async function clearStorageAndSW(origins, opts) {
  // opts: { storage:boolean, serviceWorkers:boolean }
  if (FIREFOX) return clearStorageAndSWFirefox(origins, opts);
  let storageRan = false;
  let swRan = false;

  for (const origin of origins) {
    const removalOptions = { origins: [origin] };
    const dataToRemove = {};

    if (opts.storage) {
      storageRan = true;
      dataToRemove.indexedDB = true;
      dataToRemove.localStorage = true;
      dataToRemove.cacheStorage = true;
      dataToRemove.webSQL = true;
      dataToRemove.fileSystems = true;
    }

    if (opts.serviceWorkers) {
      swRan = true;
      dataToRemove.serviceWorkers = true;
    }

    const any = Object.values(dataToRemove).some(Boolean);
    if (any) {
      await chrome.browsingData.remove(removalOptions, dataToRemove);
    }
  }

  return {
    storageCleared: storageRan,
    swCleared: swRan
  };
}

// ----------------------
// Permission reset ("Ask again" for location, mic, camera, notifications)
// We'll set each origin pattern to "ask"
// ----------------------
function setAsk(api, pattern) {
  return new Promise(resolve =>
    api.set({ primaryPattern: pattern, setting: "ask" }, resolve)
  );
}

async function resetPermissionsForOrigins(origins) {
  let ran = false;
  if (!CAN_RESET_PERMS) return ran;
  for (const origin of origins) {
    const pat = patternFromOrigin(origin);
    await Promise.all([
      setAsk(chrome.contentSettings.location, pat),
      setAsk(chrome.contentSettings.camera, pat),
      setAsk(chrome.contentSettings.microphone, pat),
      setAsk(chrome.contentSettings.notifications, pat)
    ]);
    ran = true;
  }
  return ran;
}

// Access to the site's address, which the cookies API needs. Match patterns
// have no port, so the host is enough.
async function hasSiteAccess(url) {
  try {
    const u = new URL(url);
    return await chrome.permissions.contains({ origins: [`${u.protocol}//${u.hostname}/*`] });
  } catch {
    return false;
  }
}

// ----------------------
// Toolbar feedback
// 1. flashBadge: show a blue ✓ briefly
// 2. showToastedIcon: swap icon to flame, then revert
// ----------------------
async function flashBadge(tabId, text = "✓") {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" });
    setTimeout(() => chrome.action.setBadgeText({ tabId, text: "" }), 1200);
  } catch {
    // Some pages (chrome://) won't allow badge updates. Ignore quietly.
  }
}

function showToastedIcon() {
  if (iconResetTimerId !== null) {
    clearTimeout(iconResetTimerId);
    iconResetTimerId = null;
  }

  chrome.action.setIcon({
    path: {
      "16":  "icons/toast_burnt16.png",
      "32":  "icons/toast_burnt32.png",
      "48":  "icons/toast_burnt48.png",
      "128": "icons/toast_burnt128.png"
    }
  });

  iconResetTimerId = setTimeout(() => {
    chrome.action.setIcon({
      path: {
        "16":  "icons/toastkit_16.png",
        "32":  "icons/toastkit_32.png",
        "48":  "icons/toastkit_48.png",
        "128": "icons/toastkit_128.png"
      }
    });
    iconResetTimerId = null;
  }, 5000);
}

// ----------------------
// Core wipe
// flags = { scope, wipeCookies, wipeStorage, wipeSW, wipePerms }
// scope: "origin" | "family"
// ----------------------
async function resetCurrentSite(tab, flags) {
  if (!tab || !tab.url) throw new Error("No active tab");

  const origin = getOrigin(tab.url);
  const hostname = getHostname(tab.url);

  if (!origin || !/^https?:\/\//.test(origin)) {
    // Only websites: not chrome://, about:, moz-extension:// or file pages.
    throw new Error("Unsupported URL");
  }

  // People can take away an extension's access to websites (Firefox doesn't
  // grant it until they allow it). Without it no cookies can be read or
  // removed, so say so instead of reporting a reset that didn't happen.
  if (flags.wipeCookies && !(await hasSiteAccess(tab.url))) {
    throw new Error("No site access");
  }

  // Build the set of origins we're allowed to touch based on scope.
  const targetOrigins = buildTargetOrigins(tab.url, flags.scope || "origin");

  // 1. Cookies
  let cookiesBefore = 0;
  let cookiesCleared = 0;
  if (flags.wipeCookies) {
    // tab.cookieStoreId is Firefox's: the container or private window the tab is in.
    const cookieResult = await clearCookiesForOrigins(targetOrigins, tab.cookieStoreId);
    cookiesBefore = cookieResult.before;
    cookiesCleared = cookieResult.cleared;
  }

  // 2. Storage + service workers
  const storageResult = await clearStorageAndSW(targetOrigins, {
    storage: flags.wipeStorage,
    serviceWorkers: flags.wipeSW
  });

  // 3. Permissions reset
  let permsRan = false;
  if (flags.wipePerms && CAN_RESET_PERMS) {
    permsRan = await resetPermissionsForOrigins(targetOrigins);
  }

  // Visual toolbar feedback
  await flashBadge(tab.id, "✓");
  showToastedIcon();

  // Return structured result for popup.js
  return {
    ok: true,
    origin,
    hostname,
    scopeUsed: flags.scope || "origin",
    cookies: {
      ran: !!flags.wipeCookies,
      before: cookiesBefore,
      cleared: cookiesCleared
    },
    storage: {
      ran: !!flags.wipeStorage,
      cleared: storageResult.storageCleared
    },
    serviceWorkers: {
      ran: !!flags.wipeSW,
      cleared: storageResult.swCleared
    },
    perms: {
      ran: !!flags.wipePerms && CAN_RESET_PERMS,
      reset: permsRan
    }
  };
}

// ----------------------
// Keyboard shortcut handler
// The keyboard shortcut does a Dark reset of the current site only, as its
// description says. The wider scope can sign you out, so it stays a choice in the popup.
// ----------------------
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "reset-current-site") {
    const tab = await getActiveTab();
    try {
      await resetCurrentSite(tab, {
        scope: "origin",
        wipeCookies: true,
        wipeStorage: true,
        wipeSW: true,
        wipePerms: true
      });
    } catch (e) {
      // Nothing to do on pages that aren't websites. Without access to the
      // site, show it on the button so a shortcut press doesn't look like it worked.
      if (tab && String(e && e.message) === "No site access") await flashBadge(tab.id, "!");
    }
  }
});

// ----------------------
// Message bridge for popup.js
// popup.js calls chrome.runtime.sendMessage({ type: "RESET_NOW", payload: {...} })
// ----------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  if (msg && msg.type === "RESET_NOW") {
    (async () => {
      try {
        const tab = await getActiveTab();

        // Default to full wipe of current site only if somehow no payload is sent.
        const p = msg.payload || {};
        const flags = {
          scope: p.scope || "origin",
          wipeCookies: !!p.wipeCookies,
          wipeStorage: !!p.wipeStorage,
          wipeSW: !!p.wipeSW,
          wipePerms: !!p.wipePerms
        };

        const result = await resetCurrentSite(tab, flags);
        sendResponse(result);
      } catch (e) {
        sendResponse({
          ok: false,
          error: String(e && e.message ? e.message : e)
        });
      }
    })();
    return true; // keep channel open for async sendResponse
  }
});

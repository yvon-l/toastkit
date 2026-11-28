// The status area is built from elements with textContent, never HTML, so a
// page address or error message can't add markup.
function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

document.addEventListener("DOMContentLoaded", () => {
  const runBtn = document.getElementById("run");
  const statsEl = document.getElementById("stats");
  const showStats = (...nodes) => statsEl.replaceChildren(...nodes);
  const showError = (title, hint) => showStats(el("div", "error-line", title), ...(hint ? [el("div", "hint", hint)] : []));
  const versionLabel = document.getElementById("versionLabel");
  const siteSettingsBtn = document.getElementById("siteSettings");

  // Advanced option checkboxes
  const optCookies = document.getElementById("optCookies");
  const optStorage = document.getElementById("optStorage");
  const optSW = document.getElementById("optSW");
  const optPerms = document.getElementById("optPerms");
  const optReload = document.getElementById("optReload");

  const grantBtn = document.getElementById("grantBtn");

  // Firefox has no API for resetting a site's permissions and won't let an
  // extension open its settings pages, so those two are left out there.
  const canResetPerms = typeof chrome.contentSettings !== "undefined";
  if (!canResetPerms) {
    optPerms.checked = false;
    document.getElementById("permsRow").classList.add("hidden");
    siteSettingsBtn.classList.add("hidden");
    document.getElementById("darkLabel").textContent = "Dark — cookies + storage + service workers";
  }

  // Toast level radios (Light / Medium / Dark)
  const levelRadios = document.querySelectorAll('input[name="level"]');

  // Scope radios ("Current site only" vs "This site + all subdomains")
  const scopeRadios = document.querySelectorAll('input[name="scope"]');

  // Footer buttons
  const footerReportBtn = document.getElementById("footerReport");
  const footerWebsiteBtn = document.getElementById("footerWebsite");

  // Settings persistence
  const SETTINGS_KEY = "toastkitSettings";

  function getUiState() {
    const level =
      document.querySelector('input[name="level"]:checked')?.value || "light";

    const scope =
      document.querySelector('input[name="scope"]:checked')?.value || "origin";

    return {
      level,
      scope,
      optCookies: !!optCookies.checked,
      optStorage: !!optStorage.checked,
      optSW: !!optSW.checked,
      optPerms: canResetPerms && !!optPerms.checked,
      optReload: !!optReload.checked
    };
  }

  function setRadio(name, value) {
    const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
    if (el) el.checked = true;
  }

  function applyUiState(state) {
    if (!state) return;

    if (state.level) setRadio("level", state.level);
    if (state.scope) setRadio("scope", state.scope);

    if (typeof state.optCookies === "boolean") optCookies.checked = state.optCookies;
    if (typeof state.optStorage === "boolean") optStorage.checked = state.optStorage;
    if (typeof state.optSW === "boolean") optSW.checked = state.optSW;
    if (typeof state.optPerms === "boolean") optPerms.checked = canResetPerms && state.optPerms;
    if (typeof state.optReload === "boolean") optReload.checked = state.optReload;
  }

  async function loadSettings() {
    try {
      const res = await chrome.storage.sync.get([SETTINGS_KEY]);
      return res && res[SETTINGS_KEY] ? res[SETTINGS_KEY] : null;
    } catch (e) {
      return null;
    }
  }

  async function saveSettings() {
    try {
      await chrome.storage.sync.set({ [SETTINGS_KEY]: getUiState() });
    } catch (e) {
      // ignore
    }
  }

  // -------------------------------------------------
  // Level presets
  // -------------------------------------------------
  function applyLevelPreset(level) {
    if (level === "light") {
      optCookies.checked = true;
      optStorage.checked = false;
      optSW.checked = false;
      optPerms.checked = false;
    } else if (level === "medium") {
      optCookies.checked = true;
      optStorage.checked = true;
      optSW.checked = false;
      optPerms.checked = false;
    } else if (level === "dark") {
      optCookies.checked = true;
      optStorage.checked = true;
      optSW.checked = true;
      optPerms.checked = canResetPerms;
    }
    // We intentionally do not touch optReload here.
  }

  // When user clicks Light/Medium/Dark, update Advanced checkboxes and persist
  levelRadios.forEach(r => {
    r.addEventListener("change", async () => {
      if (r.checked) {
        applyLevelPreset(r.value);
        await saveSettings();
      }
    });
  });

  // Persist when scope or any advanced option changes
  scopeRadios.forEach(r => r.addEventListener("change", saveSettings));
  [optCookies, optStorage, optSW, optPerms, optReload].forEach(el => {
    el.addEventListener("change", saveSettings);
  });

  // Initialize UI
  (async () => {
    const saved = await loadSettings();

    if (saved) {
      applyUiState(saved);

      // If level exists but advanced options are missing, enforce presets
      const hasAnyAdvanced =
        typeof saved.optCookies === "boolean" ||
        typeof saved.optStorage === "boolean" ||
        typeof saved.optSW === "boolean" ||
        typeof saved.optPerms === "boolean";

      if (!hasAnyAdvanced && saved.level) {
        applyLevelPreset(saved.level);
      }
    } else {
      const initialLevel =
        document.querySelector('input[name="level"]:checked')?.value || "light";
      applyLevelPreset(initialLevel);
    }
  })();

  // -------------------------------------------------
  // Version in footer
  // -------------------------------------------------
  const manifest = chrome.runtime.getManifest();
  if (manifest && manifest.version && versionLabel) {
    versionLabel.textContent = "v" + manifest.version;
  }

  // -------------------------------------------------
  // Open Chrome site settings
  // -------------------------------------------------
  siteSettingsBtn.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      chrome.tabs.create({
        url: `chrome://settings/content/siteDetails?site=${encodeURIComponent(
          tab.url
        )}`
      });
    }
  });

  // -------------------------------------------------
  // Access to websites
  // Firefox doesn't give an extension access to websites until you allow it,
  // and both browsers let you take it away. Cookies can't be touched without it.
  // -------------------------------------------------
  const ALL_SITES = { origins: chrome.runtime.getManifest().host_permissions };

  function showNeedsAccess() {
    grantBtn.classList.remove("hidden");
    showError("ToastKit can't reach this site", "It needs access to websites to remove their cookies. Allow it, then toast again.");
  }

  // The request has to start straight from the click, with nothing awaited first.
  grantBtn.addEventListener("click", () => {
    chrome.permissions.request(ALL_SITES).then(granted => {
      if (!granted) return;
      grantBtn.classList.add("hidden");
      showStats(el("div", "hint", "Access allowed. Toast away."));
    }).catch(() => {
      showStats(el("div", "hint", "Couldn't ask for access."));
    });
  });

  // -------------------------------------------------
  // Toast button click
  // -------------------------------------------------
  runBtn.addEventListener("click", async () => {
    runBtn.disabled = true;
    const originalText = runBtn.textContent;
    runBtn.textContent = "Toasting...";

    // Save current intent at click time
    await saveSettings();

    const level =
      document.querySelector('input[name="level"]:checked')?.value || "light";

    const scope =
      document.querySelector('input[name="scope"]:checked')?.value || "origin";
    // "origin" (current site only) or "family" (this site + all subdomains)

    const wipeCookies = optCookies.checked;
    const wipeStorage = optStorage.checked;
    const wipeSW = optSW.checked;
    const wipePerms = optPerms.checked;
    const doReload = optReload.checked;

    try {
      const resp = await chrome.runtime.sendMessage({
        type: "RESET_NOW",
        payload: {
          scope,
          wipeCookies,
          wipeStorage,
          wipeSW,
          wipePerms
        }
      });

      if (resp && resp.ok) {
        runBtn.textContent = "Toasted ✓";

        const detailParts = [];

        if (resp.cookies && resp.cookies.ran) {
          detailParts.push(
            `cookies (${resp.cookies.cleared}/${resp.cookies.before})`
          );
        }
        if (resp.storage && resp.storage.ran) {
          detailParts.push("storage");
        }
        if (resp.serviceWorkers && resp.serviceWorkers.ran) {
          detailParts.push("service workers");
        }
        if (resp.perms && resp.perms.ran) {
          detailParts.push("permissions reset");
        }

        const wipedSummary = detailParts.length ? detailParts.join(", ") : "cookies";

        const scopeLabel =
          resp.scopeUsed === "family"
            ? "scope: this site + subdomains"
            : "scope: current site";

        const summaryLine =
          `Level: ${level} · Wiped: ${wipedSummary} · ${scopeLabel}` +
          (doReload ? " · Tab reloaded" : "");

        const head = el("div");
        head.append(el("span", "badge-flame", "Toasted"), " ", el("strong", null, "Cleaned:"), " ", String(resp.origin));
        showStats(head, el("div", "hint", summaryLine));

        if (doReload) {
          chrome.tabs.reload();
        }
      } else {
        const msg = resp && resp.error ? resp.error : "Failed";

        if (msg === "No site access") {
          runBtn.textContent = originalText;
          showNeedsAccess();
        } else if (msg.includes("Unsupported URL")) {
          runBtn.textContent = originalText;
          showError("Unsupported URL", "This page can't be toasted. Switch to a normal site (https://) and try again.");
        } else {
          runBtn.textContent = "Error";
          showError(String(msg));
        }
      }
    } catch (err) {
      const msg = err && err.message ? err.message : "Failed";
      runBtn.textContent = "Error";
      showError(String(msg));
    }

    setTimeout(() => {
      runBtn.disabled = false;
      runBtn.textContent = originalText;
    }, 1500);
  });

  // -------------------------------------------------
  // Footer links
  // -------------------------------------------------
  const BUG_URL = "https://github.com/yvon-l/toastkit/issues/new";
  const WEBSITE_URL = "https://kimberly-wood.com/tools/";

  footerReportBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: BUG_URL });
  });

  footerWebsiteBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: WEBSITE_URL });
  });
});
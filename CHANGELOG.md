# Changelog

All notable changes to ToastKit are documented here.

ToastKit uses semantic-style versioning during pre-1.0:
- PATCH (0.2.1 → 0.2.2 → 0.2.3): internal fixes, security hardening, permission changes, or non-breaking improvements
- MINOR (0.2.x → 0.3.0): new user-visible capabilities or behavior changes
- 1.0.0: first fully stable line

---

## [0.3.0] - 2026-11-27
### Added
- A Firefox version, built from the same code. `npm run package` makes the Chrome and Firefox store zips from one manifest
- In Firefox, the page's own storage is cleared from inside the page, so it's exact to the origin (port included) and covers Cache Storage, which Firefox's own API can't do by site
- In Firefox, cookies are cleared in the container or private window the tab is in, and first-party isolation doesn't hide any
- Tests that run the Firefox build in real Firefox on every push
### Changed
- If access to websites has been turned off, the popup says ToastKit can't reach the site and shows an Allow access button, instead of reporting a reset that cleared no cookies. Alt+T shows a ! on the toolbar button
- In Firefox, the popup leaves out resetting permissions and the site settings button, which Firefox doesn't let an extension do
### Security
- The popup builds what it shows from text, not HTML, so nothing from a page address or an error can become markup (it was escaped before)

## [0.2.4] - 2026-11-26
### Fixed
- Error messages in the popup are escaped before display, so a page address in an error can't inject markup
- Storage, service workers and permissions were not cleared on sites with a port in the address (like a local dev server on :3000), because the port was dropped. Cookies were fine
- The wider scope no longer treats country suffixes like .co.uk as a site, and is skipped for IP addresses and localhost
- Alt+T now resets the current site only, as its description says. It used to include the parent domain and common subdomains, which could sign you out of more than you expected
### Security
- Messages to the background script are only accepted from ToastKit itself
### Added
- Automated tests, run on every push
### Changed
- Moved to github.com/yvon-l/toastkit; popup links updated
- Full MIT license text in LICENSE
- Removed the tabs permission, which it never needed (site access already covers the current tab's address)
- Security reports go through GitHub private reporting
- Icons and README logo now have transparent corners (no white edges in the toolbar)
- Scope label now says "common subdomains", which is what it actually clears

## [0.2.3] – 2026-01-06
### Changed
- Persisted lightweight user preferences (toast level, scope, and UI options) using Chrome storage
- Removed unused permissions to align with Chrome Web Store requirements
- Narrowed host permissions to standard web URLs (`http` / `https`)
- Internal permission hygiene and review readiness improvements

### Notes
- No changes to core reset behavior
- No telemetry, tracking, or remote data access

---

## [0.2.2] – 2025-11-27
### Documentation
- Refreshed README with updated branding and visuals
- Updated repository structure for consistency

### Changed
- Updated all ToastKit icons and visual assets for improved clarity
- Refined `manifest.json` metadata and extension configuration
- Synchronized codebase with current Chrome extension best practices

---

## [0.2.1] – 2025-10-28
Security and hardening release
- Escape and sanitize DOM output in popup to prevent untrusted HTML injection
- No new permissions
- No telemetry or remote calls

---

## [0.2.0] – 2025-10-26
First public release
- Targeted site reset for a single domain or subdomains
- Clear cookies, cache, localStorage, sessionStorage, service workers, and site permissions
- Privacy policy and security contact
- Chrome Web Store submission build

---

## [Unreleased]
- Firefox build target
- Favorite domains list stored locally
- Minor UX text refinements
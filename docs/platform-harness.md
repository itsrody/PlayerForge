# Platform harness

How PlayerForge is driven against a real browser, and what the harness can and
cannot prove. Modelled on ScriptCat's `docs/develop.md` + `docs/verification.md`
+ `e2e/README.md`; deviations are called out explicitly below.

## Two tracks

| | Committed suite | Local verification |
| --- | --- | --- |
| Path | `platform/integration/*.test.mjs` | `platform/scratch/<scenario>/` (git-ignored) |
| Command | `npm run integration` | `npm run verify start <scenario>` + `npm run drive <cmd>` |
| Scope | stable regression flows | the one question in front of you |
| Output | test verdict | `<scenario>/report.md` + evidence |

The split is mechanical, not conventional: `platform/scratch/` is git-ignored and
`platform/run.mjs` only collects `*.test.mjs` from `platform/integration/`, so a
scratch script can never be collected by the suite.

## Why a session

Answering a new question costs one command instead of editing a script and
re-running the whole setup. The earlier approach — a throwaway `.mjs` per
question — meant every question re-did the launch, the `userScripts` grant and the
install, and a crash lost all of it. That cost is what produced several rounds of
guessing here.

```bash
npm run verify start real --extensions=/path/to/scriptcat/dist/ext
npm run drive extid
npm run drive goto http://127.0.0.1:PORT/player.html
npm run drive eval "document.documentElement.getAttribute('data-pf-version')"
npm run drive console 40
npm run verify stop real
```

Headless by default; `--headed` only to watch by eye. Each session takes a
kernel-allocated CDP port (`listen(0)`, never hardcoded), a throwaway profile, and
its own scenario directory, so sessions never collide. Scenario artifacts:

| File | Written by | Holds |
| --- | --- | --- |
| `.session.json` | session | ports, profile, pid — removed on stop |
| `console.log` | session, continuously | console + uncaught exceptions from **every** context, tagged with origin |
| `actions.log` | every drive call | the driving record a report quotes |
| `daemon.log` | session | launch failures |
| `shots/` | `drive shot` | screenshots, numbered in capture order |
| `public/` | you | static files served for the session |

### Commands

`extid`, `goto`, `eval`, `xeval` (extension page), `sw` (service worker),
`install <file.user.js>`, `pages`, `use <i>`, `console [n]`, `shot`.

Notes that cost real debugging time:

- `eval` uses `awaitPromise` + `returnByValue`, so `await` and object returns
  work. Exceptions are surfaced, not swallowed.
- `goto` uses CDP `Page.navigate`, **not** `location.href` — script-initiated
  navigation is refused for `chrome://` and `chrome-extension://` URLs and fails
  silently.
- The current page is tracked by CDP target **identity**, never index. The
  manager opens its own pages, which shifts indices.
- `sw` runs inside the service worker. `chrome.runtime.sendMessage` issued there
  does **not** reach the extension; anything the extension must act on goes
  through `xeval` (an extension page) instead. `install` uses that path.
- `evalAsync`-style callback injection is a trap: `ChromiumDriver#evalAsync`
  forwards no extra arguments, so `arguments[1]` is the completion callback, not
  the value you passed. Inline values as JSON literals.

## The `userScripts` grant

`userScripts` is an optional MV3 permission. On a fresh profile
`chrome.userScripts` is simply `undefined` and no userscript can inject, so every
real-manager test needs this granted first.

`platform/harness/profile.mjs` does it once per process:

1. Launch a throwaway profile, read the extension id off the browser's own target
   list (no manager-specific service-worker filename), open `chrome://extensions/`,
   wait for `chrome.developerPrivate` to be **bound** — polling the DOM element is
   not a reliable proxy — and call
   `updateExtensionConfiguration({ userScriptsAccess: true })`.
2. Close. That call reloads the extension and its own pages answer
   `ERR_BLOCKED_BY_CLIENT` while it happens.
3. The grant is persisted in the profile, so the next launch over it starts with
   `chrome.userScripts` available.

**Copy the profile this module made, never a real one.** `cloneGrantedProfile()`
copies a harness-created temp profile, which carries a valid `protection.macs`.
Copying a user's real profile omits it, and Chrome responds by deleting the
extension's files out of the copy — which then looks like "the extension vanished"
rather than the integrity failure it is. Never point the harness at a live
profile: Chrome's singleton forwards such a launch to the running instance and
the driver hangs.

Hand-seeding `user_scripts_enabled` into `Secure Preferences` does not work:
Chrome rewrites that file through its integrity protection and drops the edit.

## Observing from a path the driven surface does not share

Two harness channels exist precisely because "what the page shows" is not the
question:

- `drive sw <js>` — evaluate inside the extension service worker. This is where a
  manager's own state lives.
- `drive xeval <js>` — evaluate inside an extension page.

**Do not infer persistence from a row count in some storage store.** Chasing
ScriptCat's IndexedDB `value` store produced a confident, wrong conclusion: it
reads empty even immediately after a `GM_setValue` write that a following
`GM_getValue` reads back correctly. Assert on a round trip through the same API
that performed the write. "The store is empty" is not evidence that "the write
was lost" — those are different claims about different layers.

Cross-context capture is what makes a userscript's own diagnostics reachable at
all. `platform/harness/console-collector.mjs` attaches at the browser CDP
endpoint and auto-attaches to every target with `waitForDebuggerOnStart`, so
`document-start` output is not missed and Playwright/Selenium's page-only log
surface is irrelevant. PF's logger is `console.*` only, so without this its
`storage` errors are invisible exactly when they matter.

## Known harness constraints

- **A CSP claim needs a control, not a flag audit.** Every launch passes
  `--disable-web-security`, which looks like it should invalidate CSP results. It
  does not: with the flag present, a blob worker spawns on an unrestricted page
  (`SPAWNED`) and fails on the same page served with `worker-src 'none'`
  (`ERRORED`) — identical to a launch with the flag forced off. Treat the flag as
  irrelevant to CSP unless a control says otherwise, and treat "the flag is set,
  so the result is suspect" as the unproven claim it is. An earlier note here
  asserted the opposite without running that control; it was wrong.
- Cross-origin behaviour is not separately controlled. A checked child→parent
  window write did not succeed with the flag present, but no flag-off control was
  run for it, so the flag's effect there is unverified rather than absent.
- Headless reports input capabilities from the host, and the hosts disagree:
  headless Linux answers `(hover: hover)` and `(pointer: fine)` with false where
  headless macOS answers true. Every launch now pins desktop semantics
  (`launch({ emulatePointer: "desktop" })`), which PF depends on — it branches on
  `(pointer: coarse)` for the first-run hint and gates ~12 `(hover: hover)` /
  `(pointer: coarse)` blocks in the panel stylesheet. Pass `emulatePointer:
  "touch"` to reach the finger paths, which are otherwise untestable;
  `platform/integration/harness-environment.test.mjs` locks both so host drift
  fails loudly instead of silently changing what every UI test exercises.
- `(prefers-reduced-motion: reduce)` is **true** in headless and is not pinned,
  so `src/shared/timing.js` reports reduced motion in the suite. That is
  currently consistent across hosts, but it is implicit — a timing-sensitive
  assertion would be measuring the reduced-motion path without saying so.
- The session's static server sends only a content type. CSP, redirects and
  status codes need a server that can set headers, so those belong in a
  committed fixture rather than the session.
- The collector holds a debugger session on every target for the session's
  whole life. Do not use a session to verify service-worker eviction or idle
  termination.

## Differences from ScriptCat's harness

- **Substrate.** ScriptCat uses Playwright's `launchPersistentContext`, which
  gives `serviceWorkers()` and `addInitScript` directly. PF uses
  selenium-webdriver + chromedriver because ~4k lines of integration tests are
  written against `ChromiumDriver`. The session layer sits above that rather than
  replacing it; the swap is staged behind the existing API, not done in one pass.
- **Port split.** Selenium's `port` option is the ChromeDriver *control* port,
  while raw CDP clients need Chrome's DevTools port. The session allocates both
  and writes both to `.session.json`. Conflating them fails with `ECONNREFUSED`
  from `attachConsoleCollector`.
- The session adds a static file server. ScriptCat deliberately does not ("a
  verification that needs a mock is a scratch-spec case"); PF verification is
  unusable without real HTTP pages, because `data:` URLs cannot host a userscript
  target at all.
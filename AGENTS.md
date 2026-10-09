# AGENTS.md

Instructions for coding agents working in this repo. The long form is
`docs/ARCHITECTURE.md` — §4 layers, §5 invariants, §6 phases, §8 build and
release policy. **That file is the contract**: when code forces it to change,
change it in the same change.

PlayerForge ships as `dist/playerforge.user.js`, a Violentmonkey (MV2 2.49+)
userscript that attaches a HUD and controls to embedded video players on Gecko
157+ (`target.minFirefox` in `platform/capabilities.json`). The test target is
bleeding-edge first — Firefox Developer Edition is the first candidate,
resolved per run by `platform/harness/target.mjs`. Chromium is out of scope.
Default branch is `firefox`.

When you learn something that would have saved you time, add it here.

## 0. Tooling

Use the fast tools; they are all installed (`brew`). Do not fall back to
`grep`, `find`, `cat` or hand-rolled parsers.

| Task | Use | Not |
| --- | --- | --- |
| Search contents | `rg <pattern> [path]` | `grep -r`, `find \| xargs grep` |
| Find files | `fd <name-or-glob> [path]` | `find`, `ls -R` |
| Read a file | `bat <file>` (or the Read tool) | `cat`, `head`/`tail` loops |
| Diff / preview | `git diff \| delta` | bare pagers |
| JSON | `jq` | `python3 -c` |
| YAML | `yq` | manual parsing |
| Pick from a list | `fzf` | scrolling output by eye |
| Stage, stash, review | `lazygit` | long `git add -p` sessions |

Useful patterns for this tree:

```sh
rg -n "RenderGate" src/                 # who owns a symbol
rg -l "pf/no-forced-layout" .            # which files a rule touches
rg -n "pf:" src/ tests/ -g '*.test.mjs'  # one symbol across code and tests
fd -e mjs -e js . platform/integration  # enumerate, don't glob by hand
rg -c "postTask" src/                   # density, not just existence
rg -n "§5|§8" docs/                     # doc anchors
fd -H -d1                               # repo root inventory
```

Previews are cheap: `bat -n`, `fd | fzf`, `jq .key`. If a command's output
exceeds ~2k lines, narrow the query instead of paging.

## 1. Commands

Run from the repo root. Every gate below is currently green; treat a red run as
a real failure until proven otherwise.

```sh
npm run lint                 # eslint src/ platform/  (tests/ is NOT linted)
npm test                     # unit: tests/*.test.mjs via tests/loader.mjs
npm run build                # dist/playerforge.user.js from esbuild.config.mjs

# single files
node --import ./tests/loader.mjs --test tests/<file>.test.mjs
node --test platform/integration/<file>.test.mjs     # build first

npm run integration          # integration/*.test.mjs; rebuilds dist itself
node platform/run.mjs browser-bench --compare        # vs browser-bench/baseline.json
node platform/run.mjs browser-bench --record         # re-record baseline (deliberate only)
npm run bench                # pure-CPU node benchmarks (bench/)
npm run ci                   # test + bench + integration (no browser-bench)
npm run vm-smoke -- <xpi>    # real Violentmonkey; xpi fetched from AMO into a
                             # temp dir — never vendored into the repo
```

Sanity numbers (they drift; a run reporting very different totals is suspect):
unit `663`, integration `91 / 90 pass / 1 skipped`, browser-bench `50` rows
(14 gateable, 36 of them report-only shape pairs), vm-smoke `19/19`.

`node --test` with **no file list is wrong in this repo**: Node then discovers
`platform/integration/*.test.mjs` too, running the integration suite a second
time, in parallel with the unit tests, and losing tests to contention. Always
name files or the `tests/*.test.mjs` glob (fixed in `2dedcbe`).

## 2. Layout

```
src/entry.js            bundle entry — NOT where the version lives
src/kernel/             kernel (orchestrator + settle + registry), discovery
                        (URL gate + presence probe), contract, sdk, menus
src/shared/             the layers: engine-host (L0), player-status (L2),
                        render (L4 gate + L5 reconciler), plus scheduler,
                        diagnostics, storage, dom-manager, scope, geometry,
                        tuning, context.js (the ancestor/iframe bridge —
                        second-most-touched file in the tree, and easy to miss)
src/shell/              UI: shell.js (incl. the registerShell plugin),
                        chrome/ (panel, toast, history, toolbox), inputs/,
                        subtitles/ (forge-track, forgevtt, section),
                        media.js, resume.js
tests/                  unit only; loader.mjs installs the jsdom shims the
                        bundle expects (ResizeObserver, rAF, CSSOM …)
platform/run.mjs        gate runner: test|bench|integration|browser-bench|all|ci
platform/harness/       FirefoxDriver (firefox, page, target, xpi) plus
                        harness/native-extension/ — the control channel add-on
platform/integration/   live-browser tests
platform/browser-bench/ gateable web performance rows + baseline.json
platform/eslint-rules.mjs  pf/no-forced-layout, wired in eslint.config.js
dist/                   committed artifacts (see §8)
bench/                  pure-CPU node benchmarks
docs/ARCHITECTURE.md  the contract (§0–§9)
```

`src/shared/activity.js` holds `createActivity()` — the "passive until an edge
fires" unit L1 composes — and `src/shared/scope.js` the disposal primitive. Both
are load-bearing and neither is a layer of its own.

Find things with `fd`, not by browsing:

```sh
fd -e mjs . src/shared
fd -t d -d1 platform
```

## 3. Non-negotiables

1. **Four version surfaces must agree**: `@version` in `esbuild.config.mjs` is
   the single source; `package.json`, `package-lock.json` and the committed
   `dist/` banner all follow it, pinned by `tests/version-drift.test.mjs`.
   A bump is: edit the banner → `npm run build`. Done without the rebuild, the
   unit run fails rather than shipping a stale number.
2. **`dist/` is tracked on purpose** (§8). Browser gates call `ensureBundle()`,
   so a gate run leaves the tree dirty — expected, not a failure. Commit a
   regenerated bundle **with the source change that produced it**, once the
   gates have run, so the committed artifact is the one the last green gate
   measured. Don't leave it behind a src edit, and don't commit a rebuild
   nobody looked at either. `@resource pfStyle` stays unpinned (see
   `esbuild.config.mjs:173-177`).
3. **Two worlds.** WebDriver `executeScript` and devtools see the page world;
   PF runs in its realm-isolated userscript world. Probing `window.PlayerForge`
   or `window.GM_*` page-side legitimately reports nothing — the honest boot
   signal is the DOM (shell host + shadow root). Marionette also refuses
   navigation to and `findElement` in `moz-extension://` contexts: drive the
   harness through its control-channel ops instead.
4. **One browser suite at a time.** integration / browser-bench / vm-smoke
   overlap produces real, hard-to-read failures. Never parallelise them.
5. **`pf/no-forced-layout` is a hard rule** over `src/`: a layout-property read
   in the same task as a layout write fails `npm run lint`, and
   `tests/lint-rule.test.mjs` pins the rule against the real config. Do not
   `eslint-disable` to get green — split the tasks or cache the value.
6. **Do not delete history-bearing comments.** This codebase writes down *why*
   (measured numbers, Gecko quirks, the trap each header records). Match the
   file's existing voice; keep a comment accurate rather than trimming it.
7. **Profiler access is a gated path.** The harness add-on needs
   `geckoProfiler` in its manifest *and*
   `extensions.geckoProfiler.acceptedExtensionIds` to contain its id — the pref
   is set in `FirefoxDriver.launch` before install. Without it the manifest
   fails validation, and `browser.permissions.request` cannot grant it.
8. **Existing stash entries are intentional** (`stash@{0}`, `stash@{1}`); leave
   them alone. Scratch probes belong in
   `/var/folders/…/T/opencode/` or `platform/scratch/` (gitignored), never in
   `src/`.
9. **Price JS shapes on Gecko, and discount a ratio on a negligible cost.**
   `npm run bench` is Node/V8 and cannot justify a change to `src/` — the
   sibling `chromium` branch's V8 numbers came back wrong here twice, once at
   8.6× that is 3.4× and once at 1.6× that is 1.04×, i.e. nothing. Use
   `platform/browser-bench/jit-shape.bench.mjs` (report-only shape pairs) or a
   DOM row, and quote the shape's cost, never PF's speed. Then decide on the
   absolute number: the taken rows there are all sub-microsecond on
   pointer-rate paths, the largest being 13 ns per move, so they are kept for
   shape and readability and must not be written up as latency wins. A large
   ratio on a small cost is not a win — that is why `forge.js`'s `#pointers`
   stayed a Map. §2.9 of the architecture doc has the table and the reasoning.

## 4. Before you say "done"

```sh
npm run lint
npm test
npm run integration
# touching render/HUD/perf:
node platform/run.mjs browser-bench --compare
# touching the bundle surface, banner or manifest:
npm run build && npm test
# release only:
npm run ci && npm run vm-smoke -- <xpi>
```

Then re-read the §5 and §6 tables in `docs/ARCHITECTURE.md`: every
invariant needs a test, and §6's verification counts need to still be true.

## 5. Style and history

- Commit style, from the log: `feat`, `fix`, `perf`, `test`, `docs`, `chore`,
  `release`, optionally scoped (`feat(bench):`, `fix(ci):`), lowercase subject,
  imperative, one logical change per commit, body explains **why**.
- Do not commit, push, tag or rebase unless explicitly asked. No fixups, no
  amended pushed commits, no drive-by `git config`.
- Keep changes to `tests/` and `platform/` in the repo's idiom: fixtures in
  `tests/css-hook.mjs` / `fs-gate.mjs`, jsdom shims in `tests/loader.mjs`,
  driver plumbing in `platform/harness/`.

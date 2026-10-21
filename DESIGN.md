# DESIGN.md — HUD design guidance

Reference: [Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass)
(Apple Inc., © 2026). This document records how that guidance applies to the
PlayerForge HUD, what the HUD looks like today against it, and the rules a
redesign change has to satisfy.

It is a **guide for the redesign process**, not a description of a finished
design. Sections 1–2 are fixed: they are Apple's stated principles and the
applicability filter derived from them. Sections 3–5 are the mutable part and
are expected to change as the redesign lands.

---

## 1. What this document is not

PlayerForge is a web userscript injected into pages it does not own. **None of
Apple's component-level guidance applies**, and pretending otherwise is the first
mistake to avoid:

| Apple guidance | Applies here? |
|---|---|
| "Leverage system frameworks to adopt Liquid Glass automatically" (SwiftUI / UIKit / AppKit bars, sheets, controls) | **No.** There is no system framework to adopt. Every surface is hand-authored CSS in an injected shadow root. |
| `glassEffect(_:in:)`, `UIGlassEffect`, `NSGlassEffectView`, `GlassEffectContainer` | **No.** Web equivalents do not exist. `backdrop-filter` is a distinct, much weaker primitive — it cannot refract or morph. |
| `ToolbarSpacer`, `.tabBarMinimizeBehavior(.onScrollDown)`, `Icon Composer`, `backgroundExtensionEffect()` | **No.** No native toolbar, tab bar, app icon, or split view. |

What remains is Apple's **stated rationale** for those APIs, and that rationale
transfers cleanly. Every rule below traces to a sentence Apple actually wrote.
Where Apple reached for a component and we have no component, the rule becomes
"pick the constraint the component would have enforced, and enforce it by hand."

---

## 2. Apple's principles, as stated

Direct quotes, with the reasoning that matters for a hand-built HUD:

1. **"Reduce your use of custom backgrounds in controls and navigation elements."**
   Custom backgrounds "might overlay or interfere with Liquid Glass or other
   effects that the system provides, such as the scroll edge effect."
2. **"Avoid overusing Liquid Glass effects."** Applied to a custom control, "do
   so sparingly." The material "seeks to bring attention to the underlying
   content," and overuse "can provide a subpar user experience by distracting
   from that content." Limit effects "to the most important functional elements."
3. **"Optimize for legibility when content scrolls beneath controls."** The
   *scroll edge effect* "maintain[s] sufficient legibility and contrast for
   controls by obscuring content that scrolls beneath them."
4. **"Consider aligning the shape of controls with other rounded elements."** Use
   "rounded shapes that are concentric to their containers."
5. **"Establish a clear navigation hierarchy"** — a navigation layer "distinct
   from the content" and "distinct functional layer above the content layer."
6. **"Review your use of color in controls"** — define a custom color "with light
   and dark variants, and **an increased contrast option for each variant**."
7. **"Test your interface with a variety of display and accessibility settings."**
   People "can choose a preferred look … or turn on accessibility settings that
   reduce transparency or motion. These settings can remove or modify certain
   effects."
8. **"Check capitalization in section headers."** Lists/sections "adopt
   **title-style capitalization** … section headers no longer render entirely in
   capital letters regardless of the capitalization you provide."
9. **Sheets** "feature an **increased corner radius**," and you should "check the
   content around the edges of sheets" for content too close to those corners.
10. **"Combine custom Liquid Glass effects to improve rendering performance"**
    and **"Performance test your app across platforms."**

---

## 3. Current state against each principle

The "Starting point" column is the audit measured from
`src/shell/chrome/styles.css` at `276526b`. The "Now" column records where the
redesign landed; it is the column that stays current.

| # | Principle | Starting point (`276526b`) | Now |
|---|---|---|---|
| 1 | Reduce custom backgrounds in controls | In-panel controls were already flat tinted; only toast + panel carried `backdrop-filter` (2 sites). | **Holds** — still 2. |
| 2 | Avoid overusing the material | Two floating surfaces, both load-bearing. | **Holds.** |
| 3 | Legibility under scrolling content | `.pf-panel` scrolled with **no scroll-edge treatment**. | **Fixed (R4)** — header pinned; a 16px gradient hangs off its bottom edge. |
| 4 | Concentric radii | `--pf-radius-xs: 7px` was *larger* than `--pf-radius-sm: 6px`; nested radii were chosen, not derived. | **Fixed (R5)** — panel 18 → strip/close 10 → tab 7, each derived. |
| 5 | Distinct navigation layer | Panel and toasts separate from SDK chrome. | **Holds** — and now the header is a pinned layer. |
| 6 | Increased-contrast option | No `prefers-contrast`; `--pf-blur-*` were bare `blur() saturate()`. | **Retired in scope** — back to bare `blur() saturate()`; no `prefers-contrast` path. |
| 7 | Accessibility settings | `data-pf-cpu-tier="low"`, `prefers-reduced-transparency`, `prefers-reduced-motion` all present. | **Retired in scope** — removed with the low-CPU path (product decision: honor no accessibility setting); no media path remains. |
| 8 | Title-style section headers | `text-transform: uppercase` at :641 and :745. | **Fixed (R7)** — removed; markup was already title case. |
| 9 | Increased sheet radius + edge clearance | 12px on the largest surface. | **Fixed (R6)** — 18px. |
| 10 | Combine effects for performance | 2 composited layers total. | **Holds** — still 2; the scroll edge is paint, not a third blur. |

The pattern the audit drew still frames the change: the HUD was **structurally
restrained** (1, 2, 5, 10) and **deficient in material details** (3, 4, 6, 8,
9), so the redesign spent its effort on the second list.

---

## 4. Rules a redesign change must satisfy

Each rule names its source principle. These are checkable — a change that cannot
be checked against its rule is not finished.

**R1 — Glass budget: at most two `backdrop-filter` surfaces.** *(principles 2, 10)*
The panel and the toast are the only floating surfaces permitted to blur. Adding
a third is a redesign decision requiring its own justification: each blurred
surface is an independently composited layer that must re-rasterize whenever the
video frame beneath it changes. In-panel controls stay flat tinted.

**R2 — (RETIRED) blur must be contrast-modulated.** *(principle 6)*
Retired in scope: the blur tokens are again bare `blur() saturate()` and no
`prefers-contrast` path exists — the increased-contrast option applies to no
user in this product's audience. If user-facing contrast support returns, a
bare `saturate()` cannot express "increased contrast option"; a token can.

**R3 — Resting tint stays lower than focused tint.** *(principles 2, 5)*
The material exists "to bring attention to the underlying content." A single
tint value applied to both states over-asserts the HUD when idle. Resting tint
proposed at **58%**, focus tint at **76%**, both as distinct tokens — the
difference must be legible in the token set, not implied.

**R4 — Every scrollable glass surface needs a scroll edge.** *(principle 3)*
`.pf-panel` scrolls. Content passing beneath a control must stay legible, which
Apple solves by *obscuring the content*, not by darkening the whole surface. A
masked gradient anchored to the scroll edge, sized to the header, not a blanket
scrim. Same rule for the toast when it stacks.

**R5 — Nested radii are concentric with their container.** *(principle 4)*
If a container has radius `R` and inset padding `P`, an inset element flush with
that edge uses radius `R - P`. A tab strip inset in an `18px` panel with `8px`
padding is `10px`, not a free-floating value. Nested values must be *derived*,
not chosen, so they stay correct when the container changes.

**R6 — The sheet gets the largest radius in the HUD.** *(principle 9)*
Concentricity inverts at the top: the panel is the outermost surface, so it takes
the largest radius, and every element nested inside is smaller. Proposed panel
radius **18px**, up from 12px.

**R7 — Section headers are title case.** *(principle 8)*
Remove `text-transform: uppercase` from `.pf-panel-label` and its compact
variant. Apple changed this system-wide specifically so headers read as
sentences; the override defeats it.

**R8 — (RETIRED) user-preference collapse paths.** *(principle 7)*
The honor system is retired entirely in scope: neither reduced-transparency,
reduced-motion, the (earlier retired) low-CPU tier path, nor
`prefers-contrast` changes the HUD any more - it renders and animates
uniformly for every user. If any accessibility honor is ever restored, the
collapses go to `--pf-surface` with no sheen, no shadow, no border, no blur, no
scrim, and the contrast path modulates the token rather than collapsing.

**R9 — Every HUD change needs a legibility measurement, not a screenshot.** *(principles 3, 10)*
A screenshot cannot answer "is text still readable over this frame." Measure the
contrast between HUD foreground and the composited backdrop, and assert it.

---

## 5. Verification

- **Geometry must not move.** A redesign that changes resting radii or control
  positions has changed layout, not appearance; those are separate changes.
- **Contrast must be measured** against a hostile, *fixed* backdrop (R9). A
  moving video frame makes any such measurement irreproducible.

### Tooling note

The measurement harness R9 depends on — `platform/visual/hud-glass.mjs`, its
baseline, and the rim/legibility invariants — was authored after the
pre-ScriptCat rewind point and preserved on the `v1.0.0` tag. It is now on this
branch (cherry-picked forward in `e8a98a5`), which deliberately kept the
`v1.0.0` baseline as a *target* for the redesign to converge on rather than a
snapshot of the current HUD.

The redesign converged on it. `backdropFilter`, `borderRadius`, `glassTint` and
`radiusLg` now match the target exactly, and the pixel metrics exceed it:
`minLegibilityDelta` 73 against a target of 46, `rimLift` 1.55 against 0.53.
The one token that differs is `backgroundColor` — `0.76` (focus) against the
target's `0.58` (resting) — which is the deliberate R3 two-state tint the target
predates. The baseline has since been re-recorded so it tracks the *shipped*
design for regression detection; the v1.0.0 target is preserved on its tag.

### Change log

- **Contrast path retired.** The last accessibility honor is gone:
  `prefers-contrast: more` no longer moves `--pf-glass-contrast`; that token,
  its `@property` registration, and the `brightness(var(--pf-glass-contrast))`
  factor inside both blur tokens were removed with it (a constant multiplier
  with no writer is dead machinery). The blur tokens are again bare
  `blur() saturate()`, matching the pre-redesign filter shape - the glass
  itself is untouched. R2 and the remaining verification bullet are retired.
- **User-preference collapses retired.** The `prefers-reduced-transparency`
  glass collapse, the `prefers-reduced-motion` token/`::view-transition`
  collapse, and the JS-side `REDUCED_MOTION` gates (snap easing, accent flash,
  panel view transition) were removed: the HUD now renders and animates
  uniformly on every device in scope. `prefers-contrast: more` (R2) survives -
  it modulates rather than collapses. R8 is retired outright.
- **CPU-tier collapse retired.** The `data-pf-cpu-tier` attribute, the
  `navigator.cpuPerformance` tier detection behind it, and the low-tier glass
  collapse in `styles.css` were removed: Helium (desktop) and Titanium
  (Android) do not target low-tier devices, so the hardware-tier path served
  no reachable user. R8 now covers the two user-preference collapses
  (reduced-transparency, reduced-motion); no token or selector changed for
  mid/high-tier devices.
- **Vocabulary derivation pass.** The gesture contract stopped hand-spelling
  its machine-facing strings: `GESTURES` and `GESTURE_EVENTS` are now
  formula-derived (`pf:gesture-<id>`, `gestures.<id>`, camel→kebab for the
  one-shot handles) from one table of `{id: label}` pairs, the frame-bridge
  message types and their dispatch gate share one `BRIDGE_MSG_PREFIX`, the
  `#pf-debug` hash needle moved into the contract (`DEBUG_HASH_TAG`) so the
  entry and kernel debug decisions read one constant, the cpu-tier attribute
  got a named const at its single writer, and the unit tests now import the
  storage `KEYS` vocabulary instead of re-spelling the roots. All derived
  strings are byte-identical to the hand-spelled ones (asserted) - no
  migration, no behavior change.
- **Hygiene pass.** The platform floor's remaining Chromium-154 references (the
  banner description, the main and worker esbuild targets, the test-loader
  comment) moved to 155 to match package.json. Four exports with no external
  consumer were closed (`forEachVideoInMutations`, `gmGetValue`, `VOLUME_STEP`
  de-exported; `watchDocumentVideos` deleted along with its stale
  "used by the kernel" claim), the `POINTER_GESTURE_INTENTS` alias was inlined
  onto `GESTURE_IDS`, and the non-gesture setting keys became a single frozen
  vocabulary (`SETTING_KEYS` in `config.js`) that the schema and every consumer
  (bindings, haptics gate, panel, shell) now derive from. No behavior change.
- **Architecture step unification.** The ordered sequences that were spelled
  out as long method bodies are now single declarative lists behind shared
  helpers. `src/shared/steps.js` (`runSteps` / `runStepsAsync`) runs the shell
  boot and teardown, the kernel `init` / pagehide teardown, and the panel
  section build. The two observer gates collapsed onto one `createPresenceGate`
  engine (`createLayoutGate` / `createOnScreenGate` stay as named wrappers), and
  the probe's two-phase tap plus the kernel's full and downgraded taps collapsed
  onto one `createDiscoveryTap` with an `escalate()` upgrade. The panel's lazy
  sections are a `PANEL_SECTIONS` table, and the navigation and scheduler
  backends pick their implementation through `firstAvailable`
  (`src/shared/fallback.js`). No user-visible behavior or output change.
- **Key unification pass.** The gesture vocabulary is now a single registry
  (`GESTURES`/`GESTURE_IDS` in `src/kernel/contract.js`) that the input
  bindings, the settings schema, the pointer-intent list and `GESTURE_EVENTS`
  all derive from; the settings-schema gesture toggles are generated from it.
  The GM storage namespace dropped from three roots to two — `firstRun` moved
  under the configs doc's `meta` subtree (with one-shot migration from both the
  `pf:first-run` and bare `firstRun` legacy fields). The filter's five parallel
  key/range/label/format maps collapsed into one `FILTER_SCHEMA`, and the CSS
  cue-position and glass-contrast tokens are typed `@property` registrations
  (their initial-values now replace the redundant `.pf-cue-layer` defaults).
  Documented platform floor raised from Chromium 154 to 155.
- **Redesign landed.** R2 (contrast-modulated blur + `prefers-contrast`), R3
  (resting 58% / focus 76% tints), R4 (pinned header + scroll-edge gradient),
  R5/R6 (derived concentric radii, panel 18px), R7 (title-case headers), R8
  (focus tint + scroll edge reach every collapse path) are in
  `src/shell/chrome/styles.css`. Two defects in the first cut were corrected:
  the R3 selector could not cross the shadow boundary, and the
  `prefers-contrast` tints were overriding the reduced-transparency collapse.
- **Initial document.** Principles and applicability filter taken from Apple's
  adoption guide; current-state audit measured from `styles.css` at `276526b`.
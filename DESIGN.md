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

Measured from `src/shell/chrome/styles.css` at `276526b`. This is the honest
starting point, including where the HUD already complies.

| # | Principle | Today | Verdict |
|---|---|---|---|
| 1 | Reduce custom backgrounds in controls | In-panel controls are already flat tinted surfaces; only the toast and panel carry `backdrop-filter` (2 sites total). | **Mostly holds.** |
| 2 | Avoid overusing the material | Two floating surfaces, both load-bearing (navigation + transient messaging). | **Holds.** |
| 3 | Legibility under scrolling content | `.pf-panel` is `overflow-y: auto` (styles.css:470) with **no scroll-edge treatment** — cue text scrolls directly under the panel header. | **Gap.** |
| 4 | Concentric radii | `--pf-radius-lg: 12px` on the sheet; `--pf-radius-xs: 7px` is *larger* than `--pf-radius-sm: 6px`; the tab strip and section heads carry their own radii with no concentric relationship to the panel. | **Gap.** |
| 5 | Distinct navigation layer | Panel and toasts are separate from SDK chrome. | **Holds.** |
| 6 | Increased-contrast option | No `prefers-contrast` support, and no contrast token — `--pf-blur-sm/-lg` are bare `blur() saturate()`, with no `brightness()` term to modulate. | **Gap.** |
| 7 | Accessibility settings | `data-pf-cpu-tier="low"`, `prefers-reduced-transparency`, `prefers-reduced-motion` all present. | **Holds.** |
| 8 | Title-style section headers | `text-transform: uppercase` at styles.css:641 **and** :745. | **Gap — Apple calls this out by name.** |
| 9 | Increased sheet radius + edge clearance | 12px on the largest surface in the HUD. | **Gap.** |
| 10 | Combine effects for performance | 2 composited layers total. | **Holds.** |

The pattern: the HUD is **structurally restrained** (principles 1, 2, 5, 10 were
respected long before this document existed) and **deficient in the material
details** (3, 4, 6, 8, 9). A redesign should spend its effort on the right
column, not re-litigate the left one.

---

## 4. Rules a redesign change must satisfy

Each rule names its source principle. These are checkable — a change that cannot
be checked against its rule is not finished.

**R1 — Glass budget: at most two `backdrop-filter` surfaces.** *(principles 2, 10)*
The panel and the toast are the only floating surfaces permitted to blur. Adding
a third is a redesign decision requiring its own justification: each blurred
surface is an independently composited layer that must re-rasterize whenever the
video frame beneath it changes. In-panel controls stay flat tinted.

**R2 — Blur must be contrast-modulated.** *(principle 6)*
`--pf-blur-sm` / `--pf-blur-lg` must include `brightness(var(--pf-glass-contrast))`
rather than a bare `saturate()`. A fixed saturation cannot express "increased
contrast option"; a token can, and it is the only way the material responds to a
user's contrast preference.

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

**R8 — Reduced-transparency, reduced-motion, and low-CPU keep their collapse.** *(principle 7)*
These already exist and must keep collapsing to `--pf-surface` with no sheen, no
shadow, no border, no blur, no scrim. A redesign that adds a glass token must add
it to all three collapse paths, or it will leak translucency exactly where the
user asked for none. Contrast must be reachable in the high-contrast path
independently of the blur path.

**R9 — Every HUD change needs a legibility measurement, not a screenshot.** *(principles 3, 10)*
A screenshot cannot answer "is text still readable over this frame." Measure the
contrast between HUD foreground and the composited backdrop, and assert it.

---

## 5. Verification

- **`prefers-contrast: more`** must visibly change the HUD (R2, R8). Check the
  token actually moves, not just that the media query parses.
- **Reduced-transparency and `data-pf-cpu-tier="low"`** must produce no
  `backdrop-filter`, no sheen, no shadow, no border on any surface.
- **Geometry must not move.** A redesign that changes resting radii or control
  positions has changed layout, not appearance; those are separate changes.
- **Contrast must be measured** against a hostile, *fixed* backdrop (R9). A
  moving video frame makes any such measurement irreproducible.

### Known gap in the tooling on this branch

The measurement harness R9 depends on — `platform/visual/hud-glass.mjs`, its
baseline, and the rim/legibility invariants — **does not exist on this branch.**
It landed after the pre-ScriptCat rewind point and is preserved on the `v1.0.0`
tag.

That matters for sequencing: R9 cannot be satisfied on this branch as it stands.
Either cherry-pick the harness forward from `v1.0.0` before starting the
redesign, or accept that R9 is enforced by inspection until then. Do not record a
new baseline while the harness is absent — there would be nothing to compare it
against.

---

## Change log

- **Initial document.** Principles and applicability filter taken from Apple's
  adoption guide; current-state audit measured from `styles.css` at `276526b`.
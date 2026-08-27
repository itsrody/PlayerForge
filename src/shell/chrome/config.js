/**
 * User-settings engine: defaults, schema, cached accessors, and the generic
 * panel renderer for that schema.
 */
import { KEYS, getConfigValue, setConfigValue } from "../../shared/storage.js";
import { logger } from "../../shared/logger.js";

const SETTINGS_PREFIX = "settings";

/** Configs-doc field behind the GM-menu debug-logs toggle (kernel + entry). */
export const DEBUG_LOGS_KEY = "debug.logs";

const SETTINGS_SCHEMA = [
  {
    key: "controller.stepSeek",
    type: "options",
    label: "Skip Step",
    options: [5, 10, 15],
    fmt: (v) => `${v}s`,
    default: 5,
    group: "Playback"
  },
  {
    key: "gestures.hotkeys",
    type: "bool",
    label: "Hotkeys",
    default: true,
    group: "Features"
  },
  {
    key: "gestures.hold",
    type: "bool",
    label: "Speed Up Hold",
    default: true,
    group: "Features"
  },
  {
    key: "gestures.scrub",
    type: "bool",
    label: "Scrub Seeking",
    default: true,
    group: "Features"
  },
  {
    key: "gestures.swipe",
    type: "bool",
    label: "Swiping",
    default: true,
    group: "Features"
  },
  {
    key: "gestures.dbltap",
    type: "bool",
    label: "Double-tap Skip",
    default: true,
    group: "Features"
  },
  {
    key: "gestures.pinch",
    type: "bool",
    label: "Pinch to Fill",
    default: false,
    group: "Features"
  },
  {
    key: "video.pip",
    type: "bool",
    label: "Mobile PiP",
    default: false,
    group: "Features"
  }
];

/** Defaults ride their schema definitions - one source, no drift. */
const DEFAULT_SETTINGS = Object.fromEntries(
  SETTINGS_SCHEMA.map((definition) => [definition.key, definition.default])
);

/**
 * Engineering calibration - every tunable value in the codebase lives here,
 * beside the user schema. These are behavior constants, not preferences:
 * no panel controls, no storage. Grouped by subsystem, units embedded.
 */
export const TUNING = {
  gestures: {
    /** Hold-to-speed-up: press must stay still and last this long. */
    holdTimeoutMs: 300,
    holdCancelMovePx: 10,
    doubleTapWindowMs: 300,
    /** Swipe-exit hot zones as a viewport fraction. */
    edgeZoneRatio: 0.15,
    scrollStartPx: 15,
    axisDominanceRatio: 2,
    pinchMinDistancePx: 50,
    pinchScaleThreshold: 0.2,
    pinchBaselineDelayMs: 2,
    trackpadCooldownMs: 500,
    /** Click/dblclick suppression window after a consumed gesture. */
    suppressWindowMs: 600,
    /** Horizontal travel that dismisses the HUD. */
    swipeExitMinPx: 100,
    /** Idle time that resets the double-tap skip streak. */
    streakResetMs: 600
  },
  controller: {
    holdSpeed: 2,
    streakMax: 10,
    /** Stored raw around the 150 anchor; effective multiplier = value / 150. */
    scrubSensitivity: 100
  },
  scrub: {
    /**
     * Velocity-proportional scrub. The amount of time moved per pixel is a
     * monotonic saturating function of the finger's instantaneous speed
     * (measured px/s by the forge): a slow stroke moves ~slowFullWidthSeconds
     * across the container width, a fast stroke ~fastFullWidthSeconds. The
     * curve rises smoothly between them past the knee, then saturates so
     * high-speed scrubbing stays stable and never overshoots (scrubTo clamps
     * to [0, duration]). Signed by drag direction.
     */
    velocity: {
      /** Full-width stroke at near-zero speed: the "1s" slow floor. */
      slowFullWidthSeconds: 1,
      /** Full-width stroke at high speed: the "minutes" ceiling. */
      fastFullWidthSeconds: 90,
      /** Velocity (px/s) at which the gain sits ~halfway between slow and fast. */
      kneeVelocityPxS: 400,
      /** Curve shape; >1 rises later and punchier, <1 hurries to the ceiling. */
      exponent: 1.5
    },
    /** Sub-pixel moves are ignored so a holding finger doesn't micro-shimmer. */
    deadZonePx: 0.5,
    /**
     * Time constant (ms) of the velocity low-pass filter. The forge measures
     * true per-sample velocity (Δpx / ΔtimeStamp, refresh-rate independent)
     * and smooths it with alpha = 1 - exp(-dt/tau). Because alpha derives from
     * real elapsed time rather than event count, the smoothing window is the
     * same absolute time at any display rate - adaptive-refresh correct - and
     * a small tau keeps the signal responsive enough to track speed changes
     * mid-stroke.
     */
    velocityFilterMs: 80
  },
  resume: {
    saveIntervalMs: 60000,
    metadataWaitMs: 10000,
    /** Progress at/after which the entry resets so the video restarts next time. */
    completionRatio: 0.95,
    /** Ignore tiny drifts between saves. */
    saveEpsilonSeconds: 3,
    durationFuzz: 2,
    /** Only auto-seek when the saved position is meaningful. */
    minPosition: 5,
    staleDays: 14,
    /** Hard ceiling for stored entries regardless of age pruning. */
    maxEntries: 1000
  },
  subtitles: {
    syncDebounceMs: 150
  },
  toast: {
    /** Completed-action feedback: skip, volume, fullscreen exit, fill. */
    flashMs: 800,
    /** Plain status messages. */
    infoMs: 2500,
    /** Toasts carrying a clickable button - extra reading time. */
    actionMs: 4000,
    /** Onboarding hints. */
    hintMs: 5000
  },
  kernel: {
    removalGraceMs: 500
  }
};

const cache = {};
for (const key of Object.keys(DEFAULT_SETTINGS)) {
  cache[key] = getConfigValue(`${SETTINGS_PREFIX}.${key}`, DEFAULT_SETTINGS[key]);
}

export function getSetting(key) {
  return cache[key];
}

export function setSetting(key, value) {
  cache[key] = value;
  setConfigValue(`${SETTINGS_PREFIX}.${key}`, value);
}

/**
 * Live reload across tabs: pf:configs lives in shared Violentmonkey storage,
 * so a write from any other tab re-seeds this cache and every event-time
 * getSetting() consumer picks it up on its next read. Our own writes echo
 * back through the same path and land as no-ops.
 */
function refreshSettingsCache() {
  let changed = 0;
  for (const key of Object.keys(cache)) {
    const fresh = getConfigValue(`${SETTINGS_PREFIX}.${key}`, DEFAULT_SETTINGS[key]);
    if (cache[key] !== fresh) {
      cache[key] = fresh;
      changed++;
    }
  }
  if (changed > 0) {
    logger.log("settings", `Live-reloaded ${changed} setting(s) from storage`);
  }
}

if (typeof GM_addValueChangeListener === "function") {
  GM_addValueChangeListener(KEYS.configs, () => refreshSettingsCache());
}

/**
 * Render SETTINGS_SCHEMA into the settings panel: one labeled section per
 * group, toggles for bools, steppers for numbers. Pure function over the
 * panel API - no lifecycle of its own.
 */
export function addSettingsSection(panel) {
  if (!panel?.body) {
    return;
  }
  const sectionRoot = panel.addSection("Settings", "settings");
  if (!sectionRoot) {
    return;
  }

  let currentGroup = null;
  let groupGrid = null;
  for (const definition of SETTINGS_SCHEMA) {
    if (definition.group !== currentGroup) {
      currentGroup = definition.group;
      const groupSection = panel.el("div", { class: "pf-panel-section" }, sectionRoot);
      panel.addLabel(groupSection, definition.group);
      groupGrid = panel.el("div", { class: "pf-panel-grid" }, groupSection);
    }
    if (definition.type === "bool") {
      const cellAttrs = { class: "pf-panel-cell" };
      if (definition.key === "video.pip") {
        cellAttrs["data-pf-pip"] = "";
      }
      const cell = panel.el("div", cellAttrs, groupGrid);
      const toggleLabel = panel.el("label", { class: "pf-settings-toggle" }, cell);
      const checkbox = panel.addControl(toggleLabel, {
        type: "checkbox",
        checked: getSetting(definition.key),
        onChange: (checked) => {
          setSetting(definition.key, checked);
        }
      });
      checkbox.setAttribute("aria-label", definition.label);
      panel.el("span", {}, toggleLabel).textContent = definition.label;
    } else if (definition.type === "options") {
      const cell = panel.el("div", { class: "pf-panel-cell pf-options-cell" }, groupGrid);
      panel.addLabel(cell, definition.label);
      const row = panel.el("div", { class: "pf-options-row" }, cell);
      const current = getSetting(definition.key);
      for (const opt of definition.options) {
        const btn = panel.el("button", {
          type: "button",
          class: opt === current ? "pf-btn pf-options-btn pf-options-active" : "pf-btn pf-options-btn"
        }, row);
        btn.textContent = definition.fmt(opt);
        btn.addEventListener("click", () => {
          setSetting(definition.key, opt);
          for (const b of row.children) {
            b.classList.toggle("pf-options-active", b === btn);
          }
        });
      }
    } else {
      panel.addControl(groupGrid, {
        type: "stepper",
        label: definition.label,
        min: definition.min,
        max: definition.max,
        step: definition.step,
        value: getSetting(definition.key),
        head: true,
        format: definition.fmt,
        // Typing stays local until blur/Enter - no GM_setValue per keystroke
        // (subtitle steppers keep live output, so they stay immediate).
        deferTextInput: true,
        onChange: (parsed) => setSetting(definition.key, parsed)
      });
    }
  }
  logger.log("settings", "Settings section ready");
}

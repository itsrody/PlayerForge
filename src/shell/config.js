import { getConfigValue, setConfigValue } from "../shared/storage.js";

export const SETTINGS_PREFIX = "settings";

export const DEFAULT_SETTINGS = {
  "controller.holdSpeed": 2,
  "controller.stepSeek": 5,
  "controller.streakMax": 10,
  "controller.scrubSensitivity": 150,
  "gestures.hotkeys": true,
  "gestures.hold": true,
  "gestures.scrub": true,
  "gestures.swipe": true,
  "gestures.dbltap": true,
  "gestures.pinch": true,
  "resume.durationFuzz": 2
};

export const SETTINGS_SCHEMA = [
  {
    key: "controller.holdSpeed",
    type: "number",
    label: "Hold speed",
    min: 1.5,
    max: 4,
    step: 0.5,
    fmt: (v) => `${v}x`,
    group: "Playback"
  },
  {
    key: "controller.stepSeek",
    type: "number",
    label: "Arrow skip step",
    min: 1,
    max: 30,
    step: 1,
    fmt: (v) => `${v}s`,
    group: "Playback"
  },
  {
    key: "controller.streakMax",
    type: "number",
    label: "Max skip streak",
    min: 1,
    max: 30,
    step: 1,
    fmt: (v) => `${v}x`,
    group: "Playback"
  },
  {
    key: "controller.scrubSensitivity",
    type: "number",
    label: "Scrub sensitivity",
    min: 50,
    max: 500,
    step: 10,
    fmt: (v) => `${v}`,
    group: "Playback"
  },
  {
    key: "gestures.hotkeys",
    type: "bool",
    label: "Keyboard hotkeys",
    group: "Gestures"
  },
  {
    key: "gestures.hold",
    type: "bool",
    label: "Hold to speed up",
    group: "Gestures"
  },
  {
    key: "gestures.scrub",
    type: "bool",
    label: "Horizontal scrub",
    group: "Gestures"
  },
  {
    key: "gestures.swipe",
    type: "bool",
    label: "Swipe gestures",
    group: "Gestures"
  },
  {
    key: "gestures.dbltap",
    type: "bool",
    label: "Double-tap skip",
    group: "Gestures"
  },
  {
    key: "gestures.pinch",
    type: "bool",
    label: "Pinch to fill",
    group: "Gestures"
  },
  {
    key: "resume.durationFuzz",
    type: "number",
    label: "Resume tolerance",
    min: 0,
    max: 10,
    step: 1,
    fmt: (v) => `${v}s`,
    group: "Resume"
  }
];

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

/**
 * ScriptCat `==UserConfig==` schema - the power-user settings the MANAGER
 * renders, not PlayerForge.
 *
 * Pure data, zero imports: the build script emits the YAML block from this
 * array (so the declared schema and the runtime importer can never drift) and
 * the runtime importer reads the same array. Anything browser-specific lives in
 * power-config.js; nothing here may touch a global.
 *
 * Why these fields and not others: every entry is a per-USER preference - the
 * things a person tunes once for themselves. Per-video, per-session choices
 * (caption placement, seek step, which gestures are on) stay in the HUD panel,
 * where they belong next to the video they act on.
 *
 *   key   - the pf:configs field this feeds, i.e. what the rest of PlayerForge
 *           already reads. The HUD panel edits the same field, so the two
 *           surfaces converge on one stored value rather than two.
 *   id    - the UserConfig key suffix; the manager key is `power.<id>`.
 */

export const POWER_GROUP = "power";

/** Snapshot of the manager values last imported, kept in pf:configs. */
export const POWER_SNAPSHOT_PATH = "power.imported";

export const POWER_SCHEMA = [
  {
    id: "debugLogs",
    title: "Debug logging",
    description: "Verbose framework logging to the console. The first thing to turn on when reporting a bug.",
    type: "checkbox",
    default: false,
    key: "debug.logs"
  },
  {
    id: "captionSize",
    title: "Caption size",
    description: "Default cue size, applied to every track you load.",
    type: "number",
    default: 1.2,
    min: 0.6,
    max: 3,
    unit: "em",
    key: "subtitles.style.size"
  },
  {
    id: "captionColor",
    title: "Caption colour",
    description: "Default cue colour as a CSS hex value.",
    type: "text",
    default: "#ffffff",
    key: "subtitles.style.color"
  },
  {
    id: "captionShadow",
    title: "Caption shadow",
    description: "0 turns the cue shadow off; higher values deepen it.",
    type: "number",
    default: 40,
    min: 0,
    max: 100,
    unit: "%",
    key: "subtitles.style.shadow"
  },
  {
    id: "captionSync",
    title: "Caption sync offset",
    description: "Global lead or lag applied to every track, in seconds.",
    type: "number",
    default: 0,
    min: -20,
    max: 20,
    unit: "s",
    key: "subtitles.sync.offset"
  }
];
/**
 * Import of the manager-rendered power-user config into pf:configs.
 *
 * ScriptCat's `==UserConfig==` block makes the MANAGER own a settings UI, but
 * the values land in the same GM storage the script reads - as `power.<id>`
 * keys, entirely outside the pf:configs document the framework uses. This
 * module is the one-way bridge: at boot it folds any manager-side edit into
 * the pf:configs field the rest of PlayerForge already reads, so the HUD panel
 * and the manager UI are two doors onto one value rather than two settings.
 *
 * Edit detection needs a snapshot, because a manager value that merely EXISTS
 * carries no information. ScriptCat does not leave unedited UserConfig keys
 * absent: its worker synthesizes `<group>.<key>` as `stored ?? declared
 * default` and ships that whole map to the script, so GM_getValue("power.x")
 * answers with the schema default whether or not anyone ever touched the
 * manager UI. Presence therefore proves nothing - and worse, treating those
 * synthesized defaults as real edits would reset every HUD-panel setting on
 * every boot, forever.
 *
 * So pf:configs keeps the last imported value per field (`power.imported`) and
 * a manager value is adopted only when it DIFFERS from its snapshot. First
 * contact records the snapshot and adopts nothing, which is what keeps the
 * upgrade from reverting panel settings to the schema defaults. Comparing
 * against the snapshot (not against the declared default) is also what makes a
 * person who edits a field BACK to its default land correctly: the snapshot
 * still holds their previous value, so the revert is a genuine diff.
 *
 * One direction only, on purpose: a HUD-panel edit is not pushed back to the
 * manager. Manager storage is the manager's to write, and PF never widens its
 * own write surface into keys it does not own.
 */

import { POWER_GROUP, POWER_SNAPSHOT_PATH, POWER_SCHEMA } from "./power-schema.js";
import { gmGetValue, getConfigValue, setConfigFields } from "./storage.js";
import { logger } from "./logger.js";

/**
 * Coerce one manager value into what the target field can hold, or undefined
 * to drop it. Manager storage is writable by any tab and by hand, so a foreign
 * writer must not smuggle a string into a numeric field the steppers trust -
 * same stance as coerceSetting in shell/chrome/config.js.
 */
function coerce(field, value) {
  if (field.type === "checkbox") {
    return typeof value === "boolean" ? value : undefined;
  }
  if (field.type === "number") {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return undefined;
    }
    // Clamp instead of rejecting: the manager's stepper already bounds these,
    // but a hand-edited value must not be able to push the HUD out of range.
    return Math.min(field.max, Math.max(field.min, num));
  }
  if (field.type === "text") {
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

/**
 * Fold any manager-side power-config edits into pf:configs. Returns the number
 * of fields adopted (0 on first contact and when there is nothing new), so the
 * caller can log it.
 */
export function importManagerConfig() {
  const seen = getConfigValue(POWER_SNAPSHOT_PATH, null);
  const previous = seen && typeof seen === "object" && !Array.isArray(seen) ? seen : null;
  const fields = {};
  const snapshot = {};
  let adopted = 0;

  for (const field of POWER_SCHEMA) {
    let value;
    try {
      value = gmGetValue(`${POWER_GROUP}.${field.id}`, undefined);
    } catch (err) {
      logger.warn("power", `Unreadable manager value for "${field.id}":`, err);
      continue;
    }
    // Defensive only: a manager that does not synthesize (the test harness,
    // or a future manager that stops materializing defaults) leaves untouched
    // keys absent, and absent means "leave PF's own value alone".
    if (value === undefined) {
      continue;
    }
    snapshot[field.id] = value;
    if (!previous || Object.is(previous[field.id], value)) {
      continue;
    }
    const coerced = coerce(field, value);
    if (coerced === undefined) {
      logger.warn("power", `Ignoring out-of-schema manager value for "${field.id}"`);
      continue;
    }
    fields[field.key] = coerced;
    adopted++;
  }

  if (!previous) {
    // First contact: record what the manager currently reports and change
    // nothing. Those values are the schema defaults ScriptCat just synthesized
    // (or, on a later run, the last thing we adopted), not evidence of an edit.
    if (Object.keys(snapshot).length) {
      setConfigFields({ [POWER_SNAPSHOT_PATH]: snapshot });
    }
    return 0;
  }
  if (!adopted) {
    return 0;
  }
  fields[POWER_SNAPSHOT_PATH] = snapshot;
  setConfigFields(fields);
  return adopted;
}
import test from "node:test";
import assert from "node:assert/strict";

const writes = {};
globalThis.GM_getValue = (key, fallback) => writes[key] ?? fallback;
let configsListener = null;
globalThis.GM_addValueChangeListener = (key, cb) => {
  if (key === "pf:configs") {
    configsListener = cb;
  }
};
globalThis.GM_setValue = (key, value) => {
  writes[key] = value;
  // The manager fires the listener for own-tab writes too.
  configsListener?.(key, null, value, false);
};

const { addSettingsSection, getSetting, setSetting, onSettingsChanged } = await import("../src/shell/chrome/config.js");

function makeFakePanel() {
  const calls = { sections: [], labels: [], checkboxes: [], steppers: [], buttons: [] };
  const node = (tag, attrs = {}, parent = null) => {
    const classSet = new Set(attrs.class ? attrs.class.split(" ") : []);
    const el = { tag, attrs, parent, children: [], textContent: "", ariaLabel: null };
    el.setAttribute = (name, value) => {
      if (name === "aria-label") el.ariaLabel = value;
      if (name === "class") {
        classSet.clear();
        value.split(" ").forEach(c => classSet.add(c));
      }
    };
    el.addEventListener = () => {};
    el.classList = {
      toggle: (cls, force) => {
        if (force === undefined) force = !classSet.has(cls);
        if (force) classSet.add(cls); else classSet.delete(cls);
      },
      has: (cls) => classSet.has(cls),
      add: (cls) => classSet.add(cls),
      remove: (cls) => classSet.delete(cls)
    };
    if (parent) parent.children.push(el);
    return el;
  };
  const panel = {
    calls,
    body: {},
    el: (tag, attrs, parent) => {
      const n = node(tag, attrs, parent);
      if (tag === "button") calls.buttons.push(n);
      return n;
    },
    addSection: (title, id) => {
      const root = node(`section#${id}`, { title });
      calls.sections.push({ title, id, root });
      return root;
    },
    addLabel: (parent, text) => {
      calls.labels.push(text);
      return node("label", { text }, parent);
    },
    addCheckbox: (label, { checked, onChange }) => {
      const box = { checked, onChange, ariaLabel: null };
      box.setAttribute = (name, value) => {
        if (name === "aria-label") box.ariaLabel = value;
      };
      calls.checkboxes.push(box);
      return box;
    },
    addStepper: (grid, options) => {
      calls.steppers.push(options);
      // Real panel handle shape (panel.addStepper returns { setValue, ... }).
      return {
        root: {},
        input: {},
        getValue: () => options.value,
        setValue(value) {
          this.value = value;
        },
        setDisabled() {}
      };
    },
    addControl: (parent, { type, ...opts }) => {
      switch (type) {
        case "checkbox": return panel.addCheckbox(opts, opts);
        case "stepper": return panel.addStepper(parent, opts);
        default: return null;
      }
    }
  };
  return panel;
}

test("renders one labeled section per unique schema group", () => {
  const panel = makeFakePanel();
  addSettingsSection(panel);
  assert.deepEqual(panel.calls.sections.map((s) => s.title), ["Settings"]);
  assert.deepEqual(panel.calls.labels, ["Playback", "Skip Step", "Features", "Interface"]);
});

test("bool settings render toggles with labels and aria", () => {
  const panel = makeFakePanel();
  addSettingsSection(panel);
  assert.equal(panel.calls.checkboxes.length, 8);
  assert.ok(panel.calls.checkboxes.every((box) => typeof box.onChange === "function"));
  const hotkeys = panel.calls.checkboxes[0];
  assert.equal(hotkeys.checked, true);
  assert.equal(hotkeys.ariaLabel, "Hotkeys");
});

test("toggle onChange persists through setSetting", () => {
  const panel = makeFakePanel();
  addSettingsSection(panel);
  const hotkeysBox = panel.calls.checkboxes[0];
  hotkeysBox.onChange(false);
  assert.equal(getSetting("gestures.hotkeys"), false);
  assert.equal(writes["pf:configs"]?.settings?.gestures?.hotkeys, false);
});

test("panels without a body or section are ignored gracefully", () => {
  assert.doesNotThrow(() => addSettingsSection(null));
  assert.doesNotThrow(() => addSettingsSection({}));
  const noSection = makeFakePanel();
  noSection.addSection = () => null;
  assert.doesNotThrow(() => addSettingsSection(noSection));
});

test("storage change events live-reload the cache", () => {
  // Another tab replaced pf:configs behind our back.
  writes["pf:configs"] = {
    version: 1,
    settings: { controller: { stepSeek: 15 } }
  };
  assert.notEqual(getSetting("controller.stepSeek"), 15);
  configsListener?.("pf:configs", null, null, true);
  assert.equal(getSetting("controller.stepSeek"), 15);
  // Keys absent from the foreign doc fall back to defaults.
  assert.equal(getSetting("gestures.hotkeys"), true);
});

test("live-reload coerces type-violating foreign values", () => {
  // A foreign writer stored a string where the schema says boolean.
  writes["pf:configs"] = { version: 1, settings: { gestures: { hotkeys: "yes" } } };
  assert.notEqual(getSetting("gestures.hotkeys"), "yes");
  configsListener?.("pf:configs", null, null, true);
  assert.equal(getSetting("gestures.hotkeys"), true, "bool fields fall back to the schema default");
});

test("live-reload rejects option values outside the schema set", () => {
  // A 7-second skip step is not a member of the allowed [5, 10, 15] enum.
  writes["pf:configs"] = { version: 1, settings: { controller: { stepSeek: 7 } } };
  configsListener?.("pf:configs", null, null, true);
  assert.equal(getSetting("controller.stepSeek"), 5, "out-of-enum values fall back to the schema default");
});

test("settings changes notify subscribers exactly once (echo is a no-op)", () => {
  setSetting("gestures.hotkeys", true); // precondition, before subscribing
  let notifications = 0;
  const off = onSettingsChanged(() => { notifications++; });
  setSetting("gestures.hotkeys", false); // changed -> one dispatch; storage echo -> no dispatch
  assert.equal(notifications, 1, "own write fired exactly one notification");
  setSetting("gestures.hotkeys", false); // same value -> nothing
  assert.equal(notifications, 1, "a no-op write stays silent");
  off();
  setSetting("gestures.hotkeys", true); // restore
  assert.equal(notifications, 1, "unsubscribed listener is detached");
});

test("a cross-tab settings change re-syncs open controls without echoing back", () => {
  setSetting("controller.stepSeek", 5); // precondition: 5s is the active option
  setSetting("gestures.hotkeys", true);
  const panel = makeFakePanel();
  addSettingsSection(panel);
  const hotkeys = panel.calls.checkboxes[0];
  let echoCalls = 0;
  const originalOnChange = hotkeys.onChange;
  hotkeys.onChange = (value) => {
    echoCalls++;
    originalOnChange(value);
  };
  // stepSeek's option buttons render in schema order: [5s, 10s, 15s].
  const stepButtons = panel.calls.buttons;
  assert.equal(stepButtons.length, 3);
  assert.ok(stepButtons[0].classList.has("pf-options-active"), "5s active by default");

  // Another tab wrote: hotkeys off, stepSeek 15.
  writes["pf:configs"] = {
    version: 1,
    settings: { gestures: { hotkeys: false }, controller: { stepSeek: 15 } }
  };
  configsListener?.("pf:configs", null, null, true);

  assert.equal(hotkeys.checked, false, "checkbox follows the foreign value");
  assert.ok(!stepButtons[0].classList.has("pf-options-active"), "5s deactivated");
  assert.ok(stepButtons[2].classList.has("pf-options-active"), "15s activated");
  assert.equal(echoCalls, 0, "sync assigns values only - it never re-fires onChange");
});

test("a panel destroyed mid-life unsubscribes on the next change", () => {
  setSetting("gestures.hotkeys", true); // precondition, before the panel builds
  const panel = makeFakePanel();
  addSettingsSection(panel);
  const hotkeys = panel.calls.checkboxes[0];
  const before = hotkeys.checked;
  panel.body = null; // panel.destroy() nulls the body
  setSetting("gestures.hotkeys", !before);
  assert.equal(hotkeys.checked, before, "dead panel's controls are left alone");
  setSetting("gestures.hotkeys", before); // restore for later tests sharing the module cache
});

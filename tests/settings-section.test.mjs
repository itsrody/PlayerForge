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
  // Violentmonkey fires the listener for own-tab writes too.
  configsListener?.(key, null, value, false);
};

const { addSettingsSection, getSetting, setSetting } = await import("../src/shell/chrome/config.js");

function makeFakePanel() {
  const calls = { sections: [], labels: [], checkboxes: [], steppers: [] };
  const node = (tag, attrs = {}, parent = null) => {
    const el = { tag, attrs, parent, children: [], textContent: "", ariaLabel: null };
    el.setAttribute = (name, value) => {
      if (name === "aria-label") el.ariaLabel = value;
    };
    if (parent) parent.children.push(el);
    return el;
  };
  return {
    calls,
    body: {},
    el: (tag, attrs, parent) => node(tag, attrs, parent),
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
      return {};
    }
  };
}

test("renders one labeled section per unique schema group", () => {
  const panel = makeFakePanel();
  addSettingsSection(panel);
  assert.deepEqual(panel.calls.sections.map((s) => s.title), ["Settings"]);
  assert.deepEqual(panel.calls.labels, ["Playback", "Gestures", "Resume"]);
});

test("bool settings render toggles with labels and aria", () => {
  const panel = makeFakePanel();
  addSettingsSection(panel);
  assert.equal(panel.calls.checkboxes.length, 7);
  assert.ok(panel.calls.checkboxes.every((box) => typeof box.onChange === "function"));
  const hotkeys = panel.calls.checkboxes[0];
  assert.equal(hotkeys.checked, true);
  assert.equal(hotkeys.ariaLabel, "Keyboard hotkeys");
  const resumeToggle = panel.calls.checkboxes.find((box) => box.ariaLabel === "Remember playback position");
  assert.equal(resumeToggle.checked, true);
});

test("number settings render steppers with bounds and formatting", () => {
  const panel = makeFakePanel();
  addSettingsSection(panel);
  const fuzzStepper = panel.calls.steppers.find((s) => s.label === "Resume tolerance");
  assert.deepEqual(
    { min: fuzzStepper.min, max: fuzzStepper.max, step: fuzzStepper.step },
    { min: 0, max: 10, step: 1 }
  );
  assert.equal(fuzzStepper.format(5), "5s");
  assert.equal(fuzzStepper.value, getSetting("resume.durationFuzz"));
});

test("toggle onChange persists through setSetting", () => {
  const panel = makeFakePanel();
  addSettingsSection(panel);
  const hotkeysBox = panel.calls.checkboxes[0];
  hotkeysBox.onChange(false);
  assert.equal(getSetting("gestures.hotkeys"), false);
  assert.equal(writes["pf:configs"]?.settings?.gestures?.hotkeys, false);
});

test("stepper onChange persists through setSetting", () => {
  const panel = makeFakePanel();
  addSettingsSection(panel);
  const stepper = panel.calls.steppers.find((s) => s.label === "Resume tolerance");
  stepper.onChange(7);
  assert.equal(getSetting("resume.durationFuzz"), 7);
  assert.equal(writes["pf:configs"]?.settings?.resume?.durationFuzz, 7);
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
    settings: { controller: { holdSpeed: 3 }, resume: { durationFuzz: 9 } }
  };
  assert.notEqual(getSetting("controller.holdSpeed"), 3);
  configsListener?.("pf:configs", null, null, true);
  assert.equal(getSetting("controller.holdSpeed"), 3);
  assert.equal(getSetting("resume.durationFuzz"), 9);
  // Keys absent from the foreign doc fall back to defaults.
  assert.equal(getSetting("controller.stepSeek"), 5);
});

test("scrub sensitivity displays its effective multiplier", () => {
  const panel = makeFakePanel();
  addSettingsSection(panel);
  const stepper = panel.calls.steppers.find((s) => s.label === "Scrub sensitivity");
  assert.equal(stepper.format(150), "1.0x");
  assert.equal(stepper.format(300), "2.0x");
});

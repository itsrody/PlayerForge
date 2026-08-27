import test from "node:test";
import assert from "node:assert/strict";

const writes = {};
globalThis.GM_getValue = (key, fallback) => writes[key] ?? fallback;
globalThis.GM_setValue = (key, value) => { writes[key] = value; };
globalThis.GM_addValueChangeListener = () => {};

const { VideoFilter } = await import("../src/shell/filter.js");
const { invalidateConfigCache } = await import("../src/shared/storage.js");

function makeFakeVideo() {
  return { style: { filter: "" }, closest: () => null };
}

function makeFakeShell(video) {
  return { video, toast: () => {} };
}

function makeFakePanel() {
  const calls = { sections: [], selects: [], buttons: [], steppers: [] };
  const node = (tag, attrs = {}, parent = null) => {
    const el = {
      tag, attrs, parent, children: [], textContent: "", style: {},
      setAttribute: () => {},
      addEventListener: () => {},
      classList: { add: () => {}, remove: () => {}, has: () => false, toggle: () => {} }
    };
    if (parent) parent.children.push(el);
    return el;
  };
  const panel = {
    calls,
    el: (tag, attrs, parent) => node(tag, attrs, parent),
    addSection: (title, icon) => {
      const root = node("section", { title });
      calls.sections.push({ title, icon, root });
      return root;
    },
    addLabel: (parent, text) => node("label", { text }, parent),
    addSelect: (parent, opts) => {
      calls.selects.push(opts);
      let val = opts.value;
      return {
        get value() { return val; },
        set value(v) { val = v; },
        setValue: (v) => { val = v; },
        style: {}
      };
    },
    addButton: (parent, opts) => {
      calls.buttons.push(opts);
      return { classList: { add: () => {}, remove: () => {} }, disabled: false, style: {} };
    },
    addStepper: (parent, opts) => {
      calls.steppers.push(opts);
      let val = opts.value;
      return {
        getValue: () => val,
        setValue: (v) => { val = v; },
        setDisabled: () => {},
        get value() { return val; },
        set value(v) { val = v; }
      };
    },
    addControl: (parent, { type, ...opts }) => {
      switch (type) {
        case "select": return panel.addSelect(parent, opts);
        case "button": return panel.addButton(parent, opts);
        case "stepper": return panel.addStepper(parent, opts);
        default: return null;
      }
    }
  };
  return panel;
}

function cleanWrites() {
  for (const key of Object.keys(writes)) {
    delete writes[key];
  }
  // Drop the storage read-cache so the next test seeds from a clean doc.
  invalidateConfigCache();
}

test("applies default filter as 'none'", () => {
  cleanWrites();
  const video = makeFakeVideo();
  const panel = makeFakePanel();
  new VideoFilter(makeFakeShell(video), panel);
  assert.equal(video.style.filter, "none");
});

test("creates Color section with 9 steppers and 1 select", () => {
  cleanWrites();
  const panel = makeFakePanel();
  new VideoFilter(makeFakeShell(makeFakeVideo()), panel);
  assert.equal(panel.calls.sections.length, 1);
  assert.equal(panel.calls.sections[0].title, "Color");
  assert.equal(panel.calls.steppers.length, 9);
  assert.equal(panel.calls.selects.length, 1);
  assert.equal(panel.calls.buttons.length, 1);
});

test("stepper labels include Temperature and Tint", () => {
  cleanWrites();
  const panel = makeFakePanel();
  new VideoFilter(makeFakeShell(makeFakeVideo()), panel);
  const labels = panel.calls.steppers.map((s) => s.label);
  assert.ok(labels.includes("Temp"), "should have Temp stepper");
  assert.ok(labels.includes("Tint"), "should have Tint stepper");
});

test("preset dropdown has all presets plus Custom", () => {
  cleanWrites();
  const panel = makeFakePanel();
  new VideoFilter(makeFakeShell(makeFakeVideo()), panel);
  const opts = panel.calls.selects[0].options;
  assert.ok(opts.includes("Default"));
  assert.ok(opts.includes("Cinematic"));
  assert.ok(opts.includes("Vibrant"));
  assert.ok(opts.includes("B&W"));
  assert.ok(opts.includes("Sepia"));
  assert.ok(opts.includes("Night"));
  assert.ok(opts.includes("Inverted"));
  assert.ok(opts.includes("Teal & Orange"));
  assert.ok(opts.includes("Film Kodak"));
  assert.ok(opts.includes("Bleach Bypass"));
  assert.ok(opts.includes("Cross Process"));
  assert.ok(opts.includes("Vintage"));
  assert.ok(opts.includes("Cold Tone"));
  assert.ok(opts.includes("Warm Tone"));
  assert.ok(opts.includes("Custom"));
});

test("non-default values produce correct filter string", () => {
  cleanWrites();
  const video = makeFakeVideo();
  const panel = makeFakePanel();
  const filter = new VideoFilter(makeFakeShell(video), panel);

  const brightnessStepper = panel.calls.steppers.find((s) => s.label === "Brightness");
  brightnessStepper.onChange(150);
  assert.ok(video.style.filter.includes("brightness(150%)"));

  const hueStepper = panel.calls.steppers.find((s) => s.label === "Hue");
  hueStepper.onChange(45);
  assert.ok(video.style.filter.includes("hue-rotate(45deg)"));

  const grayscaleStepper = panel.calls.steppers.find((s) => s.label === "Grayscale");
  grayscaleStepper.onChange(80);
  assert.ok(video.style.filter.includes("grayscale(80%)"));

  filter.destroy();
});

test("temperature affects hue-rotate and saturate", () => {
  cleanWrites();
  const video = makeFakeVideo();
  const panel = makeFakePanel();
  const filter = new VideoFilter(makeFakeShell(video), panel);

  const tempStepper = panel.calls.steppers.find((s) => s.label === "Temp");
  tempStepper.onChange(50);
  const f = video.style.filter;
  assert.ok(f.includes("hue-rotate(15deg)"), `expected hue-rotate(15deg) in "${f}"`);
  assert.ok(f.includes("saturate("), `expected saturate in "${f}"`);
  filter.destroy();
});

test("tint affects hue-rotate", () => {
  cleanWrites();
  const video = makeFakeVideo();
  const panel = makeFakePanel();
  const filter = new VideoFilter(makeFakeShell(video), panel);

  const tintStepper = panel.calls.steppers.find((s) => s.label === "Tint");
  tintStepper.onChange(50);
  assert.ok(video.style.filter.includes("hue-rotate(10deg)"));
  filter.destroy();
});

test("reset restores defaults and clears filter", () => {
  cleanWrites();
  const video = makeFakeVideo();
  const panel = makeFakePanel();
  const filter = new VideoFilter(makeFakeShell(video), panel);

  const brightnessStepper = panel.calls.steppers.find((s) => s.label === "Brightness");
  brightnessStepper.onChange(200);
  assert.ok(video.style.filter.includes("brightness(200%)"));

  filter.reset();
  assert.equal(video.style.filter, "none");
});

test("destroy clears video filter", () => {
  cleanWrites();
  const video = makeFakeVideo();
  const panel = makeFakePanel();
  const filter = new VideoFilter(makeFakeShell(video), panel);

  const brightnessStepper = panel.calls.steppers.find((s) => s.label === "Brightness");
  brightnessStepper.onChange(150);
  assert.ok(video.style.filter.includes("brightness(150%)"));

  filter.destroy();
  assert.equal(video.style.filter, "");
});

test("persist writes to pf:configs", () => {
  cleanWrites();
  const video = makeFakeVideo();
  const panel = makeFakePanel();
  const filter = new VideoFilter(makeFakeShell(video), panel);

  const contrastStepper = panel.calls.steppers.find((s) => s.label === "Contrast");
  contrastStepper.onChange(130);
  assert.equal(writes["pf:configs"]?.filter?.contrast, 130);
  filter.destroy();
});

test("second destroy is a no-op", () => {
  cleanWrites();
  const video = makeFakeVideo();
  const panel = makeFakePanel();
  const filter = new VideoFilter(makeFakeShell(video), panel);
  filter.destroy();
  filter.destroy();
  assert.equal(video.style.filter, "");
});

test("temperature persists to config", () => {
  cleanWrites();
  const video = makeFakeVideo();
  const panel = makeFakePanel();
  const filter = new VideoFilter(makeFakeShell(video), panel);

  const tempStepper = panel.calls.steppers.find((s) => s.label === "Temp");
  tempStepper.onChange(30);
  assert.equal(writes["pf:configs"]?.filter?.temperature, 30);
  filter.destroy();
});

test("tint persists to config", () => {
  cleanWrites();
  const video = makeFakeVideo();
  const panel = makeFakePanel();
  const filter = new VideoFilter(makeFakeShell(video), panel);

  const tintStepper = panel.calls.steppers.find((s) => s.label === "Tint");
  tintStepper.onChange(-20);
  assert.equal(writes["pf:configs"]?.filter?.tint, -20);
  filter.destroy();
});

test("preset apply persists all fields in a single write", () => {
  cleanWrites();
  const video = makeFakeVideo();
  const panel = makeFakePanel();
  const filter = new VideoFilter(makeFakeShell(video), panel);
  let setCalls = 0;
  const realSet = globalThis.GM_setValue;
  globalThis.GM_setValue = (key, value) => {
    setCalls += 1;
    writes[key] = value;
  };

  panel.calls.selects[0].onChange("Cinematic");

  globalThis.GM_setValue = realSet;
  assert.equal(setCalls, 1, "all preset fields coalesce into a single write");
  assert.equal(Object.keys(writes["pf:configs"]?.filter ?? {}).length, 9, "all color fields persisted in one doc");
  filter.destroy();
});

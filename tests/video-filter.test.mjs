import test from "node:test";
import assert from "node:assert/strict";

const writes = {};
globalThis.GM_getValue = (key, fallback) => writes[key] ?? fallback;
globalThis.GM_setValue = (key, value) => { writes[key] = value; };
globalThis.GM_addValueChangeListener = () => {};

const { VideoFilter } = await import("../src/shell/filter.js");

function makeFakeVideo() {
  return { style: { filter: "" } };
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
      return { value: opts.value, style: {} };
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
        setDisabled: () => {}
      };
    }
  };
  return panel;
}

function cleanWrites() {
  for (const key of Object.keys(writes)) {
    delete writes[key];
  }
}

test("applies default filter as 'none'", () => {
  const video = makeFakeVideo();
  const panel = makeFakePanel();
  new VideoFilter(video, panel);
  assert.equal(video.style.filter, "none");
});

test("creates Color section with 7 steppers", () => {
  const panel = makeFakePanel();
  new VideoFilter(makeFakeVideo(), panel);
  assert.equal(panel.calls.sections.length, 1);
  assert.equal(panel.calls.sections[0].title, "Color");
  assert.equal(panel.calls.steppers.length, 7);
  assert.equal(panel.calls.selects.length, 1);
  assert.equal(panel.calls.buttons.length, 1);
});

test("preset dropdown has all presets plus Custom", () => {
  const panel = makeFakePanel();
  new VideoFilter(makeFakeVideo(), panel);
  const opts = panel.calls.selects[0].options;
  assert.ok(opts.includes("Default"));
  assert.ok(opts.includes("Cinematic"));
  assert.ok(opts.includes("Vibrant"));
  assert.ok(opts.includes("B&W"));
  assert.ok(opts.includes("Sepia"));
  assert.ok(opts.includes("Night"));
  assert.ok(opts.includes("Inverted"));
  assert.ok(opts.includes("Custom"));
});

test("non-default values produce correct filter string", () => {
  const video = makeFakeVideo();
  const panel = makeFakePanel();
  const filter = new VideoFilter(video, panel);
  filter.destroy();

  const video2 = makeFakeVideo();
  const panel2 = makeFakePanel();
  const filter2 = new VideoFilter(video2, panel2);

  const brightnessStepper = panel2.calls.steppers.find((s) => s.label === "Brightness");
  brightnessStepper.onChange(150);
  assert.ok(video2.style.filter.includes("brightness(150%)"));

  const hueStepper = panel2.calls.steppers.find((s) => s.label === "Hue");
  hueStepper.onChange(45);
  assert.ok(video2.style.filter.includes("hue-rotate(45deg)"));

  const grayscaleStepper = panel2.calls.steppers.find((s) => s.label === "Grayscale");
  grayscaleStepper.onChange(80);
  assert.ok(video2.style.filter.includes("grayscale(80%)"));
});

test("reset restores defaults and clears filter", () => {
  const video = makeFakeVideo();
  const panel = makeFakePanel();
  const filter = new VideoFilter(video, panel);

  const brightnessStepper = panel.calls.steppers.find((s) => s.label === "Brightness");
  brightnessStepper.onChange(200);
  assert.ok(video.style.filter.includes("brightness(200%)"));

  filter.reset();
  assert.equal(video.style.filter, "none");
});

test("destroy clears video filter", () => {
  const video = makeFakeVideo();
  const panel = makeFakePanel();
  const filter = new VideoFilter(video, panel);

  const brightnessStepper = panel.calls.steppers.find((s) => s.label === "Brightness");
  brightnessStepper.onChange(150);
  assert.ok(video.style.filter.includes("brightness(150%)"));

  filter.destroy();
  assert.equal(video.style.filter, "");
});

test("persist writes to pf:configs", () => {
  const video = makeFakeVideo();
  const panel = makeFakePanel();
  const filter = new VideoFilter(video, panel);

  const contrastStepper = panel.calls.steppers.find((s) => s.label === "Contrast");
  contrastStepper.onChange(130);
  assert.equal(writes["pf:configs"]?.filter?.contrast, 130);
});

test("second destroy is a no-op", () => {
  const video = makeFakeVideo();
  const panel = makeFakePanel();
  const filter = new VideoFilter(video, panel);
  filter.destroy();
  filter.destroy();
  assert.equal(video.style.filter, "");
});

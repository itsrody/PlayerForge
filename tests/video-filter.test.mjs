import test from "node:test";
import assert from "node:assert/strict";

const writes = {};
globalThis.GM_getValue = (key, fallback) => writes[key] ?? fallback;
globalThis.GM_setValue = (key, value) => { writes[key] = value; };
globalThis.GM_addValueChangeListener = () => {};

const { VideoFilter } = await import("../src/shell/filter.js");
const { configStore, setConfigFields } = await import("../src/shared/storage.js");

function makeFakeVideo() {
  return { style: { filter: "" }, closest: () => null };
}

function makeFakeShell(video) {
  return { video, toast: () => {}, toastFlash: () => {}, toastInfo: () => {}, toastHint: () => {}, toastAction: () => {} };
}

function makeFakePanel() {
  const calls = { sections: [], selects: [], buttons: [], steppers: [], stepperHandles: [], selectHandles: [] };
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
      const handle = {
        get value() { return val; },
        set value(v) { val = v; },
        setValue: (v) => { val = v; },
        style: {}
      };
      calls.selectHandles.push(handle);
      return handle;
    },
    addButton: (parent, opts) => {
      calls.buttons.push(opts);
      return { classList: { add: () => {}, remove: () => {} }, disabled: false, style: {} };
    },
    addStepper: (parent, opts) => {
      calls.steppers.push(opts);
      let val = opts.value;
      const handle = {
        getValue: () => val,
        // The production widget cascades setValue through onChange like a
        // user edit (panel.js); the fake does the same so bulk paths pay
        // their real re-entry cost here.
        setValue: (v) => {
          if (v !== val) {
            val = v;
            opts.onChange?.(v);
          }
        },
        setDisabled: () => {},
        get value() { return val; },
        set value(v) { val = v; }
      };
      calls.stepperHandles.push(handle);
      return handle;
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
  // Reset the owned document so the next test seeds from a clean doc.
  configStore.adopt({ version: 1 });
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
  assert.ok(opts.includes("Vintage"));
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
  filter.destroy();
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("persist writes to pf:configs after the trailing debounce", async () => {
  cleanWrites();
  const video = makeFakeVideo();
  const panel = makeFakePanel();
  const filter = new VideoFilter(makeFakeShell(video), panel);

  const contrastStepper = panel.calls.steppers.find((s) => s.label === "Contrast");
  contrastStepper.onChange(130);
  assert.equal(writes["pf:configs"]?.filter?.contrast, undefined,
    "preview is instant but the storage write waits for the drag to settle");
  await sleep(380);
  assert.equal(writes["pf:configs"]?.filter?.contrast, 130);
  filter.destroy();
});

test("the trailing persist is issued at background priority", async () => {
  // §5: "History and diagnostics never block input - assert every such write
  // issues at background". Before phase 3 the persist was a plain debounce,
  // which defaults to postTask's user-visible, so a settings write sat in the
  // same queue as the HUD commit it has no business competing with.
  cleanWrites();
  const video = makeFakeVideo();
  const panel = makeFakePanel();
  const filter = new VideoFilter(makeFakeShell(video), panel);

  const priorities = [];
  const originalPostTask = globalThis.scheduler.postTask;
  globalThis.scheduler.postTask = (fn, opts = {}) => {
    priorities.push(opts.priority);
    return originalPostTask(fn, opts);
  };
  try {
    const contrastStepper = panel.calls.steppers.find((s) => s.label === "Contrast");
    contrastStepper.onChange(145);
    await sleep(380);
  } finally {
    globalThis.scheduler.postTask = originalPostTask;
  }

  assert.deepEqual(priorities, ["background"],
    `the one deferred task in this window is the persist, and it must be background; saw ${JSON.stringify(priorities)}`);
  assert.equal(writes["pf:configs"]?.filter?.contrast, 145, "and it still lands");
  filter.destroy();
});

test("rapid stepper changes coalesce into a single storage write", async () => {
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

  const brightnessStepper = panel.calls.steppers.find((s) => s.label === "Brightness");
  for (const value of [110, 120, 130]) {
    brightnessStepper.onChange(value);
  }
  await sleep(380);

  globalThis.GM_setValue = realSet;
  assert.equal(setCalls, 1, "a drag burst settles to exactly one write");
  assert.equal(writes["pf:configs"]?.filter?.brightness, 130);
  filter.destroy();
});

test("destroy flushes a pending persist so the last value lands", () => {
  cleanWrites();
  const video = makeFakeVideo();
  const panel = makeFakePanel();
  const filter = new VideoFilter(makeFakeShell(video), panel);

  const tintStepper = panel.calls.steppers.find((s) => s.label === "Tint");
  tintStepper.onChange(-20);
  assert.equal(writes["pf:configs"], undefined, "nothing persisted until flushed");
  filter.destroy();
  assert.equal(writes["pf:configs"]?.filter?.tint, -20);
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

test("temperature persists to config", async () => {
  cleanWrites();
  const video = makeFakeVideo();
  const panel = makeFakePanel();
  const filter = new VideoFilter(makeFakeShell(video), panel);

  const tempStepper = panel.calls.steppers.find((s) => s.label === "Temp");
  tempStepper.onChange(30);
  await sleep(380);
  assert.equal(writes["pf:configs"]?.filter?.temperature, 30);
  filter.destroy();
});

test("tint persists to config", async () => {
  cleanWrites();
  const video = makeFakeVideo();
  const panel = makeFakePanel();
  const filter = new VideoFilter(makeFakeShell(video), panel);

  const tintStepper = panel.calls.steppers.find((s) => s.label === "Tint");
  tintStepper.onChange(-20);
  await sleep(380);
  assert.equal(writes["pf:configs"]?.filter?.tint, -20);
  filter.destroy();
});

test("preset apply persists all fields in a single write", async () => {
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
  await sleep(380);

  globalThis.GM_setValue = realSet;
  assert.equal(setCalls, 1, "all preset fields coalesce into a single write");
  assert.equal(Object.keys(writes["pf:configs"]?.filter ?? {}).length, 9, "all color fields persisted in one doc");
  filter.destroy();
});

test("a stored 0 saturate survives the reload path and desaturates the video [regression]", () => {
  // 0 is a real, reachable value (the stepper range starts at 0 and the B&W
  // preset stores saturate: 0). `Number(raw) || def` and
  // `values.saturate || DEFAULTS.saturate` both turned it into 100, so a
  // user who desaturated the video got full colour back with no way to tell
  // why.
  cleanWrites();
  configStore.adopt({ version: 1, filter: { saturate: 0 } });

  const video = makeFakeVideo();
  const filter = new VideoFilter(makeFakeShell(video), makeFakePanel());
  assert.match(video.style.filter, /saturate\(0%\)/, "stored 0 must not become the default 100");
  filter.destroy();
});

test("a stored 0 brightness and contrast survive the reload path [regression]", () => {
  cleanWrites();
  configStore.adopt({ version: 1, filter: { brightness: 0, contrast: 0 } });

  const video = makeFakeVideo();
  const filter = new VideoFilter(makeFakeShell(video), makeFakePanel());
  assert.match(video.style.filter, /brightness\(0%\)/);
  assert.match(video.style.filter, /contrast\(0%\)/);
  filter.destroy();
});

test("garbage stored values still fall back to the default", () => {
  cleanWrites();
  configStore.adopt({ version: 1, filter: { saturate: "nonsense" } });

  const video = makeFakeVideo();
  const filter = new VideoFilter(makeFakeShell(video), makeFakePanel());
  assert.equal(video.style.filter, "none", "unusable input falls back, not NaN leaking into the string");
  filter.destroy();
});

test("non-numeric stored values fall back instead of coercing", () => {
  // Number([]) is 0 and Number(true) is 1: accepting either hands a
  // hand-edited store a black video (brightness 0) the page never asked
  // for. Only numbers and numeric strings are usable.
  cleanWrites();
  configStore.adopt({ version: 1, filter: { brightness: [], contrast: true, saturate: "  ", hue: "45" } });

  const video = makeFakeVideo();
  const filter = new VideoFilter(makeFakeShell(video), makeFakePanel());
  assert.equal(video.style.filter, "hue-rotate(45deg)", "only the numeric string survived; junk took defaults");
  filter.destroy();
});

test("a foreign filter write live-reloads values, steppers and the select", () => {
  // A write from another tab arrives through the store, not through a
  // stepper: the video, the widgets and the preset menu must all follow
  // without a rebuild.
  cleanWrites();
  const video = makeFakeVideo();
  const panel = makeFakePanel();
  const filter = new VideoFilter(makeFakeShell(video), panel);
  assert.equal(video.style.filter, "none");

  setConfigFields({ "filter.contrast": 130, "filter.saturate": 0 });
  assert.match(video.style.filter, /contrast\(130%\)/, "the video follows the foreign write");
  assert.match(video.style.filter, /saturate\(0%\)/);
  const contrastIdx = panel.calls.steppers.findIndex((s) => s.label === "Contrast");
  assert.equal(panel.calls.stepperHandles[contrastIdx].getValue(), 130, "the widget follows");
  assert.equal(panel.calls.selectHandles[0].value, "Custom", "the menu follows");
  filter.destroy();
});

test("destroy restores the embed's own inline filter", () => {
  cleanWrites();
  configStore.adopt({ version: 1 });

  const video = makeFakeVideo();
  // The host page is already filtering this video (e.g. a dimmed background
  // slot). `filter` is inherited CSS, so clearing to "" would silently drop
  // the page's styling on teardown.
  video.style.filter = "grayscale(1)";

  const filter = new VideoFilter(makeFakeShell(video), makeFakePanel());
  assert.notEqual(video.style.filter, "grayscale(1)", "precondition: PF overwrote the page value");

  filter.destroy();
  assert.equal(video.style.filter, "grayscale(1)", "destroy discarded the page's filter");
});

test("destroy still clears a video that had no prior filter", () => {
  cleanWrites();
  configStore.adopt({ version: 1 });

  const video = makeFakeVideo();
  const filter = new VideoFilter(makeFakeShell(video), makeFakePanel());
  filter.destroy();

  assert.equal(video.style.filter, "", "PF's own filter string was left behind");
});

test("the prior filter is captured once and survives repeated applies", () => {
  cleanWrites();
  configStore.adopt({ version: 1 });

  const video = makeFakeVideo();
  video.style.filter = "sepia(0.5)";
  const panel = makeFakePanel();
  const filter = new VideoFilter(makeFakeShell(video), panel);

  // Two more applies: a capture that re-reads on every apply would store PF's
  // own previous string on the second one and restore that instead.
  panel.calls.steppers.find((s) => s.label === "Brightness").onChange(150);
  panel.calls.steppers.find((s) => s.label === "Contrast").onChange(120);

  filter.destroy();
  assert.equal(video.style.filter, "sepia(0.5)");
});

/* - Bulk-path write coalescing - */

/** A video whose style.filter writes are counted, not just last-valued. */
function makeCountingVideo() {
  let filterValue = "";
  let filterWrites = 0;
  const style = {};
  Object.defineProperty(style, "filter", {
    get: () => filterValue,
    set: (v) => {
      filterValue = v;
      filterWrites += 1;
    },
    configurable: true
  });
  return {
    video: { style, closest: () => null },
    writes: () => filterWrites,
    value: () => filterValue
  };
}

test("a preset lands in one style write, not one per stepper", () => {
  cleanWrites();
  const { video, writes, value } = makeCountingVideo();
  const panel = makeFakePanel();
  const filter = new VideoFilter(makeFakeShell(video), panel);
  const bootWrites = writes();

  panel.calls.selects[0].onChange("Cinematic");
  assert.equal(writes() - bootWrites, 1, "bulk set stages values, one apply paints");
  assert.ok(value().length > 0, "the preset actually painted");

  filter.destroy();
});

test("reset lands in one style write, not one per stepper", () => {
  cleanWrites();
  const { video, writes, value } = makeCountingVideo();
  const panel = makeFakePanel();
  const filter = new VideoFilter(makeFakeShell(video), panel);
  panel.calls.selects[0].onChange("Cinematic");
  const beforeReset = writes();

  filter.reset();
  assert.equal(writes() - beforeReset, 1, "bulk reset stages values, one apply paints");
  assert.ok(value().includes("none") || value() === "", "defaults painted back");
  filter.destroy();
});

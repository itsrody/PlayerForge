/**
 * Input latency browser benchmark.
 *
 * Measures pointer event → gesture CustomEvent dispatch latency in Chromium 154.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChromiumDriver, TestServer, createTestPage } from "../harness/chromium.mjs";
import { waitForShell } from "../harness/page.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUNDLE = readFileSync(join(HERE, "..", "..", "dist", "playerforge.user.js"), "utf8");

const BATCHES = 9;
const ITERATIONS = 40;

export default async function runInputLatencyBench(bundle = DEFAULT_BUNDLE) {
  const server = new TestServer();
  await server.start();
  const driver = await ChromiumDriver.launch();
  const results = [];

  try {
    await driver.navigate(createTestPage(server));
    await driver.injectGMStubs();
    await driver.injectScript(bundle);
    await waitForShell(driver, 8000);

    // Benchmark: keyboard event → gesture dispatch.
    // The keyboard path requires video.readyState > 0 (the #isActive gate
    // in forge.js), so we mock it on the test video which has no src.
    await driver.eval(() => {
      const video = document.getElementById("test-video");
      Object.defineProperty(video, "readyState", { value: 4, configurable: true });
    });

    const keyTimes = [];
    for (let b = 0; b < BATCHES; b++) {
      const timings = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const elapsed = await driver.eval(() => {
          return new Promise((resolve) => {
            const host = document.querySelector(".pf-shell");
            const t0 = performance.now();
            const handler = () => {
              host.removeEventListener("pf:gesture-skip", handler);
              resolve(performance.now() - t0);
            };
            host.addEventListener("pf:gesture-skip", handler);
            document.dispatchEvent(new KeyboardEvent("keydown", {
              key: "ArrowRight", code: "ArrowRight", bubbles: true, cancelable: true
            }));
            setTimeout(() => {
              host.removeEventListener("pf:gesture-skip", handler);
              resolve(performance.now() - t0);
            }, 100);
          });
        });
        timings.push(elapsed);
      }
      const batchMedian = timings.sort((a, b) => a - b)[Math.floor(timings.length / 2)];
      keyTimes.push(batchMedian);
    }

    keyTimes.sort((a, b) => a - b);
    // gateable: false on both rows below. These are async end-to-end round
    // trips (dispatch -> forge -> recognizer -> CustomEvent) that cost ~20-80us,
    // i.e. at or below the 100us Chromium performance.now() tick. Each sample
    // is therefore zero or a small integer number of ticks, the median snaps
    // between those levels run to run, and spread runs ±50-300% - wider than
    // the ±20% regression gate, so a baseline here would flake rather than
    // detect. They cannot be amplified the way the sync rows are: the op is a
    // promise, and repeating it would fire tens of thousands of real skips /
    // dbltaps, which both mutates playback state and changes the very debounce
    // behaviour being measured. Reported for visibility, not gated.
    results.push({
      name: "keyboard → gesture dispatch (ArrowRight → skip)",
      medianMsPerOp: keyTimes[Math.floor(keyTimes.length / 2)],
      spread: (keyTimes[keyTimes.length - 1] - keyTimes[0]) / keyTimes[Math.floor(keyTimes.length / 2)],
      gateable: false,
    });

    // Benchmark: pointer double-tap recognition.
    // dbltap is fullscreen-only (fs: true binding), so we must set the
    // fullscreen gate before dispatching events.
    await driver.eval(() => {
      const video = document.getElementById("test-video");
      Object.defineProperty(document, "fullscreenElement", {
        value: video, configurable: true
      });
      document.dispatchEvent(new Event("fullscreenchange"));
    });

    const pointerTimes = [];
    for (let b = 0; b < BATCHES; b++) {
      const timings = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const elapsed = await driver.eval(() => {
          return new Promise((resolve) => {
            const video = document.getElementById("test-video");
            const rect = video?.getBoundingClientRect() || { left: 0, top: 0, width: 800, height: 450 };
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const host = document.querySelector(".pf-shell");
            const t0 = performance.now();
            const handler = () => {
              host.removeEventListener("pf:gesture-dbltap", handler);
              resolve(performance.now() - t0);
            };
            host.addEventListener("pf:gesture-dbltap", handler);
            for (let j = 0; j < 2; j++) {
              video.dispatchEvent(new PointerEvent("pointerdown", {
                clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 1
              }));
              video.dispatchEvent(new PointerEvent("pointerup", {
                clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 1
              }));
            }
            setTimeout(() => {
              host.removeEventListener("pf:gesture-dbltap", handler);
              resolve(performance.now() - t0);
            }, 200);
          });
        });
        timings.push(elapsed);
      }
      const batchMedian = timings.sort((a, b) => a - b)[Math.floor(timings.length / 2)];
      pointerTimes.push(batchMedian);
    }

    pointerTimes.sort((a, b) => a - b);
    results.push({
      name: "pointer events → dbltap gesture recognition",
      medianMsPerOp: pointerTimes[Math.floor(pointerTimes.length / 2)],
      spread: (pointerTimes[pointerTimes.length - 1] - pointerTimes[0]) / pointerTimes[Math.floor(pointerTimes.length / 2)],
      gateable: false,
    });
  } finally {
    await driver.destroy();
    await server.stop();
  }

  return results;
}

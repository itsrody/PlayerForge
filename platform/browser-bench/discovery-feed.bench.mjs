/**
 * Discovery-feed mutation cost browser benchmark.
 *
 * PlayerForge pays exactly one steady-state per-mutation tax: the SHARED
 * discovery feed (onDomMutations) stays subscribed for as long as a
 * <video> exists that has not yet reached player size. installVideoProbe
 * arms it on seeing a non-player-sized video and detaches on the first
 * qualifying candidate; the kernel's own full-document tap does the same
 * until its first successful adoption, then downgrades to the cheap
 * capture-mode media-event tap. So the worst case is a page that has a
 * small/ads video and never surfaces a real player - and that is what this
 * benchmark reproduces: the page's video is shrunk below the
 * MIN_VIDEO_WIDTH x MIN_VIDEO_HEIGHT gate, which leaves the feed armed for
 * the whole run.
 *
 * The delta between the two rows is the per-mutation cost of that feed on
 * SPA-style churn - what the added-subtree scan (scoped to nodes a batch
 * actually added, instead of a full-document reseed) is meant to keep near
 * zero.
 *
 * NOT measured here, despite what this file used to claim: there is no
 * iframe cache and no document observer in the frame bridge. The vouch is
 * a live querySelectorAll("iframe") scan that runs only for a request that
 * already passed the type/nonce gate (see iframeElementForWindow in
 * src/shared/context.js), so it costs nothing per mutation.
 *
 * The PF row self-checks its own premise: after the bursts it inserts a
 * qualifying Plyr tree and waits for the HUD. A HUD appearing proves the
 * feed really was live and delivering, rather than the row silently
 * measuring a page where PF had booted and downgraded itself out of the way.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FirefoxDriver, TestServer, createTestPage } from "../harness/firefox.mjs";
import { waitForShell } from "../harness/page.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUNDLE = readFileSync(join(HERE, "..", "..", "dist", "playerforge.user.js"), "utf8");

const BATCHES = 7;
const ITERATIONS = 25;
const FRAME_COUNT = 8;
const CHURN_NODES = 120;

/** Below MIN_VIDEO_WIDTH x MIN_VIDEO_HEIGHT (100x60) in src/kernel/sdk.js, so
 *  the probe escalates to the mutation feed and never finds a candidate. */
const STUB_VIDEO_SIZE = { width: 60, height: 40 };

/** One churn burst: append + remove a subtree of `churn` unrelated nodes and
 *  return the wall time through the microtask checkpoint that flushes the
 *  observer. The double continuation guarantees the MutationObserver callback
 *  queued by this burst has run before the clock stops (the second chain runs
 *  after the observer's microtask). */
const burstTiming = (driver, churn) => driver.eval(
  (n) => new Promise((resolve) => {
    const t0 = performance.now();
    const host = document.createElement("div");
    host.className = "pf-bench-churn";
    for (let i = 0; i < n; i++) {
      host.appendChild(document.createElement("div"));
    }
    document.body.appendChild(host);
    Promise.resolve().then(() => Promise.resolve()).then(() => {
      host.remove();
      resolve(performance.now() - t0);
    });
  }),
  churn
);

/** Batch/iteration loop mirroring the other browser benches: per-batch median
 *  burst time, then median + spread across batches. */
async function measureBurst(driver, churn) {
  const samples = [];
  for (let b = 0; b < BATCHES; b++) {
    const timings = [];
    for (let i = 0; i < ITERATIONS; i++) {
      timings.push(await burstTiming(driver, churn));
    }
    timings.sort((a, b) => a - b);
    samples.push(timings[Math.floor(timings.length / 2)]);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  return {
    medianMsPerOp: median,
    spread: (samples[samples.length - 1] - samples[0]) / median,
  };
}

/** Shrink the page's video below the size gate, so PF's discovery feed stays
 *  armed instead of the kernel booting and downgrading the tap. */
const shrinkVideoBelowGate = (driver) => driver.eval(
  (size) => {
    const video = document.querySelector("video");
    if (!video) {
      return { ok: false, reason: "no video" };
    }
    video.style.width = `${size.width}px`;
    video.style.height = `${size.height}px`;
    // Force layout so the gate reads the shrunk box, not the pending 100%.
    const rect = video.getBoundingClientRect();
    return { ok: rect.width < 100 && rect.height < 60, width: rect.width, height: rect.height };
  },
  STUB_VIDEO_SIZE
);

export default async function runDiscoveryFeedBench(bundle = DEFAULT_BUNDLE) {
  const server = new TestServer();
  await server.start();
  const driver = await FirefoxDriver.launch();
  const results = [];
  const suffix = `${CHURN_NODES} nodes/burst, ${FRAME_COUNT} iframes`;

  try {
    // Control: identical protocol, no userscript - isolates pure DOM churn.
    await driver.navigate(createTestPage(server));
    await driver.injectGMStubs();
    await shrinkVideoBelowGate(driver);
    await driver.eval((frameCount) => {
      for (let i = 0; i < frameCount; i++) {
        const f = document.createElement("iframe");
        f.setAttribute("data-pf-bench-frame", "");
        f.style.display = "none";
        document.body.appendChild(f);
      }
    }, FRAME_COUNT);
    results.push({
      name: `mutation burst, no PF (${suffix})`,
      ...(await measureBurst(driver, CHURN_NODES)),
    });

    // Active: same page, with PF installed and its discovery feed armed.
    await driver.navigate(createTestPage(server));
    await driver.injectGMStubs();
    await shrinkVideoBelowGate(driver);
    await driver.eval((frameCount) => {
      for (let i = 0; i < frameCount; i++) {
        const f = document.createElement("iframe");
        f.setAttribute("data-pf-bench-frame", "");
        f.style.display = "none";
        document.body.appendChild(f);
      }
    }, FRAME_COUNT);
    await driver.injectScript(bundle);
    results.push({
      name: `mutation burst, PF discovery feed live (${suffix})`,
      ...(await measureBurst(driver, CHURN_NODES)),
    });

    // Self-check the premise: a qualifying Plyr tree inserted NOW has to be
    // discovered and booted, which is only possible if the feed really was
    // subscribed during the bursts above.
    await driver.eval(() => {
      const wrap = document.createElement("div");
      wrap.className = "plyr";
      wrap.setAttribute("data-plyr", "");
      const inner = document.createElement("div");
      inner.className = "plyr__video-wrapper";
      const video = document.createElement("video");
      video.style.width = "640px";
      video.style.height = "360px";
      inner.appendChild(video);
      wrap.appendChild(inner);
      document.body.appendChild(wrap);
    });
    const booted = await waitForShell(driver, 5000);
    if (!booted) {
      throw new Error(
        "discovery-feed bench: PF never booted from a late-inserted player, so the " +
        "'feed live' row did not measure an armed feed - fix the page setup before trusting it"
      );
    }
  } finally {
    await driver.destroy();
    await server.stop();
  }

  return results;
}

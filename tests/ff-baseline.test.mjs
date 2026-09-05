import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Source-level invariants for the Firefox 155+ porting principles. These are
 * NOT functional tests - they pin the engine-native decisions this branch
 * relies on so a future edit can't silently regress them:
 *
 *   - esbuild targets `firefox155` (Warp-safe minification baseline).
 *   - scheduler.yield()/postTask() are native in FF 142+ (baseline 155), so
 *     no dead Chromium-style setTimeout fallback may drift back into the
 *     sizeable parse / construction paths.
 *   - every FF-155+-native API (AbortSignal.any/timeout, checkVisibility,
 *     startViewTransition, getCoalesced/PredictedEvents, WAAPI animate) is
 *     invoked unguarded - no cross-browser feature-detect may return.
 *   - backdrop-filter was removed from the HUD so the video is never sampled
 *     or blurred through panel/toast glass (FF-native #pf-hud-glass).
 *   - the keep-awake wake-lock re-acquires on the sentinel's system-forced
 *     `release` and is gated by a live setting.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const esbuild = readFileSync(join(ROOT, "esbuild.config.mjs"), "utf8");
const shellSrc = readFileSync(join(ROOT, "src", "shell", "shell.js"), "utf8");
const forgevttSrc = readFileSync(join(ROOT, "src", "shell", "subtitles", "forgevtt.js"), "utf8");
const styles = readFileSync(join(ROOT, "src", "shell", "chrome", "styles.css"), "utf8");
const contextSrc = readFileSync(join(ROOT, "src", "shared", "context.js"), "utf8");
const sdkSrc = readFileSync(join(ROOT, "src", "kernel", "sdk.js"), "utf8");
const panelSrc = readFileSync(join(ROOT, "src", "shell", "chrome", "panel.js"), "utf8");
const forgeSrc = readFileSync(join(ROOT, "src", "shell", "inputs", "forge.js"), "utf8");
const actionsSrc = readFileSync(join(ROOT, "src", "shell", "inputs", "actions.js"), "utf8");
const animateSrc = readFileSync(join(ROOT, "src", "shell", "chrome", "animate.js"), "utf8");
const gateSrc = readFileSync(join(ROOT, "src", "shell", "proxy", "gate.js"), "utf8");
const manifestSrc = readFileSync(join(ROOT, "src", "shell", "proxy", "manifest.js"), "utf8");
const manifestSegmentsSrc = readFileSync(join(ROOT, "src", "shell", "proxy", "manifest-segments.js"), "utf8");
const mp4Src = readFileSync(join(ROOT, "src", "shell", "proxy", "mp4.js"), "utf8");
const elementRouteSrc = readFileSync(join(ROOT, "src", "shell", "proxy", "element-route.js"), "utf8");
const providerSrc = readFileSync(join(ROOT, "src", "shell", "proxy", "provider.js"), "utf8");
const mseSrc = readFileSync(join(ROOT, "src", "shell", "proxy", "mse.js"), "utf8");
const kernelSrc = readFileSync(join(ROOT, "src", "kernel", "kernel.js"), "utf8");
const entrySrc = readFileSync(join(ROOT, "src", "entry.js"), "utf8");
const mediaTimingSrc = readFileSync(join(ROOT, "src", "kernel", "proxy", "media-timing.js"), "utf8");

test("build targets the firefox155 baseline", () => {
  assert.match(esbuild, /target:\s*\[["']firefox155["']\]/, "esbuild target is firefox155");
  // Minification is the primary shipped output and is Warp-safe by design.
  assert.match(esbuild, /minify:\s*true/, "default build is minified");
});

test("no dead setTimeout scheduler fallback in the shell's DOM-injection yield path", () => {
  // scheduler.yield() is native in FF 142+ (baseline 155); the fallback would
  // be dead code and would lose the prioritized continuation.
  assert.match(shellSrc, /await\s+scheduler\.yield\(\)/, "shell yields via scheduler.yield()");
  assert.doesNotMatch(
    shellSrc.replace(/\/\*[\s\S]*?\*\//g, ""),
    /scheduler\?\.yield[^]*?setTimeout/,
    "no setTimeout fallback may accompany the scheduler.yield() call"
  );
});

test("forgevtt runs large parses under background priority and is abortable", () => {
  assert.match(forgevttSrc, /scheduler\.postTask/, "forgevtt calls scheduler.postTask unguarded");
  assert.doesNotMatch(
    forgevttSrc.replace(/\/\*[\s\S]*?\*\//g, ""),
    /typeof\s+scheduler/,
    "no cooperative scheduler feature-detect may drift back"
  );
  assert.match(forgevttSrc, /priority:\s*"background"/, "parse runs at background priority");
  assert.match(forgevttSrc, /AbortError/, "postTask abort surfaces as AbortError");
});

test("FF-native APIs are called unguarded (no feature-detect fallbacks)", () => {
  // Every API below is native on Firefox 155+ (baseline). Each must be invoked
  // directly so no dead cross-browser fallback branch can return.
  assert.match(contextSrc, /AbortSignal\.any\(/, "context uses AbortSignal.any() natively");
  assert.match(contextSrc, /AbortSignal\.timeout\(/, "context uses AbortSignal.timeout() natively");
  assert.doesNotMatch(
    contextSrc.replace(/\/\*[\s\S]*?\*\//g, ""),
    /typeof\s+AbortSignal|useSignalAny|deadline/,
    "no manual-deadline AbortSignal.any fallback in context"
  );
  assert.match(sdkSrc, /video\.checkVisibility\(/, "sdk calls checkVisibility() unguarded");
  assert.doesNotMatch(
    sdkSrc.replace(/\/\*[\s\S]*?\*\//g, ""),
    /typeof\s+video\.checkVisibility/,
    "no checkVisibility feature-detect in sdk"
  );
  assert.match(panelSrc, /document\.startViewTransition\(/, "panel calls startViewTransition() unguarded");
  assert.doesNotMatch(
    panelSrc.replace(/\/\*[\s\S]*?\*\//g, ""),
    /typeof\s+document\.startViewTransition/,
    "no startViewTransition feature-detect in panel"
  );
  assert.match(forgeSrc, /event\.getCoalescedEvents\(/, "scrub calls getCoalescedEvents() unguarded");
  assert.match(forgeSrc, /event\.getPredictedEvents\(/, "scrub calls getPredictedEvents() unguarded");
  assert.doesNotMatch(
    forgeSrc.replace(/\/\*[\s\S]*?\*\//g, ""),
    /typeof\s+event\.get(Coalesced|Predicted)Events/,
    "no PointerEvent sample-stream feature-detect in scrub"
  );
  assert.match(actionsSrc, /video\.animate\(/, "actions uses video.animate() (WAAPI) natively");
  assert.doesNotMatch(
    actionsSrc.replace(/\/\*[\s\S]*?\*\//g, ""),
    /typeof\s+video\.animate|transitionend/,
    "no CSS-transition fallback for the ease transform"
  );
  assert.match(animateSrc, /el\.getAnimations\(/, "flash uses el.getAnimations() natively");
  assert.match(animateSrc, /el\.animate\(/, "flash uses el.animate() (WAAPI) natively");
  assert.doesNotMatch(
    animateSrc.replace(/\/\*[\s\S]*?\*\//g, ""),
    /typeof\s+el\.(animate|getAnimations)/,
    "no WAAPI feature-detect in flashElement"
  );
});

test("HUD glass never samples or blurs the video (no backdrop-filter)", () => {
  assert.doesNotMatch(styles, /backdrop-filter/, "no backdrop-filter may return to the HUD surfaces");
  assert.doesNotMatch(styles, /--pf-blur/, "no unused --pf-blur tokens may return");
});

test("keep-awake wake lock re-acquires on sentinel release and obeys a setting", () => {
  assert.match(shellSrc, /addEventListener\("release"/, "sentinel release listener re-acquires the lock");
  assert.match(shellSrc, /getSetting\("features\.wakeLock"\)/, "wake lock is gated by the features.wakeLock setting");
});

test("proxy URL resolution uses URL.canParse natively, no try/catch constructors", () => {
  // URL.canParse() is FF 115+ (baseline 155); each ref resolver must use it so
  // no dead try/catch fallback can return. The constructor still runs where a
  // parse is already known-valid.
  for (const file of [gateSrc, manifestSrc, manifestSegmentsSrc, mp4Src, elementRouteSrc]) {
    assert.match(file, /URL\.canParse\(/, "URL.canParse is used");
    assert.match(file, /new URL\(/, "the parse target is still constructed where valid");
    assert.doesNotMatch(file, /try\s*\{[\s\S]{0,80}?new URL\(/, "no try/catch new URL fallback");
  }
});

test("proxy transport composes AbortSignal natively and streams single-chunk bodies uncopied", () => {
  assert.match(providerSrc, /AbortSignal\.any\(/, "provider composes signals natively");
  assert.match(providerSrc, /AbortSignal\.timeout\(/, "provider honors native timeouts");
  assert.doesNotMatch(
    providerSrc.replace(/\/\*[\s\S]*?\*\//g, ""),
    /typeof\s+AbortSignal/,
    "no AbortSignal feature-detect in provider"
  );
  assert.match(providerSrc, /\.buffer\.transfer\(/, "provider merges chunks via zero-copy transfer");
});

test("object-URL and MSE glue is invoked unguarded (no cross-browser fallbacks)", () => {
  assert.match(elementRouteSrc, /return URL\.createObjectURL\(blob\)/, "object URLs are created natively");
  assert.match(elementRouteSrc, /URL\.revokeObjectURL\(objectUrl\)/, "object URLs are revoked natively");
  assert.doesNotMatch(
    elementRouteSrc.replace(/\/\*[\s\S]*?\*\//g, ""),
    /typeof\s+URL|URL\?\./,
    "no object-URL feature-detect in element-route"
  );
  assert.match(elementRouteSrc, /\.requestVideoFrameCallback\(onFirstFrame\)/, "the frame watchdog arms via requestVideoFrameCallback (FF 132+, baseline 2024)");
  assert.match(elementRouteSrc, /new FinalizationRegistry\(/, "routed object URLs are GC-cleaned via FinalizationRegistry (FF 79+)");
  assert.doesNotMatch(
    elementRouteSrc.replace(/\/\*[\s\S]*?\*\//g, ""),
    /typeof\s+requestVideoFrameCallback|typeof\s+FinalizationRegistry/,
    "no feature-detect on the watchdog/cleanup FF-native surfaces"
  );
  assert.match(mseSrc, /isTypeSupported\(mimeType\)/, "MSE lanes pre-validate mime natively");
});

test("kernel media-timing surface is a live unguarded PerformanceObserver, not a buffer replay", () => {
  assert.match(mediaTimingSrc, /new PerformanceObserverClass\(/, "the relay's default observer is the FF-native bare global");
  assert.doesNotMatch(
    mediaTimingSrc.replace(/\/\*[\s\S]*?\*\//g, ""),
    /typeof\s+PerformanceObserver\b|\bwindow\.PerformanceObserver/,
    "no PerformanceObserver feature-detect in the relay"
  );
  assert.match(mediaTimingSrc, /buffered:\s*false/, "live push mode - no buffered window replay");
  assert.match(mediaTimingSrc, /initiatorType/, "media element initiatorType (video/audio) is filtered");
  assert.match(kernelSrc, /new MediaTimingObserver\(/, "the framework owns the relay");
  assert.match(kernelSrc, /\.observe\(\)/, "the kernel arms the relay at init");
  assert.match(kernelSrc, /#netTimingRelay\?\.disconnect\(\)/, "the relay disconnects at pagehide");
  assert.match(entrySrc, /mediaTimeline\.add\(/, "entry schedules proxy sightings on the kernel timeline");
  assert.match(mp4Src, /reportNativeWire\(url, resp\.status\)/, "mp4 router reports the native-fetch fallback");
  assert.match(mp4Src, /via\s*===\s*"fetch"/, "only the native wire (never GM) is reported");
});

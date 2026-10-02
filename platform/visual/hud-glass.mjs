/**
 * HUD glass visual-regression capture.
 *
 * Renders the real built bundle over a deliberately hostile backdrop and
 * captures the HUD in both states, so glass tokens can be judged as pixels
 * rather than asserted as strings.
 *
 *   node platform/visual/hud-glass.mjs                 # capture + report
 *   node platform/visual/hud-glass.mjs --record        # write a baseline
 *   node platform/visual/hud-glass.mjs --compare       # diff vs baseline
 *   node platform/visual/hud-glass.mjs --out <dir>     # write PNGs elsewhere
 *
 * Why a measurement and not just a PNG: a screenshot is only readable by a
 * human, which makes it useless as a gate in CI or in review. So each capture
 * also reduces the pixels to numbers that encode the intent of the material -
 * the panel interior must stay DARKER than the backdrop beside it (legibility),
 * the top edge must be a bright hairline (specular rim), and the corner must be
 * rounded rather than square. Those are the properties a design change is
 * supposed to move, so they are what gets baselined.
 *
 * The backdrop is intentionally the worst case the HUD faces: saturated
 * primary-colour bands plus a 6px repeating stripe. A glass surface that holds
 * up here holds up over real video, and over real video is the only backdrop
 * that matters.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { ChromiumDriver, TestServer } from "../harness/chromium.mjs";
import { waitForShell, waitForPanel } from "../harness/page.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, "..", "..");
const BUNDLE_PATH = join(PROJECT_ROOT, "dist", "playerforge.user.js");
const BASELINE_PATH = join(HERE, "hud-glass.baseline.json");

/**
 * Interiors darker than this count as "glass". The backdrop here is far
 * brighter than any value the sheet produces, so the threshold is generous in
 * the safe direction: it can only under-report the panel, never invent one.
 */
const DARK_LUM = 90;

/** Fraction of a row that must be dark for the row to count as inside the sheet. */
const ROW_COVERAGE = 0.3;

// ── PNG decoding ────────────────────────────────────────────────────
// Only what a Chromium screenshot needs: 8-bit truecolour, no interlace. The
// five filter types are undone by hand because there is no image dependency in
// the project and adding one for a visual gate is not worth the install cost.

/**
 * Decode a PNG into {width, height, channels, pixels}.
 * @param {string} path
 */
function readPng(path) {
  const data = readFileSync(path);
  if (data.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path} is not a PNG`);

  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  let offset = 8;

  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      colorType = body[9];
      if (body[8] !== 8) throw new Error(`${path}: only 8-bit PNGs are supported`);
      if (body[12] !== 0) throw new Error(`${path}: interlaced PNGs are not supported`);
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`${path}: unsupported colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  const prior = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const line = out.subarray(y * stride, (y + 1) * stride);
    row.copy(line);

    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? line[x - channels] : 0;
      const up = prior[x];
      const upLeft = x >= channels ? prior[x - channels] : 0;
      if (filter === 0) continue;
      else if (filter === 1) line[x] = (line[x] + left) & 0xff;
      else if (filter === 2) line[x] = (line[x] + up) & 0xff;
      else if (filter === 3) line[x] = (line[x] + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const dl = Math.abs(p - left);
        const du = Math.abs(p - up);
        const dul = Math.abs(p - upLeft);
        const pred = dl <= du && dl <= dul ? left : du <= dul ? up : upLeft;
        line[x] = (line[x] + pred) & 0xff;
      } else throw new Error(`${path}: bad filter ${filter}`);
    }
    line.copy(prior);
  }

  return { width, height, channels, pixels: out };
}

/** Rec.709 luminance at a pixel. */
function luma(img, x, y) {
  const o = (y * img.width + x) * img.channels;
  return Math.round(0.2126 * img.pixels[o] + 0.7152 * img.pixels[o + 1] + 0.0722 * img.pixels[o + 2]);
}

// ── Measurement ─────────────────────────────────────────────────────

/**
 * Bounding box of the sheet, found by thresholding for dark pixels.
 * @param {{width:number,height:number,channels:number,pixels:Buffer}} img
 */
function findSheet(img) {
  const rows = [];
  for (let y = 0; y < img.height; y++) {
    let dark = 0;
    for (let x = 0; x < img.width; x++) if (luma(img, x, y) < DARK_LUM) dark++;
    if (dark > img.width * ROW_COVERAGE) rows.push(y);
  }
  if (rows.length === 0) return null;

  let minX = img.width;
  let maxX = 0;
  for (const y of rows) {
    for (let x = 0; x < img.width; x++) {
      if (luma(img, x, y) >= DARK_LUM) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  return { x0: minX, x1: maxX, y0: rows[0], y1: rows[rows.length - 1] };
}

/**
 * Reduce a screenshot to the numbers that describe the material.
 * @param {string} path
 */
export function measureGlass(path) {
  const img = readPng(path);
  const box = findSheet(img);
  if (!box) return { found: false };

  const midX = Math.floor((box.x0 + box.x1) / 2);
  const span = box.y1 - box.y0;
  const samples = 5;

  // Legibility: the sheet interior must sit below the backdrop beside it. This
  // is the property the adaptive-legibility clamp exists to guarantee, so it is
  // measured where it matters rather than trusted from the token value.
  const deltas = [];
  const inside = [];
  for (let i = 0; i < samples; i++) {
    const y = box.y0 + Math.floor((span * (i + 1)) / (samples + 1));
    const inL = luma(img, midX, y);
    const outL = luma(img, Math.max(2, box.x0 - 40), y);
    inside.push(inL);
    deltas.push(outL - inL);
  }

  // Specular rim: a bright hairline on the top edge, darkening just inside it.
  const rim = [0, 1, 2, 3, 4, 5].map((dy) => luma(img, midX, box.y0 + dy));

  // Measured as a lift over the surface just below it, not as an absolute
  // luminance. An absolute threshold silently encodes one tint choice: the
  // original was luma >= 110, which matched a 0.42-alpha rim over a 74% tint and
  // false-failed a 0.3-alpha rim over a 58% tint even though the highlight was
  // plainly visible. A relative test asks the design-independent question - is
  // the edge brighter than the surface under it - so it survives future tint
  // changes. Deleting the rim entirely still fails it, because the edge then
  // measures flat (verified: 75,75,74,74,73,73 -> 0% lift).
  const rimPeak = Math.max(...rim);
  const rimInterior = Math.max(...rim.slice(2));
  const rimLift = rimInterior > 0 ? (rimPeak - rimInterior) / rimInterior : 0;

  // Corner geometry: count dark pixels per row across the top-left corner. A
  // square corner starts at full width; a rounded one ramps up.
  const corner = [];
  for (let dy = 0; dy < 20; dy += 2) {
    let dark = 0;
    for (let dx = 0; dx < 20; dx++) if (luma(img, box.x0 + dx, box.y0 + dy) < DARK_LUM) dark++;
    corner.push(dark);
  }

  return {
    found: true,
    box: { w: box.x1 - box.x0 + 1, h: box.y1 - box.y0 + 1 },
    interiorLuma: inside,
    // Positive means the sheet is darker than its surroundings, which is what
    // keeps white HUD text readable over bright footage.
    legibilityDelta: deltas,
    minLegibilityDelta: Math.min(...deltas),
    rimLuma: rim,
    rimPeak,
    rimInterior,
    rimLift,
    cornerRun: corner,
    // A rounded corner leaves the first row mostly empty; a square one fills it.
    cornerRounded: corner[0] < corner[Math.floor(corner.length / 2)],
  };
}

// ── Capture ─────────────────────────────────────────────────────────

const HOSTILE_PAGE = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>glass</title><style>
  *{margin:0;box-sizing:border-box}
  body{min-height:100vh;display:grid;place-items:center}
  .bg{position:fixed;inset:0;background:linear-gradient(115deg,
    #fff 0%,#ffe600 18%,#ff2d55 34%,#00d4ff 52%,#b6ff00 68%,#fff 84%,#f7f7f7 100%)}
  .bg::after{content:"";position:absolute;inset:0;
    background:repeating-linear-gradient(90deg,rgba(0,0,0,.16) 0 2px,transparent 2px 6px)}
  video{position:relative;width:960px;height:540px}
</style></head><body>
  <div class="bg"></div>
  <div class="plyr" data-plyr><div class="plyr__video-wrapper"><video id="v"></video></div></div>
<script>
  // A live MediaStream, not a canvas dataURL: the kernel's probe gates on a
  // decodable readyState and real dimensions, and a dataURL clip never gets
  // there. Animation keeps the backdrop moving so over-transparency and
  // banding show up rather than hiding behind a static gradient.
  const c=document.createElement("canvas");c.width=960;c.height=540;
  const x=c.getContext("2d");
  (function paint(){
    const g=x.createLinearGradient(0,0,960,540);
    g.addColorStop(0,"#ff9500");g.addColorStop(.5,"#af52de");g.addColorStop(1,"#00c7be");
    x.fillStyle=g;x.fillRect(0,0,960,540);
    x.fillStyle="rgba(255,255,255,.5)";x.beginPath();
    x.arc(480,270,90+Math.sin(Date.now()/400)*60,0,7);x.fill();
    requestAnimationFrame(paint);
  })();
  const v=document.getElementById("v");
  v.muted=true;v.playsInline=true;
  v.srcObject=c.captureStream(30);
  v.play().catch(()=>{});
  for(const t of ["loadedmetadata","loadeddata","play"]) {
    v.addEventListener(t,()=>v.dispatchEvent(new Event(t,{bubbles:true})),{once:true});
  }
</script></body></html>`;

/** Toggle the panel the way a user would, so the capture is the shipped state. */
function toggle(driver) {
  return driver.eval(
    () =>
      new Promise((resolve) => {
        document.querySelector(".pf-shell").dispatchEvent(
          new CustomEvent("pf:gesture-panel", { bubbles: true })
        );
        setTimeout(resolve, 700);
      })
  );
}

/** Read the resolved glass tokens straight off the live panel. */
function readTokens(driver) {
  return driver.eval(() => {
    const panel = document.querySelector(".pf-shell").shadowRoot.querySelector(".pf-panel");
    const cs = getComputedStyle(panel);
    return {
      backdropFilter: cs.backdropFilter,
      backgroundColor: cs.backgroundColor,
      borderRadius: cs.borderRadius,
      boxShadow: cs.boxShadow,
      glassTint: cs.getPropertyValue("--pf-glass-tint").trim(),
      radiusLg: cs.getPropertyValue("--pf-radius-lg").trim(),
      blurLg: cs.getPropertyValue("--pf-blur-lg").trim(),
    };
  });
}

/**
 * Capture both HUD states and measure them.
 * @param {string} outDir
 */
export async function capture(outDir) {
  mkdirSync(outDir, { recursive: true });
  if (!existsSync(BUNDLE_PATH)) throw new Error(`Bundle missing at ${BUNDLE_PATH}. Run "npm run build".`);

  const server = new TestServer();
  await server.start();
  const path = `/glass-${Date.now()}.html`;
  server.addPage(path, HOSTILE_PAGE);

  const driver = await ChromiumDriver.launch();
  try {
    await driver.navigate(`${server.url}${path}`);
    await driver.injectGMStubs();
    await driver.injectScript(readFileSync(BUNDLE_PATH, "utf8"));
    await waitForShell(driver, 10000);
    await waitForPanel(driver, 10000);

    await toggle(driver);
    const tokens = await readTokens(driver);
    const openPng = join(outDir, "panel-open.png");
    await driver.screenshot(openPng);

    await toggle(driver);
    const collapsedPng = join(outDir, "hud-collapsed.png");
    await driver.screenshot(collapsedPng);

    return {
      tokens,
      panelOpen: measureGlass(openPng),
      hudCollapsed: { path: collapsedPng },
      shots: [openPng, collapsedPng],
    };
  } finally {
    await driver.destroy();
    await server.stop();
  }
}

/**
 * Assert the material's intent, independent of any stored baseline. These are
 * the invariants a design edit should never be able to break silently, so they
 * run on every capture rather than only under --compare.
 * @param {ReturnType<typeof measureGlass>} m
 */
function checkInvariants(m) {
  const problems = [];
  if (!m.found) return ["sheet not found in capture"];
  if (m.minLegibilityDelta <= 0) {
    problems.push(`panel is not darker than its backdrop (min delta ${m.minLegibilityDelta})`);
  }
  if (m.rimLift < 0.2) {
    problems.push(`specular rim too weak (edge is ${(m.rimLift * 100).toFixed(0)}% brighter than the surface below it, want >= 20%)`);
  }
  if (!m.cornerRounded) {
    problems.push("top-left corner is square, not rounded");
  }
  return problems;
}

async function main() {
  const argv = process.argv.slice(2);
  const record = argv.includes("--record");
  const compare = argv.includes("--compare");
  const outArg = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : "platform/visual/shots";
  // resolve, not join: an explicit absolute --out must survive untouched.
  const outDir = resolve(PROJECT_ROOT, outArg);

  const res = await capture(outDir);
  console.log("\n  HUD glass capture");
  console.log("  " + "─".repeat(60));
  console.log(`  backdrop-filter : ${res.tokens.backdropFilter}`);
  console.log(`  background      : ${res.tokens.backgroundColor}`);
  console.log(`  border-radius   : ${res.tokens.borderRadius}  (token ${res.tokens.radiusLg})`);
  console.log(`  glass-tint      : ${res.tokens.glassTint}`);
  console.log(`  shots           : ${res.shots.join(", ")}`);

  const m = res.panelOpen;
  console.log(`\n  panel           : ${m.box.w}x${m.box.h}px`);
  console.log(`  interior luma   : ${m.interiorLuma.join(", ")}  (backdrop beside it is ~125)`);
  console.log(`  legibility delta: ${m.legibilityDelta.join(", ")}  (positive = sheet is darker)`);
  console.log(`  rim luma        : ${m.rimLuma.join(", ")}  (edge ${(m.rimLift * 100).toFixed(0)}% brighter than surface below)`);
  console.log(`  corner rounded  : ${m.cornerRounded}`);

  const problems = checkInvariants(m);
  if (problems.length) {
    console.log("\n  MATERIAL INVARIANTS FAILED");
    for (const p of problems) console.log(`    x ${p}`);
  } else {
    console.log("\n  material invariants: ok (darker than backdrop, rim lit, corner rounded)");
  }

  if (record) {
    writeFileSync(
      BASELINE_PATH,
      JSON.stringify(
        {
          note: "Recorded by platform/visual/hud-glass.mjs --record. Legibility/radius are the values to watch when retuning the glass tokens.",
          tokens: res.tokens,
          panelOpen: m,
        },
        null,
        2
      ) + "\n"
    );
    console.log(`\n  baseline recorded: ${BASELINE_PATH}`);
  }

  if (compare) {
    if (!existsSync(BASELINE_PATH)) {
      console.error(`\n  no baseline - run with --record first`);
      process.exit(2);
    }
    const base = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

    // Tokens are exact: they are resolved CSS values, so any difference is a
    // real edit to the material and should be reported verbatim.
    const exact = [
      ["backdrop-filter", base.tokens.backdropFilter, res.tokens.backdropFilter],
      ["background", base.tokens.backgroundColor, res.tokens.backgroundColor],
      ["border-radius", base.tokens.borderRadius, res.tokens.borderRadius],
      ["glass-tint", base.tokens.glassTint, res.tokens.glassTint],
    ];

    // Pixel measurements are NOT exact. The backdrop animates on purpose, so
    // what sits behind the panel differs every run: repeated captures of the
    // identical bundle gave a min legibility delta of 72, 68 and 48, and a rim
    // peak of 154, 153 and 158. Gating on equality here would fail on nothing
    // and train the reader to ignore the output. So these are compared against a
    // tolerance band and only a breach of it counts.
    const TOLERANCE = 0.3;
    const ranged = [
      ["min legibility delta", base.panelOpen.minLegibilityDelta, m.minLegibilityDelta],
      ["rim lift", base.panelOpen.rimLift, m.rimLift],
    ];

    console.log(`\n  comparison vs baseline`);
    console.log("  " + "─".repeat(60));
    for (const [name, was, now] of exact) {
      const changed = String(was) !== String(now);
      console.log(`    ${changed ? "CHANGED" : "ok      "} ${name}: ${was}${changed ? ` -> ${now}` : ""}`);
    }
    for (const [name, was, now] of ranged) {
      const drift = Math.abs(now - was) / Math.max(1, Math.abs(was));
      const verdict = drift <= TOLERANCE ? "ok      " : "DRIFT   ";
      console.log(`    ${verdict} ${name}: ${was} -> ${now} (${(drift * 100).toFixed(0)}%, +/-${TOLERANCE * 100}% band)`);
    }
    console.log("    note: pixel rows carry a wide band because the backdrop animates;");
    console.log("          tokens above are the exact signal when retuning the glass.");
  }

  process.exit(problems.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Without a catch, a capture failure surfaces as an opaque unhandled
  // rejection. A missing bundle is the common case, so name it explicitly.
  main().catch((err) => {
    console.error(`\n  visual capture failed: ${err.message}`);
    process.exit(1);
  });
}
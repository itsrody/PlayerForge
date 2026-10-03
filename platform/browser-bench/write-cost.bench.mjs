/**
 * Write-cost browser benchmark — the magnitude of compare-before-write.
 *
 * §2.2 sets itself this measurement: point 3 of the compare-before-write
 * argument says the size of the win is "an open question this project should
 * measure, not a settled fact", and points at §5.
 *
 * The two rows are the same five-field pill update, identical final state,
 * reached two ways:
 *
 *   - blind: write all five unconditionally, which is what the HUD did before
 *     L5 routed it through `HudReconciler`. Each write dirties style, and the
 *     flush that follows has work to do.
 *   - diffed: compare each field with `Object.is` first, which is what L5
 *     does. Nothing differs, so nothing is written and the flush finds a
 *     clean tree.
 *
 * The fixture is built in the page rather than driven through PF's own toast
 * on purpose. The reconciler lives in the add-on's isolated realm, where no
 * page-side timing can reach it, and poking PF's real pill from here would
 * desynchronise `applied` from the DOM for the rest of the session. What is
 * being measured is Gecko's cost for an unconditional write against a skip —
 * that number does not depend on whose element it is — so a shape-matched
 * fixture keeps the measurement honest and PF undisturbed. The element is
 * offset out of the viewport but still in the layout tree, so the writes do
 * cost what they cost in production.
 *
 * Both rows are report-only. They only mean something read together, and the
 * quantity §2.2 is after is the ratio between them, not either absolute —
 * which is exactly the figure that survives machine load and would not
 * survive a gate on either number alone.
 *
 * The rows are measured in interleaved batches rather than one after the
 * other, so a machine that warms up or cools off across the run moves both
 * sides together instead of biasing the pair.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FirefoxDriver, TestServer, createTestPage } from "../harness/firefox.mjs";
import { waitForShell } from "../harness/page.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUNDLE = readFileSync(join(HERE, "..", "..", "dist", "playerforge.user.js"), "utf8");

const BATCHES = 7;
const ITERATIONS = 40;

export default async function runWriteCostBench(bundle = DEFAULT_BUNDLE) {
  const server = new TestServer();
  await server.start();
  // The native harness registers the userscript once at startup, so a
  // custom build is chosen at launch rather than injected afterwards.
  const driver = await FirefoxDriver.launch({ bundle });
  const results = [];

  try {
    await driver.navigate(createTestPage(server));
    await driver.injectGMStubs();
    await driver.injectScript();
    await waitForShell(driver, 8000);

    // Build the fixture and read the desired state back off it, so the diffed
    // path compares like with like. `style.color` returns the serialised form,
    // not the literal it was set with: comparing against the setting's own
    // text would make every field look dirty and quietly measure the blind
    // path twice.
    await driver.eval(() => {
      const wrap = document.createElement("div");
      wrap.id = "pf-write-cost";
      wrap.className = "pf-write-cost-shown";
      wrap.style.cssText = "position:fixed;left:-9999px;top:0;";
      wrap.style.color = "#7af";
      wrap.style.opacity = "1";
      const icon = document.createElement("span");
      icon.textContent = ">";
      const text = document.createElement("span");
      text.textContent = "playerforge";
      wrap.append(icon, text);
      document.body.appendChild(wrap);
      document.__pfWriteCost = {
        wrap,
        icon,
        text,
        desired: {
          cls: wrap.className,
          color: wrap.style.color,
          opacity: wrap.style.opacity,
          icon: icon.style.display,
          text: text.textContent
        }
      };
    });

    const blind = [];
    const diffed = [];
    for (let b = 0; b < BATCHES; b++) {
      const blindSamples = [];
      const diffSamples = [];
      for (let i = 0; i < ITERATIONS; i++) {
        blindSamples.push(
          (
            await driver.amplifiedEval(null, () => {
              const s = document.__pfWriteCost;
              const d = s.desired;
              s.wrap.className = d.cls;
              s.wrap.style.color = d.color;
              s.wrap.style.opacity = d.opacity;
              s.icon.style.display = d.icon;
              s.text.textContent = d.text;
              void s.wrap.offsetHeight;
            })
          ).perOp
        );
        diffSamples.push(
          (
            await driver.amplifiedEval(null, () => {
              const s = document.__pfWriteCost;
              const d = s.desired;
              if (s.wrap.className !== d.cls) s.wrap.className = d.cls;
              if (s.wrap.style.color !== d.color) s.wrap.style.color = d.color;
              if (s.wrap.style.opacity !== d.opacity) s.wrap.style.opacity = d.opacity;
              if (s.icon.style.display !== d.icon) s.icon.style.display = d.icon;
              if (s.text.textContent !== d.text) s.text.textContent = d.text;
              void s.wrap.offsetHeight;
            })
          ).perOp
        );
      }
      blind.push(median(blindSamples));
      diffed.push(median(diffSamples));
    }

    await driver.eval(() => {
      document.getElementById("pf-write-cost")?.remove();
      delete document.__pfWriteCost;
    });

    push(results, "write cost, blind (5 fields, unchanged values, amplified)", blind);
    push(results, "write cost, diffed (unchanged snapshot, amplified)", diffed);
  } finally {
    await driver.destroy();
    await server.stop();
  }

  return results;
}

const median = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** Collapse one state's per-batch medians into a result row, report-only. */
function push(results, name, batchMedians) {
  const sorted = [...batchMedians].sort((a, b) => a - b);
  results.push({
    name,
    medianMsPerOp: sorted[Math.floor(sorted.length / 2)],
    spread: (sorted[sorted.length - 1] - sorted[0]) / sorted[Math.floor(sorted.length / 2)],
    gateable: false,
  });
}

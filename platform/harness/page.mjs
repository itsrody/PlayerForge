/**
 * Page helpers for FirefoxDriver integration tests.
 *
 * Shell-readiness waits (the HUD layer, the panel, a frame's shell) plus the
 * two element probes the suite still uses: a count and a computed style.
 */

/**
 * Wait for the shell HUD layer to appear (indicates shell boot complete).
 * Checks both document and shadow roots since the HUD lives inside pf-shell's shadow.
 *
 * @param {import('./firefox.mjs').FirefoxDriver} driver
 * @param {number} [timeoutMs=10000]
 */
export async function waitForShell(driver, timeoutMs = 10000) {
  return driver.waitFor(
    () => {
      if (document.querySelector(".pf-hud-layer")) return true;
      const shell = document.querySelector(".pf-shell");
      return !!shell?.shadowRoot?.querySelector(".pf-hud-layer");
    },
    timeoutMs,
    50
  );
}

/**
 * Wait for the shell HUD layer inside a specific frame.
 * @param {import('./firefox.mjs').FirefoxDriver} driver
 * @param {number|string} frameId - Frame index or name.
 * @param {number} [timeoutMs=10000]
 */
export async function waitForShellInFrame(driver, frameId, timeoutMs = 10000) {
  return driver.waitForInFrame(
    frameId,
    () => {
      if (document.querySelector(".pf-hud-layer")) return true;
      const shell = document.querySelector(".pf-shell");
      return !!shell?.shadowRoot?.querySelector(".pf-hud-layer");
    },
    timeoutMs,
    100
  );
}

/**
 * Wait for the settings panel to be present (indicates full shell construction).
 * Checks inside shadow roots.
 *
 * @param {import('./firefox.mjs').FirefoxDriver} driver
 * @param {number} [timeoutMs=10000]
 */
export async function waitForPanel(driver, timeoutMs = 10000) {
  return driver.waitFor(
    () => {
      if (document.querySelector(".pf-panel")) return true;
      const shell = document.querySelector(".pf-shell");
      return !!shell?.shadowRoot?.querySelector(".pf-panel");
    },
    timeoutMs,
    50
  );
}

/**
 * Get the count of elements matching a CSS selector.
 *
 * @param {import('./firefox.mjs').FirefoxDriver} driver
 * @param {string} selector
 * @returns {Promise<number>}
 */
export async function countElements(driver, selector) {
  return driver.eval((sel) => document.querySelectorAll(sel).length, selector);
}

/**
 * Get the computed style property of an element.
 *
 * @param {import('./firefox.mjs').FirefoxDriver} driver
 * @param {string} selector
 * @param {string} property
 * @returns {Promise<string>}
 */
export async function getComputedStyle(driver, selector, property) {
  return driver.eval(
    (sel, prop) => {
      const el = document.querySelector(sel);
      if (!el) return "";
      return getComputedStyle(el).getPropertyValue(prop);
    },
    selector,
    property
  );
}

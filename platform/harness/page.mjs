/**
 * Page helpers for ChromiumDriver integration tests.
 *
 * Utility functions for interacting with the page context, waiting for
 * DOM mutations, and asserting on element state.
 */

/**
 * Wait for an element matching a CSS selector to appear in the DOM.
 *
 * @param {import('./chromium.mjs').ChromiumDriver} driver
 * @param {string} selector
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<boolean>}
 */
export async function waitForSelector(driver, selector, timeoutMs = 5000) {
  return driver.waitFor(
    (sel) => !!document.querySelector(sel),
    timeoutMs,
    50
  );
}

/**
 * Wait for the shell HUD layer to appear (indicates shell boot complete).
 * Checks both document and shadow roots since the HUD lives inside pf-shell's shadow.
 *
 * @param {import('./chromium.mjs').ChromiumDriver} driver
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
 * Wait for the settings panel to be present (indicates full shell construction).
 * Checks inside shadow roots.
 *
 * @param {import('./chromium.mjs').ChromiumDriver} driver
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
 * @param {import('./chromium.mjs').ChromiumDriver} driver
 * @param {string} selector
 * @returns {Promise<number>}
 */
export async function countElements(driver, selector) {
  return driver.eval((sel) => document.querySelectorAll(sel).length, selector);
}

/**
 * Get the text content of an element.
 *
 * @param {import('./chromium.mjs').ChromiumDriver} driver
 * @param {string} selector
 * @returns {Promise<string|null>}
 */
export async function getTextContent(driver, selector) {
  return driver.eval(
    (sel) => document.querySelector(sel)?.textContent ?? null,
    selector
  );
}

/**
 * Check if an element has a specific attribute.
 *
 * @param {import('./chromium.mjs').ChromiumDriver} driver
 * @param {string} selector
 * @param {string} attribute
 * @returns {Promise<boolean>}
 */
export async function hasAttribute(driver, selector, attribute) {
  return driver.eval(
    (sel, attr) => document.querySelector(sel)?.hasAttribute(attr) ?? false,
    selector,
    attribute
  );
}

/**
 * Get the computed style property of an element.
 *
 * @param {import('./chromium.mjs').ChromiumDriver} driver
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

/**
 * Click an element by selector.
 *
 * @param {import('./chromium.mjs').ChromiumDriver} driver
 * @param {string} selector
 */
export async function clickElement(driver, selector) {
  await driver.eval(
    (sel) => {
      const el = document.querySelector(sel);
      if (el) el.click();
    },
    selector
  );
}

/**
 * Dispatch a custom event on an element.
 *
 * @param {import('./chromium.mjs').ChromiumDriver} driver
 * @param {string} selector
 * @param {string} eventName
 * @param {object} [detail]
 */
export async function dispatchCustomEvent(driver, selector, eventName, detail = {}) {
  await driver.eval(
    (sel, name, det) => {
      const el = document.querySelector(sel);
      if (el) el.dispatchEvent(new CustomEvent(name, { detail: det, bubbles: true }));
    },
    selector,
    eventName,
    detail
  );
}

/**
 * Get all text content of toast notifications.
 *
 * @param {import('./chromium.mjs').ChromiumDriver} driver
 * @returns {Promise<string[]>}
 */
export async function getToastTexts(driver) {
  return driver.eval(() => {
    const toasts = document.querySelectorAll(".pf-toast");
    return Array.from(toasts).map((t) => t.textContent || "");
  });
}

/**
 * Sleep for a given number of milliseconds (page context).
 *
 * @param {import('./chromium.mjs').ChromiumDriver} driver
 * @param {number} ms
 */
export async function sleep(driver, ms) {
  await driver.eval(
    (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
    ms
  );
}

/**
 * Get performance timing data from the page.
 *
 * @param {import('./chromium.mjs').ChromiumDriver} driver
 * @returns {Promise<{navigationStart: number, domContentLoaded: number, loadEvent: number}>}
 */
export async function getPerformanceTimings(driver) {
  return driver.eval(() => {
    const t = performance.timing;
    return {
      navigationStart: t.navigationStart,
      domContentLoaded: t.domContentLoadedEventEnd - t.navigationStart,
      loadEvent: t.loadEventEnd - t.navigationStart,
    };
  });
}

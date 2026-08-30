import { logger } from "../../shared/logger.js";
import { createIconElement } from "./icons.js";
import { GESTURE_EVENTS } from "../inputs/actions.js";
import { deepestActiveElement, subscribeFullscreen } from "../../shared/shadow.js";

const HOLD_DELAY_MS = 400;
const HOLD_REPEAT_MS = 75;

function decimalsOf(step) {
  const str = String(step);
  const dot = str.indexOf(".");
  return dot === -1 ? 0 : str.length - dot - 1;
}

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Numeric spinbutton widget used by panel fields: text input with
 * hold-to-repeat chevron buttons and keyboard support. Programmatic
 * setValue() cascades through onChange like any user edit.
 */
function createStepper({
  min = 0,
  max = 100,
  step = 1,
  value,
  label,
  onChange,
  deferTextInput = false
} = {}) {
  const lo = Number(min);
  const hi = Number(max);
  const by = Math.abs(Number(step)) || 1;
  const decimals = Math.max(decimalsOf(by), 0);

  let committed = roundTo(Math.min(hi, Math.max(lo, Number(value ?? min))), decimals);

  const root = document.createElement("span");
  root.className = "pf-stepper";

  const input = document.createElement("input");
  input.className = "pf-stepper-input";
  input.type = "text";
  input.setAttribute("inputmode", "decimal");
  input.setAttribute("role", "spinbutton");
  input.setAttribute("aria-valuemin", String(lo));
  input.setAttribute("aria-valuemax", String(hi));
  if (label) {
    input.setAttribute("aria-label", label);
  }

  const arrows = document.createElement("span");
  arrows.className = "pf-stepper-arrows";

  const makeButton = (name, dir, title) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pf-stepper-btn";
    button.tabIndex = -1;
    button.appendChild(createIconElement(name));
    button.title = title;
    let delayTimer = null;
    let repeatTimer = null;
    const stopRepeat = () => {
      clearTimeout(delayTimer);
      clearInterval(repeatTimer);
      delayTimer = null;
      repeatTimer = null;
    };
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      if (input.disabled) {
        return;
      }
      nudge(dir);
      delayTimer = setTimeout(() => {
        repeatTimer = setInterval(() => nudge(dir), HOLD_REPEAT_MS);
      }, HOLD_DELAY_MS);
      const release = () => {
        stopRepeat();
        window.removeEventListener("pointerup", release, { passive: true });
        window.removeEventListener("pointercancel", release, { passive: true });
      };
      // Passive: the release handler only stops timers - it never cancels defaults.
      window.addEventListener("pointerup", release, { passive: true });
      window.addEventListener("pointercancel", release, { passive: true });
    });
    return button;
  };

  const upButton = makeButton("chevron-up", 1, "Increase");
  const downButton = makeButton("chevron-down", -1, "Decrease");
  arrows.appendChild(upButton);
  arrows.appendChild(downButton);

  const format = (v) => String(roundTo(v, decimals));

  const syncAria = () => {
    input.setAttribute("aria-valuenow", String(committed));
  };

  const showCommitted = () => {
    input.value = format(committed);
  };

  const commit = (rawText) => {
    const parsed = Number.parseFloat(rawText);
    if (!Number.isFinite(parsed)) {
      showCommitted();
      return committed;
    }
    const next = roundTo(Math.min(hi, Math.max(lo, parsed)), decimals);
    showCommitted();
    if (next !== committed) {
      committed = next;
      syncAria();
      onChange?.(committed);
    }
    return committed;
  };

  function nudge(dir) {
    commit(format(committed + dir * by));
  }

  input.addEventListener("input", () => {
    // deferTextInput (settings steppers): typing stays local until blur or
    // Enter commits, so every keystroke doesn't write GM storage and wake
    // every other tab's live-reload. Arrow nudges still commit per click.
    if (deferTextInput) {
      return;
    }
    const text = input.value.trim();
    if (!text) {
      return;
    }
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) {
      return;
    }
    const next = roundTo(Math.min(hi, Math.max(lo, parsed)), decimals);
    if (next !== committed) {
      committed = next;
      syncAria();
      onChange?.(committed);
    }
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      nudge(1);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      nudge(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      commit(input.value);
      input.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      showCommitted();
      input.blur();
    }
  });

  input.addEventListener("blur", () => commit(input.value));

  root.appendChild(input);
  root.appendChild(arrows);
  showCommitted();
  syncAria();

  return {
    root,
    input,
    getValue: () => committed,
    setValue(next) {
      const nextValue = roundTo(Math.min(hi, Math.max(lo, Number(next))), decimals);
      if (nextValue === committed) {
        showCommitted();
        return committed;
      }
      committed = nextValue;
      showCommitted();
      syncAria();
      onChange?.(committed);
      return committed;
    },
    setDisabled(disabled) {
      input.disabled = disabled;
      upButton.disabled = disabled;
      downButton.disabled = disabled;
      root.classList.toggle("pf-stepper-disabled", disabled);
    }
  };
}

/**
 * Tabbed settings panel hosted in the shell HUD, and the shell's open UI
 * API: features declare controls through parameterized builders
 * (addStepper/addButton/addCheckbox/...) instead of assembling DOM.
 * The root is a plain sheet in the HUD layer under the host's z-index
 * doctrine; open/close is a class flip on display, and Esc plus
 * outside-click dismissal are ours (guarded document listeners).
 * Arrow-key tab navigation likewise stays ours.
 */
export class SettingsPanel {
  #hudLayer;
  #shellHost;
  #root = null;
  #body = null;
  #tabList = null;
  #closeButton = null;
  #sections = new Map();
  #activeSection = null;
  #sectionCounter = 0;
  /** All panel subscriptions die with this signal. */
  #scope = new AbortController();
  #backdrop = null;
  #destroyed = false;

  constructor(shell) {
    this.#hudLayer = shell.shellDom?.hudLayer;
    this.#shellHost = shell.shellHost;
    if (!this.#hudLayer || !this.#shellHost) {
      logger.error("panel", "Missing shell DOM - panel not available");
      return;
    }
    this.#buildDom();
    this.#wireEvents();
    logger.log("panel", "Panel ready");
  }

  get element() {
    return this.#root;
  }

  get body() {
    return this.#body;
  }

  get isOpen() {
    return !!this.#root && this.#root.classList.contains("pf-open");
  }

  open() {
    if (!this.#root || this.#destroyed || !this.#body.childElementCount || this.isOpen) {
      return;
    }
    this.#root.classList.add("pf-open");
    const activeTab = this.#root.querySelector(".pf-panel-tab-active") || this.#closeButton;
    if (activeTab && deepestActiveElement(this.#shellHost) !== activeTab) {
      activeTab.focus();
    }
  }

  close() {
    if (this.#root && !this.#destroyed && this.isOpen) {
      this.#root.classList.remove("pf-open");
      if (this.#shellHost && this.#root.contains(deepestActiveElement(this.#shellHost))) {
        this.#shellHost.focus();
      }
    }
  }

  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  openSection(title) {
    if (!this.#root || this.#destroyed) {
      return false;
    }
    for (const [section, tab] of this.#sections) {
      if (section.dataset.title === title) {
        this.#activateSection(section, tab);
        this.open();
        return true;
      }
    }
    return false;
  }

  /** Add a section; returns the section root (or null when unusable). */
  addSection(title, icon) {
    if (!this.#root || this.#destroyed) {
      return null;
    }
    const sectionId = `pf-panel-section-${++this.#sectionCounter}`;
    const section = document.createElement("div");
    section.className = "pf-panel-section";
    section.id = sectionId;
    section.hidden = true;
    section.setAttribute("role", "tabpanel");
    section.setAttribute("aria-labelledby", `pf-panel-tab-${this.#sectionCounter}`);
    this.#body.appendChild(section);

    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "pf-panel-tab";
    tab.id = `pf-panel-tab-${this.#sectionCounter}`;
    tab.dataset.title = title;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", "false");
    tab.setAttribute("aria-controls", sectionId);
    if (icon) {
      const iconEl = createIconElement(icon);
      if (iconEl) {
        tab.appendChild(iconEl);
      }
    }
    const label = document.createElement("span");
    label.className = "pf-tab-label";
    label.textContent = title;
    tab.appendChild(label);

    tab.addEventListener("click", () => this.#activateSection(section, tab), { signal: this.#scope.signal });
    this.#tabList.appendChild(tab);
    this.#sections.set(section, tab);
    if (!this.#activeSection) {
      this.#activateSection(section, tab);
    }
    return section;
  }

  /** Generic escape hatch: create + attribute + append in one call. */
  el(tag, attrs = {}, parent = this.#body) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "style" && typeof value === "object") {
        Object.assign(node.style, value);
      } else {
        node.setAttribute(key, value);
      }
    }
    parent?.appendChild(node);
    return node;
  }

  addLabel(parent, text) {
    const node = this.el("span", { class: "pf-panel-label" }, parent);
    node.textContent = text;
    return node;
  }

  addHint(parent, text = "") {
    const node = this.el("div", { class: "pf-panel-hint" }, parent);
    node.textContent = text;
    return node;
  }

  /**
   * Unified declarative control builder - the routing core behind the
   * single-purpose add* wrappers. `type` selects the widget; every other
   * option is one key in one superset object, so callers pass exactly the
   * fields their control reads (unused keys are ignored).
   *
   *   Common        label, onChange, disabled
   *   button:       icon, title, ariaLabel, ghost
   *   checkbox:     checked
   *   color:        value (hex)
   *   select:       options ([value] or [value,label]), value
   *   stepper:      min, max, step, value, format, deferTextInput, head, class
   *
   * Returns the same per-widget handle the matching add* wrapper returns:
   * button -> <button>, checkbox -> <input>, select -> <select>,
   * color   -> { input, getValue, setValue },
   * stepper -> { root, input, getValue, setValue, setDisabled }.
   */
  addControl(parent, { type, ...opts } = {}) {
    switch (type) {
      case "button":
        return this.addButton(parent, opts);
      case "checkbox":
        return this.addCheckbox(parent, opts);
      case "color":
        return this.addColor(parent, opts);
      case "select":
        return this.addSelect(parent, opts);
      case "stepper":
        return this.addStepper(parent, opts);
      default:
        logger.warn("panel", `addControl: unknown type "${type}"`);
        return null;
    }
  }

  addButton(parent, { icon, title, ariaLabel, ghost, onClick, disabled } = {}) {
    const button = this.el("button", {
      class: ghost ? "pf-btn pf-btn-ghost pf-btn-icon" : "pf-btn pf-btn-icon",
      type: "button"
    }, parent);
    if (icon) {
      const iconEl = createIconElement(icon);
      if (iconEl) {
        button.appendChild(iconEl);
      }
    }
    if (title) {
      button.title = title;
    }
    if (ariaLabel) {
      button.setAttribute("aria-label", ariaLabel);
    }
    if (disabled) {
      button.disabled = true;
    }
    button.addEventListener("click", onClick);
    return button;
  }

  /**
   * Labeled numeric stepper with a live formatted value display.
   * Renders a grid cell by default; pass `class` for custom containers
   * or `head: true` for the stacked label-over-stepper layout.
   */
  addStepper(parent, {
    label,
    min = 0,
    max = 100,
    step = 1,
    value,
    format = String,
    onChange,
    deferTextInput = false,
    class: className,
    head,
    disabled = false
  } = {}) {
    const cell = this.el("div", { class: className || "pf-panel-cell" }, parent);
    const stepper = createStepper({
      min,
      max,
      step,
      value,
      label,
      deferTextInput,
      onChange
    });
    if (head) {
      const cellHead = this.el("div", { class: "pf-panel-cell-head" }, cell);
      this.addLabel(cellHead, label);
      cell.appendChild(stepper.root);
    } else {
      this.addLabel(cell, label);
      cell.appendChild(stepper.root);
    }
    if (disabled) {
      stepper.setDisabled(true);
    }
    return stepper;
  }

  addCheckbox(parent, { checked = false, onChange, disabled = false } = {}) {
    const attrs = { type: "checkbox" };
    if (disabled) attrs.disabled = "";
    const input = this.el("input", attrs, parent);
    input.checked = checked;
    input.addEventListener("change", () => onChange?.(input.checked));
    return input;
  }

  addColor(parent, { label, value = "#ffffff", onChange, disabled = false } = {}) {
    const cell = this.el("div", { class: "pf-panel-cell" }, parent);
    this.addLabel(cell, label);
    const attrs = { type: "color", value };
    if (disabled) attrs.disabled = "";
    const input = this.el("input", attrs, cell);
    const apply = (v) => {
      onChange?.(v);
    };
    input.addEventListener("input", () => apply(input.value));
    return {
      input,
      getValue: () => input.value,
      setValue(next) {
        if (input.value !== next) {
          input.value = next;
          apply(next);
        }
      }
    };
  }

  addSelect(parent, { options = [], value, onChange, disabled = false } = {}) {
    const attrs = { class: "pf-select" };
    if (disabled) attrs.disabled = "";
    const select = this.el("select", attrs, parent);
    for (const entry of options) {
      const [optValue, optLabel] = Array.isArray(entry) ? entry : [entry, entry];
      const option = document.createElement("option");
      option.value = optValue;
      option.textContent = optLabel;
      select.appendChild(option);
    }
    select.value = value;
    select.addEventListener("change", () => onChange?.(select.value));
    return select;
  }

  destroy() {
    if (!this.#destroyed) {
      this.#destroyed = true;
      this.#scope.abort();
      this.#root?.remove();
      this.#root = null;
      this.#backdrop?.remove();
      this.#backdrop = null;
      this.#body = null;
      this.#tabList = null;
      this.#sections.clear();
      this.#activeSection = null;
    }
  }

  #buildDom() {
    // Transparent modal shield: while the panel is open it covers the whole
    // shell (pointer-events: auto gated by .pf-open via :has in CSS), so a
    // click outside the panel closes it and is swallowed - it never passes
    // through to the SDK/video. Sits below the panel (z-hud) so panel controls
    // stay interactive. Because it lives in the host's shadow, the forge's
    // composedPath guard already ignores it; the stopPropagation below also
    // keeps it from bubbling to page/SDK handlers. Only animation/state lives
    // here - visibility is pure CSS, keyed on the single .pf-open source.
    const backdrop = document.createElement("div");
    backdrop.className = "pf-panel-backdrop";
    backdrop.setAttribute("aria-hidden", "true");
    backdrop.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      this.close();
    }, { signal: this.#scope.signal });
    this.#hudLayer.appendChild(backdrop);
    this.#backdrop = backdrop;

    const root = document.createElement("div");
    root.className = "pf-panel";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "false");
    root.setAttribute("aria-label", "PlayerForge controls");

    const header = document.createElement("div");
    header.className = "pf-panel-header";

    const tabList = document.createElement("div");
    tabList.className = "pf-panel-tabs";
    tabList.setAttribute("role", "tablist");
    tabList.setAttribute("aria-label", "PlayerForge sections");

    const closeButton = document.createElement("button");
    closeButton.className = "pf-panel-close";
    closeButton.type = "button";
    closeButton.title = "Close";
    closeButton.setAttribute("aria-label", "Close panel");
    closeButton.textContent = "✕";

    header.appendChild(tabList);
    header.appendChild(closeButton);
    this.#tabList = tabList;

    const body = document.createElement("div");
    body.className = "pf-panel-body";
    root.appendChild(header);
    root.appendChild(body);
    this.#hudLayer.appendChild(root);
    this.#root = root;
    this.#body = body;
    this.#closeButton = closeButton;

    closeButton.addEventListener("click", () => this.close(), { signal: this.#scope.signal });
  }

  #wireEvents() {
    const { signal } = this.#scope;
    this.#shellHost.addEventListener(GESTURE_EVENTS.panel, (event) => {
      event.stopPropagation();
      this.toggle();
    }, { signal });
    this.#shellHost.addEventListener(GESTURE_EVENTS.swipe, (event) => {
      if (event.detail?.direction === "up") {
        this.toggle();
      }
    }, { signal });

    // Any fullscreen transition dismisses the panel; the shared transition
    // source (shadow.js) drives it - no bus event needed.
    subscribeFullscreen(() => this.close(), this.#scope.signal);

    // Dismissal is ours since the popover left: Esc closes, and a press
    // outside the shell closes. The whole host counts as "inside" so our
    // own controls toggle themselves without a close/reopen flicker.
    // Static guarded listeners: two no-op calls when closed, zero churn.
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.isOpen) {
        this.close();
      }
    }, { signal });
    document.addEventListener("pointerdown", (event) => {
      if (!this.isOpen || event.composedPath().includes(this.#shellHost)) {
        return;
      }
      this.close();
    }, { signal, capture: true });

    this.#tabList.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        return;
      }
      const tabs = [...this.#tabList.querySelectorAll(".pf-panel-tab")];
      if (!tabs.length) {
        return;
      }
      const currentIndex = tabs.indexOf(deepestActiveElement(this.#shellHost));
      if (currentIndex === -1) {
        return;
      }
      event.preventDefault();
      let nextIndex = currentIndex;
      if (event.key === "ArrowLeft") {
        nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      } else if (event.key === "ArrowRight") {
        nextIndex = (currentIndex + 1) % tabs.length;
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = tabs.length - 1;
      }
      const targetSection = [...this.#sections].find(([, tab]) => tab === tabs[nextIndex])?.[0];
      tabs[nextIndex].focus();
      if (targetSection) {
        this.#activateSection(targetSection, tabs[nextIndex]);
      }
    }, { signal });
  }

  #activateSection(targetSection, targetTab) {
    for (const [section, tab] of this.#sections) {
      const isActive = section === targetSection;
      section.hidden = !isActive;
      tab.classList.toggle("pf-panel-tab-active", isActive);
      tab.setAttribute("aria-selected", String(isActive));
    }
    this.#activeSection = targetSection;
  }
}

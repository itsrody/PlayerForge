import { logger } from "../shared/logger.js";
import { createIconElement } from "../shared/icons.js";
import { GESTURE_EVENTS } from "../shared/events.js";

/**
 * Tabbed settings panel hosted in the shell HUD. Sections are added by
 * plugins; handles open/close, focus trapping, arrow-key tab navigation,
 * and range-input fill painting.
 */
export class SettingsPanel {
  #hudLayer;
  #shellHost;
  #bus;
  #shellId;
  #root = null;
  #body = null;
  #tabList = null;
  #closeButton = null;
  #sections = new Map();
  #activeSection = null;
  #sectionCounter = 0;
  #onPanelGesture = null;
  #onSwipeGesture = null;
  #onKeydownEscape = null;
  #onKeydownTab = null;
  #onTablistKeydown = null;
  #onRangeInput = null;
  #fullscreenUnsub = null;
  #destroyed = false;

  constructor(shell, bus) {
    this.#hudLayer = shell.shellDom?.hudLayer;
    this.#shellHost = shell.shellHost;
    this.#shellId = shell.id;
    this.#bus = bus;
    if (!this.#hudLayer || !this.#shellHost) {
      logger.error("panel", "Missing shell DOM — panel not available");
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
    return !!this.#root && !this.#root.hidden;
  }

  open() {
    if (!this.#root || this.#destroyed || !this.#body.childElementCount) {
      return;
    }
    this.#root.hidden = false;
    this.#refreshRangeFills();
    const activeTab = this.#root.querySelector(".pf-panel-tab-active") || this.#closeButton;
    if (activeTab && document.activeElement !== activeTab) {
      activeTab.focus();
    }
  }

  close() {
    if (!!this.#root && !this.#destroyed) {
      this.#root.hidden = true;
      if (this.#shellHost && this.#root.contains(document.activeElement)) {
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

    tab.addEventListener("click", () => this.#activateSection(section, tab));
    this.#tabList.appendChild(tab);
    this.#sections.set(section, tab);
    if (!this.#activeSection) {
      this.#activateSection(section, tab);
    }
    return section;
  }

  refreshRangeFills() {
    this.#refreshRangeFills();
  }

  destroy() {
    if (!this.#destroyed) {
      this.#destroyed = true;
      this.#unwireEvents();
      this.#root?.remove();
      this.#root = null;
      this.#body = null;
      this.#tabList = null;
      this.#sections.clear();
      this.#activeSection = null;
    }
  }

  #buildDom() {
    const root = document.createElement("div");
    root.className = "pf-panel";
    root.hidden = true;
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

    closeButton.addEventListener("click", () => this.close());
  }

  #wireEvents() {
    this.#onPanelGesture = (event) => {
      event.stopPropagation();
      this.toggle();
    };
    this.#onSwipeGesture = (event) => {
      if (event.detail?.direction === "up") {
        this.toggle();
      }
    };
    this.#shellHost.addEventListener(GESTURE_EVENTS.panel, this.#onPanelGesture);
    this.#shellHost.addEventListener(GESTURE_EVENTS.swipe, this.#onSwipeGesture);

    this.#fullscreenUnsub = (event) => {
      if (event.shellId === this.#shellId) {
        this.close();
      }
    };
    this.#bus?.on("shell:fullscreen-change", this.#fullscreenUnsub);

    this.#onKeydownEscape = (event) => {
      if (event.key !== "Escape" || !this.isOpen) {
        return;
      }
      const active = document.activeElement;
      if (!active || active.tagName !== "INPUT" && active.tagName !== "TEXTAREA" && !active.isContentEditable) {
        this.close();
      }
    };
    document.addEventListener("keydown", this.#onKeydownEscape, true);

    this.#onKeydownTab = (event) => {
      if (event.key !== "Tab" || !this.isOpen) {
        return;
      }
      const focusables = [...this.#root.querySelectorAll(
        "button, [href], input, select, textarea, [tabindex]:not([tabindex=\"-1\"])"
      )].filter((el) => !el.disabled && !el.hidden);
      if (!focusables.length) {
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", this.#onKeydownTab, true);

    this.#onTablistKeydown = (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        return;
      }
      const tabs = [...this.#tabList.querySelectorAll(".pf-panel-tab")];
      if (!tabs.length) {
        return;
      }
      const currentIndex = tabs.indexOf(document.activeElement);
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
    };
    this.#tabList.addEventListener("keydown", this.#onTablistKeydown);

    this.#onRangeInput = (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement && target.type === "range") {
        this.#paintRangeFill(target);
      }
    };
    this.#root.addEventListener("input", this.#onRangeInput);
  }

  #unwireEvents() {
    if (this.#shellHost) {
      this.#shellHost.removeEventListener(GESTURE_EVENTS.panel, this.#onPanelGesture);
      this.#shellHost.removeEventListener(GESTURE_EVENTS.swipe, this.#onSwipeGesture);
    }
    if (this.#onKeydownEscape) {
      document.removeEventListener("keydown", this.#onKeydownEscape, true);
    }
    if (this.#onKeydownTab) {
      document.removeEventListener("keydown", this.#onKeydownTab, true);
    }
    if (this.#onTablistKeydown) {
      this.#tabList?.removeEventListener("keydown", this.#onTablistKeydown);
    }
    if (this.#onRangeInput) {
      this.#root?.removeEventListener("input", this.#onRangeInput);
    }
    if (this.#fullscreenUnsub) {
      this.#bus?.off("shell:fullscreen-change", this.#fullscreenUnsub);
    }
    this.#onPanelGesture = null;
    this.#onSwipeGesture = null;
    this.#fullscreenUnsub = null;
    this.#onKeydownEscape = null;
    this.#onKeydownTab = null;
    this.#onTablistKeydown = null;
    this.#onRangeInput = null;
    this.#closeButton = null;
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

  #refreshRangeFills() {
    for (const input of this.#body?.querySelectorAll("input[type=\"range\"]") || []) {
      this.#paintRangeFill(input);
    }
  }

  #paintRangeFill(input) {
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 100;
    const value = Number(input.value);
    const pct = max > min ? ((value - min) / (max - min)) * 100 : 50;
    input.style.setProperty("--pf-fill", `${pct.toFixed(2)}%`);
  }
}

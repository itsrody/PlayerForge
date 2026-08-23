import { createIconElement } from "./icons.js";

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

export function createStepper({
  min = 0,
  max = 100,
  step = 1,
  value,
  label,
  onChange,
  doc = document
} = {}) {
  const lo = Number(min);
  const hi = Number(max);
  const by = Math.abs(Number(step)) || 1;
  const decimals = Math.max(decimalsOf(by), 0);

  let committed = roundTo(Math.min(hi, Math.max(lo, Number(value ?? min))), decimals);

  const root = doc.createElement("span");
  root.className = "pf-stepper";

  const input = doc.createElement("input");
  input.className = "pf-stepper-input";
  input.type = "text";
  input.setAttribute("inputmode", "decimal");
  input.setAttribute("role", "spinbutton");
  input.setAttribute("aria-valuemin", String(lo));
  input.setAttribute("aria-valuemax", String(hi));
  if (label) {
    input.setAttribute("aria-label", label);
  }

  const arrows = doc.createElement("span");
  arrows.className = "pf-stepper-arrows";

  const makeButton = (name, dir, title) => {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "pf-stepper-btn";
    button.tabIndex = -1;
    button.appendChild(createIconElement(name, doc));
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
        window.removeEventListener("pointerup", release);
        window.removeEventListener("pointercancel", release);
      };
      window.addEventListener("pointerup", release);
      window.addEventListener("pointercancel", release);
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
      committed = roundTo(Math.min(hi, Math.max(lo, Number(next))), decimals);
      showCommitted();
      syncAria();
    },
    setDisabled(disabled) {
      input.disabled = disabled;
      upButton.disabled = disabled;
      downButton.disabled = disabled;
      root.classList.toggle("pf-stepper-disabled", disabled);
    }
  };
}

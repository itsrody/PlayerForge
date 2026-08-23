import { getConfigValue, setConfigValue } from "../../shared/storage.js";
import { srtToVtt, ensureVttHeader, parseSubtitles } from "../../shared/subtitles.js";
import { createIconElement } from "../../shared/icons.js";
import { createStepper } from "../../shared/stepper.js";
import { logger } from "../../shared/logger.js";

const SUBTITLE_FILE_ACCEPT = ".srt,.vtt";
const SYNC_DEBOUNCE_MS = 150;
/** Extra vertical offset per stacked cue so simultaneous lines don't overlap. */
const STACK_OVERLAP_EM = 1.6;

const SETTING_KEYS = {
  size: "subtitles.style.size",
  color: "subtitles.style.color",
  shadow: "subtitles.style.shadow",
  posEnabled: "subtitles.position.enabled",
  line: "subtitles.position.line",
  horizontal: "subtitles.position.horizontal",
  align: "subtitles.position.align",
  syncOffset: "subtitles.sync.offset"
};

/**
 * Shell-owned feature: loads .srt/.vtt files onto a video and renders cues
 * through the shell's cue layer, with caption styling, manual positioning,
 * and sync offset.
 */
export class SubtitlesFeature {
  #shell;
  #tracks = [];
  #currentTrack = null;
  #cueLayer = null;
  #positionOverride = null;
  #syncOffset = 0;
  #fileInput = null;
  #hintEl = null;
  #loadButton = null;
  #removeButton = null;
  #frameUnsub = null;
  #timeupdateUnsub = null;
  #onSeeked = null;
  #onEnded = null;
  #destroyed = false;

  constructor(shell) {
    this.#shell = shell;
    this.#syncOffset = Number(getConfigValue(SETTING_KEYS.syncOffset, 0)) || 0;
    this.#cueLayer = shell.shellDom?.cueLayer || null;
    this.#fileInput = this.#createFileInput(shell);
    this.#buildPanelUi(shell);
    this.#startListening();
    this.#render();
    logger.log("subtitles", `Ready (${shell.sdkName})`);
  }

  destroy() {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    this.#stopListening();
    this.#fileInput?.remove();
    this.#fileInput = null;
    this.#hintEl = null;
    this.#loadButton = null;
    this.#removeButton = null;
    this.#tracks = [];
    this.#currentTrack = null;
    this.#cueLayer = null;
  }

  #startListening() {
    const onTick = (payload) => {
      if (payload.shellId === this.#shell.id) {
        this.#render();
      }
    };
    this.#frameUnsub = this.#shell.bus.on("shell:frame", onTick);
    this.#timeupdateUnsub = this.#shell.bus.on("shell:timeupdate", onTick);
    const video = this.#shell.video;
    this.#onSeeked = () => this.#render();
    this.#onEnded = () => this.#shell?.cues?.clear();
    video?.addEventListener("seeked", this.#onSeeked);
    video?.addEventListener("ended", this.#onEnded);
  }

  #stopListening() {
    this.#frameUnsub?.();
    this.#frameUnsub = null;
    this.#timeupdateUnsub?.();
    this.#timeupdateUnsub = null;
    const video = this.#shell?.video;
    video?.removeEventListener("seeked", this.#onSeeked);
    video?.removeEventListener("ended", this.#onEnded);
    this.#onSeeked = null;
    this.#onEnded = null;
    this.#shell?.cues?.clear();
  }

  #render() {
    const cuePool = this.#shell?.cues;
    if (!cuePool) {
      return;
    }
    const cues = this.#currentTrack?.cues;
    if (!cues || !cues.length) {
      cuePool.clear();
      return;
    }
    const currentTime = this.#shell.video?.currentTime;
    if (!(currentTime >= 0)) {
      cuePool.clear();
      return;
    }
    const activeCues = this.#findActiveCues(cues, currentTime);
    const override = this.#positionOverride;
    const rendered = [];
    for (let i = 0; i < activeCues.length; i++) {
      const cue = activeCues[i];
      const line = override ? override.line : cue.line ?? 85;
      const position = override ? override.position : cue.position ?? 50;
      const align = override ? override.align : cue.align || "center";
      rendered.push({
        text: cue.text,
        top: `calc(${line}% - ${i * STACK_OVERLAP_EM}em)`,
        left: `${position}%`,
        x: align === "start" ? "0" : align === "end" ? "-100%" : "-50%"
      });
    }
    cuePool.render(rendered);
  }

  /** Binary search for all cues overlapping `time` (cues sorted by start). */
  #findActiveCues(cues, time) {
    let low = 0;
    let high = cues.length;
    while (low < high) {
      const mid = low + high >> 1;
      if (cues[mid].start <= time) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    const active = [];
    for (let i = low - 1; i >= 0; i--) {
      if (cues[i].end > time) {
        active.push(cues[i]);
      }
    }
    active.reverse();
    return active;
  }

  #buildPanelUi(shell) {
    const panelBody = shell.panel?.body;
    if (!panelBody) {
      return;
    }
    const sectionRoot = shell.panel.addSection("Subtitles", "captions");
    if (!sectionRoot) {
      return;
    }
    const dragCounter = { count: 0 };
    const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");
    const isSubtitleFile = (file) => /\.(srt|vtt)$/i.test(file?.name || "");

    sectionRoot.addEventListener("dragenter", (event) => {
      if (hasFiles(event)) {
        event.preventDefault();
        dragCounter.count++;
        sectionRoot.classList.add("pf-drop-active");
      }
    });
    sectionRoot.addEventListener("dragover", (event) => {
      if (hasFiles(event)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }
    });
    sectionRoot.addEventListener("dragleave", () => {
      dragCounter.count--;
      if (dragCounter.count <= 0) {
        dragCounter.count = 0;
        sectionRoot.classList.remove("pf-drop-active");
      }
    });
    sectionRoot.addEventListener("drop", (event) => {
      event.preventDefault();
      dragCounter.count = 0;
      sectionRoot.classList.remove("pf-drop-active");
      const files = [...(event.dataTransfer?.files || [])].filter(isSubtitleFile);
      if (!files.length) {
        this.#toast({
          icon: "captions",
          text: "Drop a .srt or .vtt file",
          duration: 2000
        });
        return;
      }
      for (const file of files) {
        this.load(file);
      }
    });

    const el = (tag, attrs = {}, parent = panelBody) => {
      const node = document.createElement(tag);
      for (const [key, value] of Object.entries(attrs)) {
        if (key === "style" && typeof value === "object") {
          Object.assign(node.style, value);
        } else {
          node.setAttribute(key, value);
        }
      }
      parent.appendChild(node);
      return node;
    };

    // Load row: upload button, remove button, hint text.
    const loadSection = el("div", { class: "pf-panel-section" }, sectionRoot);
    const loadRow = el("div", { class: "pf-panel-load-row" }, loadSection);
    const actions = el("div", { class: "pf-panel-actions" }, loadRow);

    this.#loadButton = el("button", { class: "pf-btn pf-btn-icon", type: "button" }, actions);
    this.#loadButton.appendChild(createIconElement("upload"));
    this.#loadButton.title = "Load subtitles (.srt / .vtt)";
    this.#loadButton.setAttribute("aria-label", "Load subtitles");
    this.#loadButton.addEventListener("click", () => this.#fileInput?.click());

    this.#removeButton = el("button", { class: "pf-btn pf-btn-ghost pf-btn-icon", type: "button" }, actions);
    this.#removeButton.appendChild(createIconElement("trash"));
    this.#removeButton.title = "Remove subtitles";
    this.#removeButton.setAttribute("aria-label", "Remove subtitles");
    this.#removeButton.addEventListener("click", () => this.#removeAll());

    this.#hintEl = el("div", { class: "pf-panel-hint" }, loadRow);
    this.#refreshHint();

    // Caption style grid: size / color / shadow / sync.
    const styleSection = el("div", { class: "pf-panel-section" }, sectionRoot);
    const styleHead = el("div", { class: "pf-panel-section-head" }, styleSection);
    el("span", { class: "pf-panel-label" }, styleHead).textContent = "Caption style";
    const styleGrid = el("div", { class: "pf-panel-grid pf-panel-grid-compact" }, styleSection);

    const sizeCell = el("div", { class: "pf-panel-cell" }, styleGrid);
    el("span", { class: "pf-panel-label" }, sizeCell).textContent = "Size";
    const sizeStepper = createStepper({
      min: 0.6,
      max: 3,
      step: 0.1,
      value: Number(getConfigValue(SETTING_KEYS.size, "1.2")),
      label: "Caption size",
      onChange: (v) => {
        applySize();
        setConfigValue(SETTING_KEYS.size, String(v));
      }
    });
    sizeCell.appendChild(sizeStepper.root);
    const sizeValue = el("span", { class: "pf-panel-value" }, sizeCell);
    const applySize = () => {
      sizeValue.textContent = `${sizeStepper.getValue()}em`;
      this.#setCueVar("--pf-cue-font-size", `${sizeStepper.getValue()}em`);
    };

    const colorCell = el("div", { class: "pf-panel-cell" }, styleGrid);
    el("span", { class: "pf-panel-label" }, colorCell).textContent = "Color";
    const colorInput = el("input", { type: "color", value: getConfigValue(SETTING_KEYS.color, "#ffffff") }, colorCell);
    const colorValue = el("span", { class: "pf-panel-value" }, colorCell);
    const applyColor = () => {
      colorValue.textContent = colorInput.value;
      this.#setCueVar("--pf-cue-color", colorInput.value);
    };
    colorInput.addEventListener("input", () => {
      applyColor();
      setConfigValue(SETTING_KEYS.color, colorInput.value);
    });

    const shadowCell = el("div", { class: "pf-panel-cell" }, styleGrid);
    el("span", { class: "pf-panel-label" }, shadowCell).textContent = "Shadow";
    const shadowStepper = createStepper({
      min: 0,
      max: 100,
      step: 5,
      value: Number(getConfigValue(SETTING_KEYS.shadow, "40")),
      label: "Caption shadow",
      onChange: () => {
        applyShadow();
        setConfigValue(SETTING_KEYS.shadow, String(shadowStepper.getValue()));
      }
    });
    shadowCell.appendChild(shadowStepper.root);
    const shadowValue = el("span", { class: "pf-panel-value" }, shadowCell);
    const applyShadow = () => {
      const strength = shadowStepper.getValue();
      shadowValue.textContent = strength ? `${strength}%` : "Off";
      this.#setCueVar("--pf-cue-text-shadow", strength
        ? `1px 1px ${Math.round(strength / 6)}px rgba(0, 0, 0, ${(0.4 + strength / 100 * 0.6).toFixed(2)})`
        : "none");
    };

    const syncCell = el("div", { class: "pf-panel-cell" }, styleGrid);
    el("span", { class: "pf-panel-label" }, syncCell).textContent = "Sync";
    let syncDebounce = null;
    const syncStepper = createStepper({
      min: -20,
      max: 20,
      step: 0.25,
      value: this.#syncOffset,
      label: "Subtitle sync offset",
      onChange: () => applySync()
    });
    syncCell.appendChild(syncStepper.root);
    const syncValue = el("span", { class: "pf-panel-value" }, syncCell);
    const applySync = (immediate = false) => {
      const offset = syncStepper.getValue();
      this.#syncOffset = offset;
      syncValue.textContent = offset === 0 ? "0s" : `${offset > 0 ? "+" : ""}${offset}s`;
      clearTimeout(syncDebounce);
      const reparseAll = () => {
        for (const track of this.#tracks) {
          track.cues = parseSubtitles(track.text, this.#syncOffset);
        }
        this.#render();
        setConfigValue(SETTING_KEYS.syncOffset, String(offset));
      };
      if (immediate) {
        reparseAll();
      } else {
        syncDebounce = setTimeout(reparseAll, SYNC_DEBOUNCE_MS);
      }
    };

    const resetButton = el("button", { class: "pf-btn pf-btn-ghost pf-btn-icon", type: "button" }, styleHead);
    resetButton.appendChild(createIconElement("reload"));
    resetButton.title = "Reset style";
    resetButton.setAttribute("aria-label", "Reset style");
    resetButton.addEventListener("click", () => {
      sizeStepper.setValue(1.2);
      applySize();
      colorInput.value = "#ffffff";
      applyColor();
      shadowStepper.setValue(40);
      applyShadow();
      syncStepper.setValue(0);
      applySync(true);
      setConfigValue(SETTING_KEYS.size, String(sizeStepper.getValue()));
      setConfigValue(SETTING_KEYS.color, colorInput.value);
      setConfigValue(SETTING_KEYS.shadow, String(shadowStepper.getValue()));
      setConfigValue(SETTING_KEYS.syncOffset, String(syncStepper.getValue()));
    });

    applySize();
    applyColor();
    applyShadow();
    applySync(true);

    // Position controls.
    const positionSection = el("div", { class: "pf-panel-section" }, sectionRoot);
    el("div", { class: "pf-panel-label" }, positionSection).textContent = "Position";
    const positionRow = el("div", { class: "pf-panel-field pf-panel-pos-row" }, positionSection);

    const enabledCheckbox = el("input", { type: "checkbox" }, positionRow);
    enabledCheckbox.checked = getConfigValue(SETTING_KEYS.posEnabled, true);

    const makeStepper = (label, key, fallback) => {
      const wrap = el("span", { class: "pf-panel-pos-slider" }, positionRow);
      el("span", { class: "pf-panel-label" }, wrap).textContent = label;
      const value = el("span", { class: "pf-panel-value" }, wrap);
      const stepper = createStepper({
        min: 0,
        max: 100,
        step: 5,
        value: Number(getConfigValue(key, fallback)),
        label,
        onChange: () => {
          setConfigValue(key, String(stepper.getValue()));
          if (enabledCheckbox.checked) {
            applyPosition();
          }
        }
      });
      wrap.appendChild(stepper.root);
      return { stepper, value };
    };
    const vertical = makeStepper("Vertical", SETTING_KEYS.line, "85");
    const horizontal = makeStepper("Horizontal", SETTING_KEYS.horizontal, "50");

    const alignSelect = el("select", { class: "pf-select" }, positionRow);
    alignSelect.innerHTML =
      "<option value=\"start\">Start</option><option value=\"center\" selected>Center</option><option value=\"end\">End</option>";
    alignSelect.value = getConfigValue(SETTING_KEYS.align, "center");

    const setManualDisabled = (disabled) => {
      vertical.stepper.setDisabled(disabled);
      horizontal.stepper.setDisabled(disabled);
      alignSelect.disabled = disabled;
    };
    const applyPosition = () => {
      vertical.value.textContent = `${vertical.stepper.getValue()}%`;
      horizontal.value.textContent = `${horizontal.stepper.getValue()}%`;
      this.#positionOverride = enabledCheckbox.checked
        ? {
            line: vertical.stepper.getValue(),
            position: horizontal.stepper.getValue(),
            align: alignSelect.value
          }
        : null;
      this.#render();
    };

    enabledCheckbox.addEventListener("change", () => {
      setManualDisabled(!enabledCheckbox.checked);
      applyPosition();
      setConfigValue(SETTING_KEYS.posEnabled, enabledCheckbox.checked);
    });
    alignSelect.addEventListener("change", () => {
      setConfigValue(SETTING_KEYS.align, alignSelect.value);
      if (enabledCheckbox.checked) {
        applyPosition();
      }
    });

    setManualDisabled(!enabledCheckbox.checked);
    applyPosition();
  }

  #setCueVar(prop, value) {
    this.#cueLayer?.style.setProperty(prop, value);
  }

  #toast(payload) {
    this.#shell?.toast(payload);
  }

  #createFileInput(shell) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = SUBTITLE_FILE_ACCEPT;
    input.style.display = "none";
    shell.container.appendChild(input);
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) {
        this.load(file);
      }
      input.value = "";
    });
    return input;
  }

  async load(file) {
    if (this.#destroyed) {
      return;
    }
    const name = file.name;
    try {
      const rawText = await file.text();
      if (this.#destroyed) {
        return;
      }
      const normalizedText = /\.srt$/i.test(name) ? srtToVtt(rawText) : ensureVttHeader(rawText);
      const cues = parseSubtitles(normalizedText, this.#syncOffset);
      if (!cues.length) {
        this.#toast({
          icon: "captions",
          text: "No cues found",
          duration: 2500
        });
        return;
      }
      this.#tracks.push({
        name,
        text: normalizedText,
        cues
      });
      this.#currentTrack = this.#tracks[this.#tracks.length - 1];
      this.#refreshHint();
      this.#render();
      this.#toast({
        icon: "captions",
        text: name,
        duration: 2000
      });
      logger.log("subtitles", `Loaded ${name}`);
    } catch (err) {
      logger.error("subtitles", `Failed to load ${name}:`, err);
      this.#toast({
        icon: "captions",
        text: "Failed to load subtitles",
        duration: 2500
      });
    }
  }

  #refreshHint() {
    if (this.#hintEl) {
      this.#hintEl.textContent = this.#currentTrack ? this.#currentTrack.name : "Upload your file";
    }
    const hasTrack = !!this.#currentTrack;
    if (this.#loadButton) {
      this.#loadButton.disabled = hasTrack;
    }
    if (this.#removeButton) {
      this.#removeButton.disabled = !hasTrack;
    }
  }

  #removeAll() {
    this.#currentTrack = null;
    this.#tracks = [];
    this.#shell?.cues?.clear();
    this.#refreshHint();
  }
}

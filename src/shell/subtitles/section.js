import { getConfigValue, setConfigValue, gmRequestText } from "../../shared/storage.js";
import { TUNING } from "../chrome/config.js";
import { srtToVtt, ensureVttHeader, parseSubtitles, parseSubtitlesAsync } from "./forgevtt.js";
import { ForgeTrack } from "./forge-track.js";
import { debounce } from "../../shared/time.js";
import { flashElement } from "../chrome/animate.js";
import { el } from "../chrome/elements.js";
import { logger } from "../../shared/logger.js";

const SUBTITLE_FILE_ACCEPT = ".srt,.vtt";
const SUBTITLE_EXT_RE = /\.(srt|vtt)$/i;

const SETTING_KEYS = {
  size: "subtitles.style.size",
  color: "subtitles.style.color",
  shadow: "subtitles.style.shadow",
  line: "subtitles.position.line",
  horizontal: "subtitles.position.horizontal",
  syncOffset: "subtitles.sync.offset"
};

/**
 * Shell-owned subtitles section: loads .srt/.vtt files onto a video and renders
 * cues through the shell's cue layer, with caption styling, manual positioning,
 * and sync offset.
 */
export class SubtitlesSection {
  #shell;
  #forgeTrack = null;
  #trackMeta = null;
  #cueLayer = null;
  #positionOverride = null;
  #syncOffset = 0;
  #fileInput = null;
  #hintEl = null;
  #loadButton = null;
  #removeButton = null;
  #urlButton = null;
  #styleControls = null;
  #positionControls = null;
  #resetBtn = null;
  #scope = new AbortController();
  #destroyed = false;

  constructor(shell) {
    this.#shell = shell;
    this.#syncOffset = Number(getConfigValue(SETTING_KEYS.syncOffset, 0)) || 0;
    this.#cueLayer = shell.shellDom?.cueLayer || null;
    this.#fileInput = this.#createFileInput(shell);
    this.#buildPanelUi(shell);
    this.#startListening();
    logger.log("subtitles", `Ready (${shell.sdk.name})`);
  }

  destroy() {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    this.#scope.abort();
    this.#forgeTrack?.destroy();
    this.#forgeTrack = null;
    this.#fileInput?.remove();
    this.#fileInput = null;
    this.#hintEl = null;
    this.#loadButton = null;
    this.#removeButton = null;
    this.#urlButton = null;
    this.#styleControls = null;
    this.#positionControls = null;
    this.#resetBtn = null;
    this.#trackMeta = null;
    this.#cueLayer = null;
  }

  #startListening() {
    const { signal } = this.#scope;
    const video = this.#shell.video;
    video?.addEventListener("ended", () => this.#forgeTrack?.clear(), { signal, passive: true });
  }

  #buildPanelUi(shell) {
    const panel = shell.panel;
    const panelBody = panel?.body;
    if (!panelBody) {
      return;
    }
    const sectionRoot = panel.addSection("Subtitles", "captions");
    if (!sectionRoot) {
      return;
    }
    const dragCounter = { count: 0 };
    const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");
    const isSubtitleFile = (file) => SUBTITLE_EXT_RE.test(file?.name || "");

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
        duration: TUNING.toast.infoMs,
        group: "subtitles"
        });
        return;
      }
      for (const file of files) {
        this.load(file);
      }
    });

    // Load row: upload button, remove button, hint text.
    const loadSection = panel.el("div", { class: "pf-panel-section" }, sectionRoot);
    const loadRow = panel.el("div", { class: "pf-panel-load-row" }, loadSection);
    const actions = panel.el("div", { class: "pf-panel-actions" }, loadRow);

    this.#loadButton = panel.addControl(actions, {
      type: "button",
      icon: "upload",
      title: "Load subtitles (.srt / .vtt)",
      ariaLabel: "Load subtitles",
      onClick: () => this.#fileInput?.click()
    });

    this.#urlButton = panel.addControl(actions, {
      type: "button",
      icon: "link",
      title: "Load subtitles from URL",
      ariaLabel: "Load subtitles from URL",
      ghost: true,
      onClick: () => this.#promptForUrl()
    });

    this.#removeButton = panel.addControl(actions, {
      type: "button",
      icon: "trash",
      title: "Remove subtitles",
      ariaLabel: "Remove subtitles",
      ghost: true,
      onClick: () => this.#removeTrack()
    });

    this.#hintEl = panel.addHint(loadRow, "Upload your file");

    // Caption style + position grid: size / color / shadow / sync / V / H.
    const styleSection = panel.el("div", { class: "pf-panel-section" }, sectionRoot);
    const styleHead = panel.el("div", { class: "pf-panel-section-head" }, styleSection);
    panel.addLabel(styleHead, "Style & Position");
    const styleGrid = panel.el("div", { class: "pf-panel-grid pf-panel-grid-compact" }, styleSection);

    const applyCueSize = (v) => this.#setCueVar("--pf-cue-font-size", `${v}em`);
    const sizeStepper = panel.addControl(styleGrid, {
      type: "stepper",
      label: "Size",
      min: 0.6,
      max: 3,
      step: 0.1,
      value: getConfigValue(SETTING_KEYS.size, 1.2),
      format: (v) => `${v}em`,
      onChange: (v) => {
        setConfigValue(SETTING_KEYS.size, v);
        applyCueSize(v);
      }
    });
    applyCueSize(sizeStepper.getValue());

    const colorField = panel.addControl(styleGrid, {
      type: "color",
      label: "Color",
      value: getConfigValue(SETTING_KEYS.color, "#ffffff"),
      onChange: (hex) => {
        setConfigValue(SETTING_KEYS.color, hex);
        this.#setCueVar("--pf-cue-color", hex);
      }
    });
    this.#setCueVar("--pf-cue-color", colorField.getValue());

    const applyCueShadow = (strength) => this.#setCueVar("--pf-cue-text-shadow", strength
      ? `1px 1px ${Math.round(strength / 6)}px rgba(0, 0, 0, ${(0.4 + strength / 100 * 0.6).toFixed(2)})`
      : "none");
    const shadowStepper = panel.addControl(styleGrid, {
      type: "stepper",
      label: "Shadow",
      min: 0,
      max: 100,
      step: 5,
      value: getConfigValue(SETTING_KEYS.shadow, 40),
      format: (v) => v ? `${v}%` : "Off",
      onChange: (v) => {
        setConfigValue(SETTING_KEYS.shadow, v);
        applyCueShadow(v);
      }
    });
    applyCueShadow(shadowStepper.getValue());

    const applySyncOffset = debounce((offset) => {
      if (this.#trackMeta) {
        const cues = parseSubtitles(this.#trackMeta.text, offset);
        this.#forgeTrack?.load(cues);
      }
      setConfigValue(SETTING_KEYS.syncOffset, offset);
    }, TUNING.subtitles.syncDebounceMs);
    const syncStepper = panel.addControl(styleGrid, {
      type: "stepper",
      label: "Sync",
      min: -20,
      max: 20,
      step: 0.25,
      value: this.#syncOffset,
      format: (v) => v === 0 ? "0s" : `${v > 0 ? "+" : ""}${v}s`,
      onChange: (offset) => {
        this.#syncOffset = offset;
        applySyncOffset(offset);
      }
    });

    const applyPosition = () => {
      this.#positionOverride = {
        line: verticalStepper.getValue(),
        position: horizontalStepper.getValue(),
        align: "center"
      };
    };

    const verticalStepper = panel.addControl(styleGrid, {
      type: "stepper",
      label: "V",
      min: 0,
      max: 100,
      step: 5,
      value: getConfigValue(SETTING_KEYS.line, 85),
      format: (v) => `${v}%`,
      onChange: (v) => {
        setConfigValue(SETTING_KEYS.line, v);
        applyPosition();
      }
    });
    const horizontalStepper = panel.addControl(styleGrid, {
      type: "stepper",
      label: "H",
      min: 0,
      max: 100,
      step: 5,
      value: getConfigValue(SETTING_KEYS.horizontal, 50),
      format: (v) => `${v}%`,
      onChange: (v) => {
        setConfigValue(SETTING_KEYS.horizontal, v);
        applyPosition();
      }
    });

    applyPosition();

    this.#styleControls = { size: sizeStepper, color: colorField, shadow: shadowStepper, sync: syncStepper };
    this.#positionControls = { vertical: verticalStepper, horizontal: horizontalStepper };

    this.#resetBtn = panel.addControl(styleHead, {
      type: "button",
      icon: "reload",
      title: "Reset all",
      ariaLabel: "Reset all",
      ghost: true,
      onClick: () => {
        sizeStepper.setValue(1.2);
        colorField.setValue("#ffffff");
        shadowStepper.setValue(40);
        syncStepper.setValue(0);
        verticalStepper.setValue(85);
        horizontalStepper.setValue(50);
        flashElement(this.#resetBtn);
        this.#toast({ icon: "reload", text: "Subtitle Style Reset", duration: TUNING.toast.flashMs, group: "subtitles" });
      }
    });

    this.#refreshHint();
  }

  #setCueVar(prop, value) {
    this.#forgeTrack?.setVar(prop, value);
  }

  #toast(payload) {
    this.#shell?.toast(payload);
  }

  #createFileInput(shell) {
    const input = el("input", {
      type: "file",
      accept: SUBTITLE_FILE_ACCEPT,
      style: { display: "none" }
    }, shell.container);
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
    try {
      const rawText = await file.text();
      await this.#ingest(file.name, rawText);
    } catch (err) {
      logger.error("subtitles", `Failed to load ${file.name}:`, err);
      this.#toast({
        icon: "captions",
        text: "Failed to load subtitles",
        duration: TUNING.toast.infoMs,
        group: "subtitles"
      });
    }
  }

  /** Fetch a subtitle file from the web through the manager's xhr. */
  async loadFromUrl(rawUrl) {
    if (this.#destroyed) {
      return;
    }
    const url = String(rawUrl || "").trim();
    if (!url) {
      return;
    }
    let response;
    try {
      response = await gmRequestText(url);
    } catch (err) {
      logger.error("subtitles", `Failed to fetch ${url}:`, err);
      this.#toast({
        icon: "link",
        text: "Failed to fetch subtitles",
        duration: TUNING.toast.infoMs,
        group: "subtitles"
      });
      return;
    }
    try {
      await this.#ingest(this.#nameFromUrl(response.finalUrl || url), response.responseText);
    } catch (err) {
      logger.error("subtitles", `Failed to parse subtitles from ${url}:`, err);
      this.#toast({
        icon: "link",
        text: "Failed to load subtitles",
        duration: TUNING.toast.infoMs,
        group: "subtitles"
      });
    }
  }

  #promptForUrl() {
    // The sandbox forwards prompt() to the page; a hostile page can stub it,
    // in which case the dialog misbehaves and file loading stays untouched.
    const url = window.prompt("Subtitle URL (.srt / .vtt)");
    if (url) {
      this.loadFromUrl(url);
    }
  }

  /** Last path segment as a display name, defaulted to .vtt when unknown. */
  #nameFromUrl(url) {
    try {
      const last = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
      if (!last) {
        return "subtitles.vtt";
      }
      return SUBTITLE_EXT_RE.test(last) ? last : `${last}.vtt`;
    } catch {
      return "subtitles.vtt";
    }
  }

  async #ingest(name, rawText) {
    if (this.#destroyed) {
      return;
    }
    const normalizedText = /\.srt$/i.test(name) ? srtToVtt(rawText) : ensureVttHeader(rawText);
    // Cooperative parse: yields to the browser on large tracks so ingesting a
    // big VTT never blocks playback (see forgevtt.parseSubtitlesAsync).
    const cues = await parseSubtitlesAsync(normalizedText, this.#syncOffset);
    if (!cues.length) {
      this.#toast({
        icon: "captions",
        text: "No cues found",
        duration: TUNING.toast.infoMs,
        group: "subtitles"
      });
      return;
    }
    if (!this.#forgeTrack) {
      this.#forgeTrack = new ForgeTrack(this.#shell.video, this.#cueLayer);
    }
    this.#trackMeta = { name, text: normalizedText };
    this.#forgeTrack.load(cues);
    this.#refreshHint();
    this.#toast({
      icon: "captions",
      text: name,
      duration: TUNING.toast.infoMs,
      group: "subtitles"
    });
    logger.log("subtitles", `Loaded ${name}`);
  }

  #refreshHint() {
    if (this.#hintEl) {
      this.#hintEl.textContent = this.#trackMeta ? this.#trackMeta.name : "Upload your file";
    }
    const hasTrack = !!this.#trackMeta;
    if (this.#loadButton) {
      this.#loadButton.disabled = hasTrack;
    }
    if (this.#urlButton) {
      this.#urlButton.disabled = hasTrack;
    }
    if (this.#removeButton) {
      this.#removeButton.disabled = !hasTrack;
    }
    if (this.#styleControls) {
      const disabled = !hasTrack;
      this.#styleControls.size.setDisabled(disabled);
      this.#styleControls.color.input.disabled = disabled;
      this.#styleControls.shadow.setDisabled(disabled);
      this.#styleControls.sync.setDisabled(disabled);
    }
    if (this.#positionControls) {
      const disabled = !hasTrack;
      this.#positionControls.vertical.setDisabled(disabled);
      this.#positionControls.horizontal.setDisabled(disabled);
    }
    if (this.#resetBtn) {
      this.#resetBtn.disabled = !hasTrack;
    }
  }

  #removeTrack() {
    this.#forgeTrack?.destroy();
    this.#forgeTrack = null;
    this.#trackMeta = null;
    this.#refreshHint();
  }
}

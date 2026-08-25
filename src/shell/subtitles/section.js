import { getConfigValue, setConfigValue, gmRequestText } from "../../shared/storage.js";
import { TUNING } from "../chrome/config.js";
import { srtToVtt, ensureVttHeader, parseSubtitles } from "./forgevtt.js";
import { findActiveCues } from "./active-cues.js";
import { debounce } from "../../shared/time.js";
import { logger } from "../../shared/logger.js";

const SUBTITLE_FILE_ACCEPT = ".srt,.vtt";

// Shared lookup buffer for the timeupdate path - findActiveCues fills it
// in place, render consumes it before the next tick.
const activeCueBuffer = [];

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
 * Shell-owned subtitles section: loads .srt/.vtt files onto a video and renders
 * cues through the shell's cue layer, with caption styling, manual positioning,
 * and sync offset.
 */
export class SubtitlesSection {
  #shell;
  #track = null;
  #cueLayer = null;
  #positionOverride = null;
  #syncOffset = 0;
  #fileInput = null;
  #hintEl = null;
  #loadButton = null;
  #removeButton = null;
  #urlButton = null;
  #scope = new AbortController();
  #destroyed = false;
  /** Tick listener rides only while a track has cues - see #syncTickSubscription. */
  #onTick = null;
  #tickListening = false;

  constructor(shell) {
    this.#shell = shell;
    this.#syncOffset = Number(getConfigValue(SETTING_KEYS.syncOffset, 0)) || 0;
    this.#cueLayer = shell.shellDom?.cueLayer || null;
    this.#fileInput = this.#createFileInput(shell);
    this.#buildPanelUi(shell);
    this.#startListening();
    logger.log("subtitles", `Ready (${shell.sdkName})`);
  }

  destroy() {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    this.#scope.abort();
    this.#fileInput?.remove();
    this.#fileInput = null;
    this.#hintEl = null;
    this.#loadButton = null;
    this.#removeButton = null;
    this.#urlButton = null;
    this.#track = null;
    this.#cueLayer = null;
  }

  #startListening() {
    const { signal } = this.#scope;
    this.#onTick = (event) => {
      if (event.detail.shellId === this.#shell.id) {
        this.#render();
      }
    };
    const video = this.#shell.video;
    video?.addEventListener("seeked", () => this.#render(), { signal });
    video?.addEventListener("ended", () => this.#shell?.cues?.clear(), { signal });
  }

  /**
   * Attach/detach the pf:shell-timeupdate listener to match cue presence.
   * Without a track the section previously sat on every tick of every shell
   * just to early-return in render - now trackless pages cost nothing. The
   * load path rejects zero-cue files, so track presence implies cues there;
   * offset shifts can empty an existing track's cues, hence re-syncing here
   * too. Registered under #scope.signal so destroy() stays leak-free.
   */
  #syncTickSubscription() {
    if (this.#destroyed) {
      return;
    }
    const shouldListen = !!(this.#track?.cues?.length);
    if (shouldListen === this.#tickListening) {
      return;
    }
    this.#tickListening = shouldListen;
    const bus = this.#shell?.bus;
    if (!bus) {
      return;
    }
    if (shouldListen) {
      bus.addEventListener("pf:shell-timeupdate", this.#onTick, { signal: this.#scope.signal });
      // Catch-up so text shows on the first frame after load.
      this.#render();
    } else {
      bus.removeEventListener("pf:shell-timeupdate", this.#onTick);
    }
  }

  #render() {
    const cues = this.#shell?.cues;
    if (!cues) {
      return;
    }
    const currentTime = this.#shell.video?.currentTime;
    if (!this.#track || !(currentTime >= 0)) {
      cues.clear();
      return;
    }
    cues.render(findActiveCues(this.#track.cues, currentTime, activeCueBuffer));
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

    this.#loadButton = panel.addButton(actions, {
      icon: "upload",
      title: "Load subtitles (.srt / .vtt)",
      ariaLabel: "Load subtitles",
      onClick: () => this.#fileInput?.click()
    });

    this.#removeButton = panel.addButton(actions, {
      icon: "trash",
      title: "Remove subtitles",
      ariaLabel: "Remove subtitles",
      ghost: true,
      onClick: () => this.#removeTrack()
    });

    this.#urlButton = panel.addButton(actions, {
      icon: "link",
      title: "Load subtitles from URL",
      ariaLabel: "Load subtitles from URL",
      ghost: true,
      onClick: () => this.#promptForUrl()
    });

    this.#hintEl = panel.addHint(loadRow, "Upload your file");
    this.#refreshHint();

    // Caption style grid: size / color / shadow / sync.
    const styleSection = panel.el("div", { class: "pf-panel-section" }, sectionRoot);
    const styleHead = panel.el("div", { class: "pf-panel-section-head" }, styleSection);
    panel.addLabel(styleHead, "Caption style");
    const styleGrid = panel.el("div", { class: "pf-panel-grid pf-panel-grid-compact" }, styleSection);

    const applyCueSize = (v) => this.#setCueVar("--pf-cue-font-size", `${v}em`);
    const sizeStepper = panel.addStepper(styleGrid, {
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

    const colorField = panel.addColor(styleGrid, {
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
    const shadowStepper = panel.addStepper(styleGrid, {
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
      if (this.#track) {
        this.#track.cues = parseSubtitles(this.#track.text, offset);
      }
      // A large offset can shift every cue out - drop the tick listener
      // when that leaves an empty track.
      this.#syncTickSubscription();
      this.#render();
      setConfigValue(SETTING_KEYS.syncOffset, offset);
    }, TUNING.subtitles.syncDebounceMs);
    const syncStepper = panel.addStepper(styleGrid, {
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

    panel.addButton(styleHead, {
      icon: "reload",
      title: "Reset style",
      ariaLabel: "Reset style",
      ghost: true,
      onClick: () => {
        sizeStepper.setValue(1.2);
        colorField.setValue("#ffffff");
        shadowStepper.setValue(40);
        syncStepper.setValue(0);
      }
    });

    // Position controls.
    const positionSection = panel.el("div", { class: "pf-panel-section" }, sectionRoot);
    panel.addLabel(positionSection, "Position");
    const positionRow = panel.el("div", { class: "pf-panel-field pf-panel-pos-row" }, positionSection);

    const applyPosition = () => {
      this.#positionOverride = enabledCheckbox.checked
        ? {
            line: verticalStepper.getValue(),
            position: horizontalStepper.getValue(),
            align: alignSelect.value
          }
        : null;
      this.#render();
    };
    const setManualDisabled = (disabled) => {
      verticalStepper.setDisabled(disabled);
      horizontalStepper.setDisabled(disabled);
      alignSelect.disabled = disabled;
    };

    const enabledCheckbox = panel.addCheckbox(positionRow, {
      checked: getConfigValue(SETTING_KEYS.posEnabled, true),
      onChange: (checked) => {
        setManualDisabled(!checked);
        setConfigValue(SETTING_KEYS.posEnabled, checked);
        applyPosition();
      }
    });

    const verticalStepper = panel.addStepper(positionRow, {
      class: "pf-panel-pos-slider",
      label: "Vertical",
      min: 0,
      max: 100,
      step: 5,
      value: getConfigValue(SETTING_KEYS.line, 85),
      format: (v) => `${v}%`,
      onChange: (v) => {
        setConfigValue(SETTING_KEYS.line, v);
        if (enabledCheckbox.checked) {
          applyPosition();
        }
      }
    });
    const horizontalStepper = panel.addStepper(positionRow, {
      class: "pf-panel-pos-slider",
      label: "Horizontal",
      min: 0,
      max: 100,
      step: 5,
      value: getConfigValue(SETTING_KEYS.horizontal, 50),
      format: (v) => `${v}%`,
      onChange: (v) => {
        setConfigValue(SETTING_KEYS.horizontal, v);
        if (enabledCheckbox.checked) {
          applyPosition();
        }
      }
    });

    const alignSelect = panel.addSelect(positionRow, {
      options: [["start", "Start"], ["center", "Center"], ["end", "End"]],
      value: getConfigValue(SETTING_KEYS.align, "center"),
      onChange: (align) => {
        setConfigValue(SETTING_KEYS.align, align);
        if (enabledCheckbox.checked) {
          applyPosition();
        }
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
      return /\.(srt|vtt)$/i.test(last) ? last : `${last}.vtt`;
    } catch {
      return "subtitles.vtt";
    }
  }

  async #ingest(name, rawText) {
    if (this.#destroyed) {
      return;
    }
    const normalizedText = /\.srt$/i.test(name) ? srtToVtt(rawText) : ensureVttHeader(rawText);
    const cues = parseSubtitles(normalizedText, this.#syncOffset);
    if (!cues.length) {
      this.#toast({
        icon: "captions",
        text: "No cues found",
        duration: TUNING.toast.infoMs,
        group: "subtitles"
      });
      return;
    }
    this.#track = { name, text: normalizedText, cues };
    this.#syncTickSubscription();
    this.#refreshHint();
    this.#render();
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
      this.#hintEl.textContent = this.#track ? this.#track.name : "Upload your file";
    }
    const hasTrack = !!this.#track;
    if (this.#loadButton) {
      this.#loadButton.disabled = hasTrack;
    }
    if (this.#urlButton) {
      this.#urlButton.disabled = hasTrack;
    }
    if (this.#removeButton) {
      this.#removeButton.disabled = !hasTrack;
    }
  }

  #removeTrack() {
    this.#track = null;
    this.#syncTickSubscription();
    this.#shell?.cues?.clear();
    this.#refreshHint();
  }
}

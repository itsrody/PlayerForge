import { getConfigValue, setConfigValue, gmRequestText } from "../../shared/storage.js";
import { TUNING } from "../../shared/tuning.js";
import { fmtEm } from "../../shared/primitives.js";
import { srtToVtt, ensureVttHeader } from "./forgevtt.js";
import { ForgeTrack } from "./forge-track.js";
import { debounce } from "../../shared/scheduler.js";
import { flashElement } from "../chrome/animate.js";
import { el } from "../chrome/elements.js";
import { logger } from "../../shared/diagnostics.js";
import { Scope } from "../../shared/scope.js";

const SUBTITLE_FILE_ACCEPT = ".srt,.vtt";
const SUBTITLE_EXT_RE = /\.(srt|vtt)$/i;

const SETTING_KEYS = {
  size: "subtitles.style.size",
  color: "subtitles.style.color",
  shadow: "subtitles.style.shadow",
  syncOffset: "subtitles.sync.offset"
};

/** Single source of truth for the shadow value, shared by the panel apply and
 *  the post-creation re-apply so the two can never drift. */
const cueShadowValue = (strength) => strength
  ? `1px 1px ${Math.round(strength / 6)}px rgba(0, 0, 0, ${(0.4 + strength / 100 * 0.6).toFixed(2)})`
  : "none";

/**
 * Shell-owned subtitles section: loads .srt/.vtt files onto a video through
 * Firefox's native WebVTT parser (ForgeTrack.loadText) and renders cues
 * through the shell's cue layer, with caption styling and sync offset.
 */
export class SubtitlesSection {
  #shell;
  #forgeTrack = null;
  #trackMeta = null;
  /** Cue layer the shell owns; ForgeTrack renders its slots here. */
  #cueLayer = null;
  /** Sync offset currently in effect; applied by ForgeTrack at load time. */
  #syncOffset = 0;
  #fileInput = null;
  #hintEl = null;
  #loadButton = null;
  #removeButton = null;
  #urlButton = null;
  #styleControls = null;
  #resetBtn = null;
  /** Debounced sync-offset apply; cancelled on destroy so no trailing write lands. */
  #scheduleSyncOffset = null;
  #scope = new Scope();

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
    if (this.#scope.disposed) {
      return;
    }
    this.#scope.dispose();
    this.#scheduleSyncOffset?.cancel();
    this.#scheduleSyncOffset = null;
    this.#forgeTrack?.destroy();
    this.#forgeTrack = null;
    this.#fileInput?.remove();
    this.#fileInput = null;
    this.#hintEl = null;
    this.#loadButton = null;
    this.#removeButton = null;
    this.#urlButton = null;
    this.#styleControls = null;
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
    const hasFiles = (event) => event.dataTransfer?.types?.includes("Files") ?? false;
    const isSubtitleFile = (file) => SUBTITLE_EXT_RE.test(file?.name || "");
    const { signal } = this.#scope;

    sectionRoot.addEventListener("dragenter", (event) => {
      if (hasFiles(event)) {
        event.preventDefault();
        dragCounter.count++;
        sectionRoot.classList.add("pf-drop-active");
      }
    }, { signal });
    sectionRoot.addEventListener("dragover", (event) => {
      if (hasFiles(event)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }
    }, { signal });
    sectionRoot.addEventListener("dragleave", () => {
      dragCounter.count--;
      if (dragCounter.count <= 0) {
        dragCounter.count = 0;
        sectionRoot.classList.remove("pf-drop-active");
      }
    }, { signal });
    sectionRoot.addEventListener("drop", (event) => {
      event.preventDefault();
      dragCounter.count = 0;
      sectionRoot.classList.remove("pf-drop-active");
      const files = [...(event.dataTransfer?.files || [])].filter(isSubtitleFile);
      if (!files.length) {
        this.#toastInfo("captions", "Drop a .srt or .vtt file", "subtitles");
        return;
      }
      for (const file of files) {
        this.load(file);
      }
    }, { signal });

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

    // Caption style + sync grid: size / color / shadow / sync.
    const styleSection = panel.el("div", { class: "pf-panel-section" }, sectionRoot);
    const styleHead = panel.el("div", { class: "pf-panel-section-head" }, styleSection);
    panel.addLabel(styleHead, "Style & Sync");
    const styleGrid = panel.el("div", { class: "pf-panel-grid pf-panel-grid-compact" }, styleSection);

    const applyCueSize = (v) => this.#setCueVar("--pf-cue-font-size", `${v}em`);
    const sizeStepper = panel.addControl(styleGrid, {
      type: "stepper",
      label: "Size",
      min: 0.6,
      max: 3,
      step: 0.1,
      value: getConfigValue(SETTING_KEYS.size, 1.2),
      format: fmtEm,
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

    const applyCueShadow = (strength) => this.#setCueVar("--pf-cue-text-shadow", cueShadowValue(strength));
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

    this.#scheduleSyncOffset = debounce((offset) => {
      if (this.#trackMeta) {
        // Rebuild the cue list at the new offset: remove + shift-from-base +
        // re-add. Gecko does not re-index in-place time mutations reliably,
        // while a rebuild always rebuilds scheduling correctly.
        this.#forgeTrack?.setOffset(offset);
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
        this.#scheduleSyncOffset(offset);
      }
    });

    this.#styleControls = { size: sizeStepper, color: colorField, shadow: shadowStepper, sync: syncStepper };

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
        flashElement(this.#resetBtn);
        this.#toastFlash("reload", "Subtitle Style Reset", "subtitles");
      }
    });

    this.#refreshHint();
  }

  #setCueVar(prop, value) {
    this.#forgeTrack?.setVar(prop, value);
  }

  /**
   * Push the persisted cue styling onto the live track.
   *
   * #forgeTrack is created LAZILY, on the first file load, but the styling is
   * applied while the panel is built - #setCueVar is optional-chained, so that
   * apply silently hit a null track and did nothing. Consequence: a user's
   * saved size/colour/shadow only reached the track after they touched the
   * matching stepper, and a stepper moved BEFORE loading a file was discarded
   * along with the early apply. Both paths re-apply here, off the persisted
   * config, so the track is styled correctly the moment it exists.
   */
  #applyCueVars() {
    this.#setCueVar("--pf-cue-font-size", fmtEm(getConfigValue(SETTING_KEYS.size, 1.2)));
    this.#setCueVar("--pf-cue-color", getConfigValue(SETTING_KEYS.color, "#ffffff"));
    this.#setCueVar("--pf-cue-text-shadow", cueShadowValue(getConfigValue(SETTING_KEYS.shadow, 40)));
  }

  #toastFlash(icon, text, group) {
    this.#shell?.toastFlash(icon, text, group);
  }

  #toastInfo(icon, text, group) {
    this.#shell?.toastInfo(icon, text, group);
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
    }, { signal: this.#scope.signal });
    return input;
  }

  async load(file) {
    if (this.#scope.disposed) {
      return;
    }
    try {
      const rawText = await file.text();
      await this.#ingest(file.name, rawText);
    } catch (err) {
      this.#handleLoadError("load", file.name, err);
    }
  }

  /** Fetch a subtitle file from the web through the manager's xhr. */
  async loadFromUrl(rawUrl) {
    if (this.#scope.disposed) {
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
      this.#handleLoadError("fetch", url, err);
      return;
    }
    try {
      await this.#ingest(this.#nameFromUrl(response.finalUrl || url), response.responseText);
    } catch (err) {
      this.#handleLoadError("parse", url, err);
    }
  }

  #handleLoadError(verb, target, err) {
    logger.error("subtitles", `Failed to ${verb} ${target}:`, err);
    this.#toastInfo("captions", `Failed to ${verb} subtitles`, "subtitles");
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
    if (!URL.canParse(url)) {
      return "subtitles.vtt";
    }
    const last = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
    if (!last) {
      return "subtitles.vtt";
    }
    return SUBTITLE_EXT_RE.test(last) ? last : `${last}.vtt`;
  }

  async #ingest(name, rawText) {
    if (this.#scope.disposed) {
      return;
    }
    // SRT is converted to VTT here; everything downstream is Firefox's
    // native WebVTT parser - the text goes to ForgeTrack as a blob <track>
    // src, which parses it and fires cuechange natively. Load failures
    // (CSP, malformed documents) surface as a 0 cue count.
    const vtt = /\.srt$/i.test(name) ? srtToVtt(rawText) : ensureVttHeader(rawText);
    if (!this.#forgeTrack) {
      this.#forgeTrack = new ForgeTrack(this.#shell.video, this.#cueLayer);
      // The panel applied these before any track existed; re-apply now that
      // there is a cue layer to write to.
      this.#applyCueVars();
    }
    const count = await this.#forgeTrack.loadText(vtt, this.#syncOffset);
    // loadText can settle after dispose (abort); re-check before touching UI.
    if (this.#scope.disposed) {
      return;
    }
    if (!count) {
      this.#toastInfo("captions", "No cues found", "subtitles");
      return;
    }
    this.#trackMeta = { name };
    this.#refreshHint();
    this.#toastInfo("captions", name, "subtitles");
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

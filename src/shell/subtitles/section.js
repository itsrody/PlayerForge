import { getConfigValue, setConfigValue, gmRequestText } from "../../shared/storage.js";
import { TUNING } from "../../shared/tuning.js";
import { fmtPercent, fmtEm } from "../../shared/formatters.js";
import { srtToVtt, ensureVttHeader, offsetCues, parseSubtitlesAsync } from "./forgevtt.js";
import { ForgeTrack } from "./forge-track.js";
import { DebouncedWriter, DestroyableWriter } from "../../shared/debounced-writer.js";
import { composeTimeout } from "../../shared/signal.js";
import { flashElement } from "../chrome/animate.js";
import { el } from "../chrome/elements.js";
import { logger } from "../../shared/logger.js";

const SUBTITLE_FILE_ACCEPT = ".srt,.vtt";
const SUBTITLE_EXT_RE = /\.(srt|vtt)$/i;

/**
 * Race a promise against an AbortSignal. When the signal aborts, the returned
 * promise rejects with an AbortError. The original promise's result is still
 * returned if it settles first. Used to compose GM_xmlhttpRequest (which lacks
 * native AbortController support) with timeout/section-scope signals.
 */
function raceWithAbort(promise, signal) {
  if (!signal || signal.aborted) {
    return promise;
  }
  const { promise: abortPromise, reject } = Promise.withResolvers();
  const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  signal.addEventListener("abort", onAbort, { once: true });
  return Promise.race([promise, abortPromise]).finally(() => {
    signal.removeEventListener("abort", onAbort);
  });
}

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
  /** Cues parsed at zero offset; the sync stepper re-offsets this base. */
  #baseCues = null;
  #cueLayer = null;
  #syncOffset = 0;
  #fileInput = null;
  #hintEl = null;
  #loadButton = null;
  #removeButton = null;
  #urlButton = null;
  #styleControls = null;
  #positionControls = null;
  #resetBtn = null;
  /** Debounced sync-offset apply; auto-flushed on destroy via AbortSignal. */
  #scheduleSyncOffset = null;
  /** Per-key trailing persist for the style steppers: auto-flushed on destroy. */
  #styleWriters;
  #scope = new AbortController();
  #destroyed = false;

  constructor(shell) {
    this.#shell = shell;
    this.#syncOffset = Number(getConfigValue(SETTING_KEYS.syncOffset, 0)) || 0;
    this.#cueLayer = shell.shellDom?.cueLayer || null;
    this.#fileInput = this.#createFileInput(shell);
    // DestroyableWriter auto-flushes all per-key writers on scope abort.
    this.#styleWriters = new DestroyableWriter(this.#scope.signal);
    this.#buildPanelUi(shell);
    this.#startListening();
    logger.log("subtitles", `Ready (${shell.sdk.name})`);
  }

  destroy() {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    // Abort the scope — DebouncedWriter and DestroyableWriter flush automatically.
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
      format: fmtEm,
      onChange: (v) => {
        applyCueSize(v);
        this.#persistStyle(SETTING_KEYS.size, v);
      }
    });
    applyCueSize(sizeStepper.getValue());

    const colorField = panel.addControl(styleGrid, {
      type: "color",
      label: "Color",
      value: getConfigValue(SETTING_KEYS.color, "#ffffff"),
      onChange: (hex) => {
        this.#setCueVar("--pf-cue-color", hex);
        this.#persistStyle(SETTING_KEYS.color, hex);
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
        applyCueShadow(v);
        this.#persistStyle(SETTING_KEYS.shadow, v);
      }
    });
    applyCueShadow(shadowStepper.getValue());

    this.#scheduleSyncOffset = new DebouncedWriter((offset) => {
      if (this.#trackMeta) {
        // Re-offset the parsed base: one O(n) numeric pass per step instead
        // of a full text re-parse (normalize/split/regex/entity decode).
        this.#forgeTrack?.load(offsetCues(this.#baseCues, offset));
      }
      setConfigValue(SETTING_KEYS.syncOffset, offset);
    }, TUNING.subtitles.syncDebounceMs, this.#scope.signal);
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
        this.#scheduleSyncOffset.call(offset);
      }
    });

    const verticalStepper = panel.addControl(styleGrid, {
      type: "stepper",
      label: "V",
      min: 0,
      max: 100,
      step: 5,
      value: getConfigValue(SETTING_KEYS.line, 85),
      format: fmtPercent,
      onChange: (v) => {
        setConfigValue(SETTING_KEYS.line, v);
      }
    });
    const horizontalStepper = panel.addControl(styleGrid, {
      type: "stepper",
      label: "H",
      min: 0,
      max: 100,
      step: 5,
      value: getConfigValue(SETTING_KEYS.horizontal, 50),
      format: fmtPercent,
      onChange: (v) => {
        setConfigValue(SETTING_KEYS.horizontal, v);
      }
    });

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
        this.#toastFlash("reload", "Subtitle Style Reset", "subtitles");
      }
    });

    this.#refreshHint();
  }

  #setCueVar(prop, value) {
    this.#forgeTrack?.setVar(prop, value);
  }

  /** Debounced per-key config write for the style steppers. */
  #persistStyle(key, value) {
    let writer = this.#styleWriters.get(key);
    if (!writer) {
      writer = this.#styleWriters.add(key, (v) => setConfigValue(key, v), TUNING.subtitles.syncDebounceMs);
    }
    writer.call(value);
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
    if (this.#destroyed) {
      return;
    }
    try {
      const rawText = await file.text();
      await this.#ingest(file.name, rawText);
    } catch (err) {
      this.#handleLoadError("load", file.name, err);
    }
  }

  /** Fetch a subtitle file from the web through the manager's xhr.
   *  Uses AbortSignal.timeout() (Firefox 100+) composed with the section scope
   *  via AbortSignal.any() (Firefox 109+) so a slow/dead fetch is bounded at
   *  15s and a destroyed section cancels in-flight requests immediately. The
   *  composed signal is raced against the GM_xmlhttpRequest promise; abort
   *  rejects with AbortError, which #handleLoadError surfaces as a normal
   *  fetch failure. */
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
      const { signal } = this.#scope;
      const fetchSignal = composeTimeout(signal, 15000);
      response = await raceWithAbort(gmRequestText(url), fetchSignal);
    } catch (err) {
      if (err.name === "AbortError") {
        // Destroyed section or timeout — surface as a generic fetch failure.
        this.#handleLoadError("fetch", url, new Error("Request timed out or was cancelled"));
      } else {
        this.#handleLoadError("fetch", url, err);
      }
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
    if (this.#destroyed) {
      return;
    }
    const normalizedText = /\.srt$/i.test(name) ? srtToVtt(rawText) : ensureVttHeader(rawText);
    // Cooperative in-band parse (forgevtt.parseSubtitlesAsync): the ~50ms
    // budget between blocks hands back to the browser through scheduler.yield()
    // (Firefox 157 native), so even a multi-megabyte VTT ingest never blocks
    // playback - no worker hop needed on Gecko. Everything downstream is
    // Firefox's native subtitle flow: cues land on a TextTrack as VTTCues and
    // the browser owns cue scheduling. The base is parsed at zero offset and
    // the current sync offset is applied as a numeric pass so later sync
    // drags never re-touch the text.
    const cues = await parseSubtitlesAsync(normalizedText, 0);
    // Cooperative parse yields to the browser; the section may have been torn
    // down mid-await, so re-check before touching the track/slots.
    if (this.#destroyed) {
      return;
    }
    if (!cues.length) {
      this.#toastInfo("captions", "No cues found", "subtitles");
      return;
    }
    if (!this.#forgeTrack) {
      this.#forgeTrack = new ForgeTrack(this.#shell.video, this.#cueLayer);
    }
    this.#trackMeta = { name };
    this.#baseCues = cues;
    this.#forgeTrack.load(offsetCues(cues, this.#syncOffset));
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
    if (this.#positionControls) {
      this.#positionControls.vertical.setDisabled(!hasTrack);
      this.#positionControls.horizontal.setDisabled(!hasTrack);
    }
    if (this.#resetBtn) {
      this.#resetBtn.disabled = !hasTrack;
    }
  }

  #removeTrack() {
    this.#forgeTrack?.destroy();
    this.#forgeTrack = null;
    this.#trackMeta = null;
    this.#baseCues = null;
    this.#refreshHint();
  }
}

/**
 * The qualities-menu adaptor: reads an SDK's own quality menu, mirrors its
 * entries into the shell panel, and switches quality through the vendor's own
 * handlers - no SDK API surface is touched, because the tree's contract with
 * an adopted player is DOM-shaped (the same posture the discovery/identity
 * planes ride).
 *
 * The per-record vocabulary lives on the SDK registry (detection.js `quality`),
 * spelled only by records whose vendor menu was verified in vendor source.
 * Two planes:
 *   select  - Bitmovin: a native <select> rebuilt eagerly; entries are its
 *             <option> children, active is the selected IDL property, the
 *             switch verb is set .value + dispatch change (the vendor's own
 *             change listener calls player.setVideoQuality).
 *   menu    - everything else: an aria/class menu whose items, active
 *             witness, labels, values and clone verb ride the record's
 *             kinds. The one doubly-lazy vendor (OvenPlayer) declares an
 *             open walk: the settings button and the quality row must be
 *             clicked before its items exist, and the vendor destroys its
 *             own menu DOM on every close.
 *
 * Rendering quirks the reads absorb, all probe-proven (check/.tmp/
 * quality-probe.mjs): plain querySelectorAll crosses no shadow boundary, so
 * every lookup rides the deep walk (document-wide recursive descent through
 * el.shadowRoot - closed roots read null and are skipped, the only page-realm
 * reach on Firefox); menus may portal to document.body, so item scope is
 * document-wide whenever a record leaves its menu root null; a clone-rendered
 * menu (Vidstack) fills in after one animation frame, so nothing is read
 * before a consumer asks.
 */
import { TUNING } from "../shared/core.js";
import { Fan, delay, logger } from "../shared/runtime.js";

/** Hostile-label admission ceiling: a vendor menu row's text is capped once
 *  at read, before it can reach a render surface. 64 chars covers every real
 *  quality label ("1080p 4.5 Mbps", "High", "Auto (1080p)"). */
const LABEL_CAP = 64;

const EMPTY = Object.freeze({ entries: Object.freeze([]), active: -1 });

/**
 * One adaptor per shell, constructed in the boot step list before the forge
 * bar (which seeds its button visibility off the adaptor's state and
 * subscribes to its fan). `quality` is the descriptor's vocabulary or null.
 */
export class QualityAdaptor {
  #video;
  #container;
  #quality;
  #fan = new Fan("quality");
  /** Last non-empty read. Held because a lazy vendor destroys its own menu
   *  DOM on close - the snapshot is what keeps entries listed after that. */
  #snapshot = EMPTY;
  /** Sticky: once a read has seen entries, availability never retracts (a
   *  menu destroyed by the vendor between reads is not a product change). */
  #available = false;

  constructor(video, container, quality, signal) {
    this.#video = video;
    this.#container = container;
    this.#quality = quality ?? null;
    if (!this.#quality) {
      return;
    }
    // Eager probe: at construction and again when the media next proves its
    // data. No open arms here - a doubly-lazy vendor reports unavailable at
    // loadeddata by design; the arms run only when a consumer asks.
    this.#probe();
    this.#video.addEventListener("loadeddata", () => this.#probe(), { signal });
    // A real dimension change re-probes: a vendor-side switch (their own ABR
    // or their own menu) resizes the media, and the witness may have moved
    // under us.
    this.#video.addEventListener("resize", () => this.#probe(), { signal });
  }

  /** The record carries a quality vocabulary - the panel tab exists. */
  get supported() {
    return this.#quality !== null;
  }

  /** Sticky availability: true once any read has seen entries. */
  get available() {
    return this.#available;
  }

  /** The current entry list (the snapshot; `read()` refreshes it). */
  get entries() {
    return this.#snapshot.entries;
  }

  /** Index of the active entry in `entries`, or -1 when unknown. */
  get activeIndex() {
    return this.#snapshot.active;
  }

  /** The fan-out owner for quality-state changes (visibility, re-renders). */
  subscribe(cb, opts) {
    return this.#fan.subscribe(cb, opts);
  }

  /**
   * Fresh read for the asker. Eager vendors re-query every time (the panel
   * always shows the vendor's current witness, including switches made in
   * the vendor's own menu). The doubly-lazy vendor arms its open walk once -
   * when no snapshot is held (the first ask, e.g. the section's first open,
   * is what flips availability) - and later asks serve the snapshot:
   * re-opening the vendor's own panel per render would flash it over the
   * video, and switches re-arm on demand.
   */
  read() {
    if (!this.#quality) {
      return EMPTY;
    }
    if (this.#quality.open) {
      if (this.#snapshot.entries.length === 0) {
        const armed = this.#armOpen();
        const fresh = armed ? this.#readNow() : EMPTY;
        this.#settle();
        if (fresh.entries.length > 0) {
          this.#adopt(fresh);
        }
      }
      return this.#snapshot;
    }
    const fresh = this.#readNow();
    // An empty fresh read over a held snapshot keeps the snapshot: sticky
    // availability, and the panel keeps its rows while the vendor churns its
    // menu DOM mid-read.
    if (fresh.entries.length > 0) {
      this.#adopt(fresh);
    }
    return this.#snapshot;
  }

  /**
   * Switch quality through the vendor's own handlers. `entry` is a snapshot
   * entry ({ label, value }) - the switch re-reads the live menu and matches
   * the real item by value, falling back to label, so a menu the vendor
   * rebuilt between read and click still resolves.
   */
  switchTo(entry) {
    const q = this.#quality;
    if (!q) {
      return false;
    }
    if (q.open && this.#collectItems(q).length === 0 && !this.#armOpen()) {
      return false;
    }
    const fresh = this.#readNow();
    const index = fresh.entries.findIndex((candidate) =>
      candidate.value === entry.value || candidate.label === entry.label
    );
    if (index < 0) {
      // The menu left the DOM between arm and read - hand the vendor's panel
      // back closed before leaving (the arm may have opened it).
      this.#settle();
      return false;
    }
    if (!this.#clone(entry)) {
      this.#settle();
      return false;
    }
    // Optimistic snapshot: the chosen entry is active now. The vendor's own
    // witness may move late; eager vendors get the recheck below, lazy
    // vendors re-serve their witness on the next arm.
    this.#snapshot = { entries: fresh.entries, active: index };
    this.#available = true;
    this.#fan.emit({ available: true });
    if (!q.open) {
      // Late witness moves (track/rendition events land after the click, and
      // no vendor exposes an event we own): one delayed fresh read, riding
      // the shared scheduler.
      delay(() => {
        const late = this.#readNow();
        if (late.entries.length > 0) {
          this.#adopt(late);
        }
      }, TUNING.quality.recheckMs);
    }
    return true;
  }

  /* - internals - */

  #probe() {
    if (!this.#quality) {
      return;
    }
    const fresh = this.#readNow();
    if (fresh.entries.length > 0) {
      this.#adopt(fresh);
    }
  }

  #adopt(read) {
    const prev = this.#snapshot;
    const changed =
      read.entries.length !== prev.entries.length ||
      read.active !== prev.active ||
      read.entries.some((e, i) =>
        e.label !== prev.entries[i]?.label || e.value !== prev.entries[i]?.value
      );
    this.#snapshot = read;
    this.#available = true;
    if (changed) {
      this.#fan.emit({ available: true });
    }
  }

  /** The lazy vendor's open walk: click through the record's steps. */
  #armOpen() {
    for (const sel of this.#quality.open.steps) {
      const step = this.#deepQuery(sel);
      if (!step) {
        logger.warn("quality", `Open step "${sel}" not found`);
        return false;
      }
      step.click();
    }
    return true;
  }

  /** Hand the vendor's own panel back closed after an armed read. */
  #settle() {
    const close = this.#quality?.open?.close;
    if (close) {
      this.#deepQuery(close)?.click();
    }
  }

  /* - reads - */

  #readNow() {
    const q = this.#quality;
    if (!q) {
      return EMPTY;
    }
    return q.select ? this.#readSelect(q.select) : this.#readMenu(q);
  }

  #readSelect(sel) {
    const select = this.#deepQuery(sel);
    if (!select) {
      return EMPTY;
    }
    const options = [...select.options];
    const entries = options.map((option) => ({
      // option.value falls back to the text content per spec - the no-value
      // attribute shape is already the label value.
      label: this.#cap(option.textContent),
      value: this.#cap(option.value)
    }));
    // The selected IDL property, not the [selected] attribute: the attribute
    // is only the vendor's rebuild-time projection (probe-pinned).
    const active = options.findIndex((option) => option.selected);
    return { entries, active };
  }

  #readMenu(q) {
    const items = this.#collectItems(q);
    if (items.length === 0) {
      return EMPTY;
    }
    // The label-compare witness resolves its reference first: the element
    // whose text names the active entry (DPlayer's current-quality button).
    const activeLabel = q.active.kind === "label"
      ? this.#cap(this.#deepQuery(q.active.sel)?.textContent ?? "")
      : null;
    const entries = [];
    let active = -1;
    for (const item of items) {
      const label = this.#cap(this.#labelOf(item, q));
      // A row that reads no label (a separator the selector over-matched)
      // is not an entry.
      if (!label) {
        continue;
      }
      const value = q.value ? this.#cap(item.getAttribute(q.value.attr) ?? "") : label;
      entries.push({ label, value });
      if (this.#isActive(item, q, activeLabel, label)) {
        active = entries.length - 1;
      }
    }
    return { entries, active };
  }

  #labelOf(item, q) {
    if (q.label) {
      return item.querySelector(q.label.sel)?.textContent ?? "";
    }
    return item.textContent;
  }

  #isActive(item, q, activeLabel, label) {
    switch (q.active.kind) {
      case "attr":
        return item.getAttribute(q.active.attr) === "true";
      case "cls":
        return item.classList.contains(q.active.cls);
      case "inside":
        return item.querySelector(q.active.sel) !== null;
      case "label":
        return label === activeLabel;
      default:
        return false;
    }
  }

  /**
   * The record's menu items. Menu-rooted records resolve items under their
   * roots, preferring roots inside the shell's own container when the page
   * hosts several players; menu-null records (portal-hosted menus) ride a
   * document-wide item query, self-scoped by their item selector.
   */
  #collectItems(q) {
    if (!q.menu) {
      return this.#deepQueryAll(q.item);
    }
    const roots = this.#deepQueryAll(q.menu);
    if (roots.length === 0) {
      return [];
    }
    // contains() cannot see into shadow trees - portal-hosted menus ride the
    // fallback (all roots), a recorded caveat.
    const owned = roots.filter((root) => this.#container.contains(root));
    const use = owned.length > 0 ? owned : roots;
    const items = [];
    for (const root of use) {
      for (const item of root.querySelectorAll(q.item)) {
        items.push(item);
      }
    }
    return items;
  }

  /* - switch verbs - */

  #clone(entry) {
    const q = this.#quality;
    if (q.select) {
      const select = this.#deepQuery(q.select);
      if (!select) {
        return false;
      }
      select.value = entry.value;
      // The vendor's own change listener owns the switch; a programmatic
      // .value write fires nothing natively.
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    if (q.clone.kind === "menu-value") {
      const root = this.#deepQuery(q.menu);
      if (!root) {
        return false;
      }
      // Verified vendor chain (media-chrome): the value setter finds the
      // matching item, moves the checked state, and dispatches the change
      // event the rendition controller listens to - no isTrusted gate.
      root.value = entry.value;
      return true;
    }
    const items = this.#collectItems(q);
    const target = items.find((item) => this.#matchesEntry(item, q, entry));
    if (!target) {
      return false;
    }
    // The vendor's own click handler owns the switch (a programmatic .click()
    // rides it - no isTrusted gate on any verified vendor).
    target.click();
    return true;
  }

  #matchesEntry(item, q, entry) {
    const label = this.#cap(this.#labelOf(item, q));
    const value = q.value ? this.#cap(item.getAttribute(q.value.attr) ?? "") : label;
    return (value !== "" && value === entry.value) || label === entry.label;
  }

  #cap(text) {
    return (text ?? "").trim().slice(0, LABEL_CAP);
  }

  /* - the deep walk - */

  /**
   * Document-wide lookups that cross open shadow boundaries: the light pass
   * answers the common eager shape in one native call; only when it misses
   * does the walk descend through el.shadowRoot recursively (closed roots
   * read null and are skipped - the probe's page-realm premise).
   */
  #deepQueryAll(selector) {
    const out = [...document.querySelectorAll(selector)];
    if (out.length > 0) {
      return out;
    }
    const walk = (root) => {
      for (const el of root.querySelectorAll(selector)) {
        out.push(el);
      }
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) {
          walk(el.shadowRoot);
        }
      }
    };
    walk(document);
    return out;
  }

  #deepQuery(selector) {
    const hit = document.querySelector(selector);
    if (hit) {
      return hit;
    }
    const walk = (root) => {
      for (const el of root.querySelectorAll("*")) {
        if (el.matches(selector)) {
          return el;
        }
        if (el.shadowRoot) {
          const found = walk(el.shadowRoot);
          if (found) {
            return found;
          }
        }
      }
      return null;
    };
    return walk(document);
  }
}

/**
 * The panel section. Exists for any record that carries a quality vocabulary
 * (`supported`); rows render from the adaptor's snapshot and re-render on the
 * fan, so a doubly-lazy vendor's first section open - which arms the open
 * walk through `read()` - is what flips availability visible. Returns null
 * when the shell has no quality vocabulary: the panel owns the (absent) DOM
 * teardown, matching the HistorySection pattern.
 */
export function addQualitySection(panel, shell, signal = null) {
  const adaptor = shell.quality;
  if (!adaptor?.supported) {
    return null;
  }
  return new QualitySection(panel, adaptor, signal);
}

class QualitySection {
  #panel;
  #adaptor;
  #list;
  #hint;

  constructor(panel, adaptor, signal = null) {
    this.#panel = panel;
    this.#adaptor = adaptor;
    const sectionRoot = panel.addSection("Quality", "quality");
    if (!sectionRoot) {
      return;
    }

    this.#list = panel.el("div", { class: "pf-quality-list" }, sectionRoot);
    // One delegated listener for the whole list (the HistorySection shape):
    // row count is runtime-dynamic, so listener lifetime must not ride the
    // row cycle.
    this.#list.addEventListener("click", (event) => this.#onRowClick(event), { signal });
    this.#hint = panel.el("div", { class: "pf-panel-hint" }, sectionRoot);
    this.#hint.textContent = "No quality options";

    // First read: for a doubly-lazy vendor this is where the open walk arms
    // and availability flips. The subscription rides the shell scope's
    // signal handed in the section context.
    this.#render();
    adaptor.subscribe(() => this.#render(), { signal });
  }

  #render() {
    const { entries, active } = this.#adaptor.read();
    this.#hint.hidden = entries.length > 0;
    this.#list.hidden = entries.length === 0;
    // replaceChildren() - the pooled-clear backend, not a text setter.
    this.#list.replaceChildren();
    entries.forEach((entry, index) => {
      const row = this.#panel.el("button", {
        type: "button",
        class: index === active
          ? "pf-quality-row pf-quality-row-active"
          : "pf-quality-row"
      }, this.#list);
      row.dataset.index = String(index);
      // textContent only - never markup: the label is page-authored text.
      row.textContent = entry.label;
    });
  }

  #onRowClick(event) {
    const row = event.target.closest(".pf-quality-row");
    if (!row) {
      return;
    }
    const entry = this.#adaptor.entries[Number(row.dataset.index)];
    if (!entry) {
      return;
    }
    this.#adaptor.switchTo(entry);
  }
}

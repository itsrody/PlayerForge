import { DomPool } from "../../shared/dom-pool.js";
import { formatTime } from "../../shared/time.js";
import { flashElement } from "./animate.js";
import { button } from "./elements.js";
import { createIconElement } from "./icons.js";

function formatDomain(domain) {
  if (!domain) return "";
  return domain.charAt(0).toUpperCase() + domain.slice(1);
}

export function addHistorySection(panel, shell) {
  const sectionRoot = panel.addSection("History", "resume");
  if (!sectionRoot) {
    return;
  }

  const list = panel.el("div", { class: "pf-history-list" }, sectionRoot);
  const hint = panel.el("div", { class: "pf-panel-hint" }, sectionRoot);
  hint.textContent = "No watch history yet";

  /** Tracks which cards are currently in the DOM (acquired from pool). */
  const activeCards = [];

  /**
   * Element refs captured when the pool builds a card. The card tree is
   * fixed at factory time, so renderCard/reset re-read these instead of
   * re-running two querySelector calls per card per render (a structural
   * render walks every pooled card - 200 entries is 400 lookups saved).
   */
  const cardRefs = new WeakMap();

  const refsFor = (card) => {
    let refs = cardRefs.get(card);
    if (!refs) {
      const info = card.querySelector(".pf-history-info");
      refs = {
        title: info.querySelector(".pf-history-title"),
        meta: info.querySelector(".pf-history-meta")
      };
      cardRefs.set(card, refs);
    }
    return refs;
  };

  /** Pool of reusable card elements. Factory builds the full tree;
   *  reset clears text + buttons so renderCard() can repopulate. */
  const cardPool = new DomPool({
    factory: () => {
      const card = panel.el("div", { class: "pf-history-card" });
      const info = panel.el("div", { class: "pf-history-info" }, card);
      const title = panel.el("div", { class: "pf-history-title" }, info);
      const meta = panel.el("div", { class: "pf-history-meta" }, info);
      const actions = panel.el("div", { class: "pf-history-actions" }, card);
      button({
        class: "pf-btn pf-btn-icon pf-btn-ghost",
        title: "Reset",
        "aria-label": "Reset resume position",
        "data-action": "reset",
        icon: createIconElement("reload")
      }, actions);
      button({
        class: "pf-btn pf-btn-icon pf-btn-ghost",
        title: "Remove",
        "aria-label": "Remove from history",
        "data-action": "remove",
        icon: createIconElement("trash")
      }, actions);
      cardRefs.set(card, { title, meta });
      return card;
    },
    reset: (card) => {
      card.dataset.entryId = "";
      const refs = refsFor(card);
      refs.title.textContent = "";
      refs.meta.textContent = "";
      return card;
    }
  });

  // Event delegation for the whole list: one static listener instead of one
  // per pooled card. Card count is runtime-dynamic (watched entries, removals,
  // cross-tab adds) and the pool shrinks, so listener lifetime must not ride
  // the card/pool cycle - render() and shrink() never attach or detach a
  // listener. Button clicks bubble up through the card to the list.
  list.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-action]");
    const card = event.target.closest(".pf-history-card");
    if (!btn || !card) {
      return;
    }
    if (btn.dataset.action === "reset") {
      shell.resume?.resetEntry(card.dataset.entryId);
      flashElement(btn);
      shell.toastInfo("reload", "Resume Entry Reset", "history");
    } else if (btn.dataset.action === "remove") {
      // The store's #persist(true) fires onChange synchronously, so the
      // structural render() below reconciles the list (pop the stale card,
      // re-label the rest). Manual mutation here would double-release the
      // clicked card into the pool — render() is the single mutator.
      shell.resume?.removeEntry(card.dataset.entryId);
      shell.toastInfo("trash", "Resume Entry Removed", "history");
    }
  });

  function render() {
    const entries = shell.resume?.getEntries() || [];
    // Release cards that are no longer needed.
    while (activeCards.length > entries.length) {
      const card = activeCards.pop();
      card.remove();
      cardPool.release(card);
    }
    // Acquire or reuse cards for each entry.
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      let card = activeCards[i];
      if (!card) {
        card = cardPool.acquire();
        activeCards.push(card);
        list.appendChild(card);
      }
      renderCard(entry, card);
    }
    hint.hidden = entries.length > 0;
    // Drop excess pooled cards when the list shrinks significantly.
    if (cardPool.idle > entries.length * 2) {
      cardPool.shrink(entries.length);
    }
  }

  function renderCard(entry, card) {
    card.dataset.entryId = entry.id;
    const refs = refsFor(card);
    refs.title.textContent = entry.title || formatDomain(entry.domain);
    const parts = [formatDomain(entry.domain)];
    if (entry.duration > 0) {
      parts.push(formatTime(entry.duration));
    }
    refs.meta.textContent = parts.join(" \u00b7 ");
  }

  render();
  // The store gains entries throughout the session (new videos watched) and
  // on cross-tab imports; re-render when the entry SET changes so the open
  // History tab never shows a boot-time snapshot. Position-only persists are
  // not structural and stay invisible - the cards don't display position.
  shell.resume?.onChange?.((structural) => {
    if (structural) {
      render();
    }
  });
  return { render };
}

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

  /** Pool of reusable card elements. Factory builds the full tree;
   *  reset clears text + buttons so renderCard() can repopulate. */
  const cardPool = new DomPool({
    factory: () => {
      const card = panel.el("div", { class: "pf-history-card" });
      const info = panel.el("div", { class: "pf-history-info" }, card);
      panel.el("div", { class: "pf-history-title" }, info);
      panel.el("div", { class: "pf-history-meta" }, info);
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
      // Event delegation: one listener per card, not per button.
      card.addEventListener("click", (event) => {
        const btn = event.target.closest("[data-action]");
        if (!btn) return;
        const id = card.dataset.entryId;
        const action = btn.dataset.action;
        if (action === "reset") {
          shell.resume?.resetEntry(id);
          flashElement(btn);
          shell.toastInfo("reload", "Resume Entry Reset", "history");
        } else if (action === "remove") {
          shell.resume?.removeEntry(id);
          card.remove();
          cardPool.release(card);
          const idx = activeCards.indexOf(card);
          if (idx !== -1) activeCards.splice(idx, 1);
          if (!list.children.length) {
            hint.hidden = false;
          }
          shell.toastInfo("trash", "Resume Entry Removed", "history");
        }
      });
      return card;
    },
    reset: (card) => {
      card.dataset.entryId = "";
      const info = card.querySelector(".pf-history-info");
      info.querySelector(".pf-history-title").textContent = "";
      info.querySelector(".pf-history-meta").textContent = "";
      return card;
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
    const info = card.querySelector(".pf-history-info");
    const title = info.querySelector(".pf-history-title");
    title.textContent = entry.title || formatDomain(entry.domain);
    const meta = info.querySelector(".pf-history-meta");
    const parts = [formatDomain(entry.domain)];
    if (entry.duration > 0) {
      parts.push(formatTime(entry.duration));
    }
    meta.textContent = parts.join(" \u00b7 ");
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

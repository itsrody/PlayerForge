import { formatTime } from "../../shared/time.js";
import { flashElement } from "../../shared/flash.js";
import { createIconElement } from "./icons.js";
import { TUNING } from "./config.js";

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

  function render() {
    const entries = shell.resume?.getEntries() || [];
    list.replaceChildren();
    if (entries.length === 0) {
      hint.hidden = false;
      return;
    }
    hint.hidden = true;
    for (const entry of entries) {
      renderCard(entry);
    }
  }

  function renderCard(entry) {
    const card = panel.el("div", { class: "pf-history-card" }, list);

    const info = panel.el("div", { class: "pf-history-info" }, card);
    const title = panel.el("div", { class: "pf-history-title" }, info);
    title.textContent = entry.title || formatDomain(entry.domain);
    const meta = panel.el("div", { class: "pf-history-meta" }, info);
    const parts = [formatDomain(entry.domain)];
    if (entry.duration > 0) {
      parts.push(formatTime(entry.duration));
    }
    meta.textContent = parts.join(" \u00b7 ");

    const actions = panel.el("div", { class: "pf-history-actions" }, card);

    const resetBtn = panel.el("button", {
      class: "pf-btn pf-btn-icon pf-btn-ghost",
      type: "button",
      title: "Reset",
      "aria-label": "Reset resume position"
    }, actions);
    resetBtn.appendChild(createIconElement("reload"));
    resetBtn.addEventListener("click", () => {
      shell.resume?.resetEntry(entry.id);
      flashElement(resetBtn);
      shell.toast({
        icon: "reload",
        text: "Resume Entry Reset",
        duration: TUNING.toast.infoMs,
        group: "history"
      });
    });

    const removeBtn = panel.el("button", {
      class: "pf-btn pf-btn-icon pf-btn-ghost",
      type: "button",
      title: "Remove",
      "aria-label": "Remove from history"
    }, actions);
    removeBtn.appendChild(createIconElement("trash"));
    removeBtn.addEventListener("click", () => {
      shell.resume?.removeEntry(entry.id);
      card.remove();
      if (!list.children.length) {
        hint.hidden = false;
      }
      shell.toast({
        icon: "trash",
        text: "Resume Entry Removed",
        duration: TUNING.toast.infoMs,
        group: "history"
      });
    });
  }

  render();
  return { render };
}

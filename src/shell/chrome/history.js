import { formatTime } from "../../shared/time.js";

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
    list.innerHTML = "";
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
    const done = entry.resume === 0 && entry.duration > 0;
    if (done) {
      card.classList.add("pf-history-done");
    }

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

    panel.el("button", {
      class: "pf-btn pf-btn-icon pf-btn-ghost",
      type: "button",
      title: "Reset",
      "aria-label": "Reset resume position"
    }, actions).addEventListener("click", () => {
      shell.resume?.resetEntry(entry.id);
      entry.resume = 0;
      card.classList.add("pf-history-done");
      shell.toast({
        icon: "resume",
        text: `Reset "${entry.title || entry.domain}"`,
        group: "history"
      });
    });

    panel.el("button", {
      class: "pf-btn pf-btn-icon pf-btn-ghost",
      type: "button",
      title: "Remove",
      "aria-label": "Remove from history"
    }, actions).addEventListener("click", () => {
      shell.resume?.removeEntry(entry.id);
      card.remove();
      if (!list.children.length) {
        hint.hidden = false;
      }
    });
  }

  render();
  return { render };
}

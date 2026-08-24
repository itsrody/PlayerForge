import { createIconElement } from "./icons.js";
import { gmSetClipboard } from "../../shared/storage.js";
import { logger } from "../../shared/logger.js";

function actionButton(panel, parent, icon, label) {
  const button = panel.el("button", { type: "button", class: "pf-btn pf-btn-ghost" }, parent);
  const iconEl = createIconElement(icon);
  if (iconEl) {
    button.appendChild(iconEl);
  }
  panel.el("span", {}, button).textContent = label;
  return button;
}

/**
 * "Data" panel section: the cross-device clipboard bridge for pf:resume.
 * Export serializes the whole store; import merges pasted documents with
 * per-entry last-write-wins, so two devices converge without either losing
 * history. Manual today - automatic the day Violentmonkey ships value sync.
 */
export function addDataSection(panel, shell) {
  if (!panel?.body) {
    return;
  }
  const sectionRoot = panel.addSection("Data", "copy");
  if (!sectionRoot) {
    return;
  }

  panel.addHint(sectionRoot, "Copy your watch progress to move it between devices.");

  actionButton(panel, sectionRoot, "copy", "Copy resume data").addEventListener("click", () => {
    try {
      const data = shell.exportResume();
      if (!data) {
        throw new Error("store unavailable");
      }
      gmSetClipboard(data, "text/plain");
      const count = JSON.parse(data).entries.length;
      shell.toast({ text: `Copied ${count} ${count === 1 ? "entry" : "entries"}`, duration: 2500 });
      logger.log("data", `Exported ${count} resume entries`);
    } catch (err) {
      shell.toast({ text: "Copy failed", duration: 2500 });
      logger.error("data", "Export failed:", err);
    }
  });

  const textarea = panel.el("textarea", {
    class: "pf-data-textarea",
    rows: "3",
    spellcheck: "false",
    placeholder: "Paste exported data here"
  }, sectionRoot);

  actionButton(panel, sectionRoot, "upload", "Import").addEventListener("click", () => {
    const text = textarea.value.trim();
    if (!text) {
      shell.toast({ text: "Paste data first", duration: 2000 });
      return;
    }
    const result = shell.importResume(text);
    if (!result) {
      shell.toast({ text: "Import failed - unrecognized data", duration: 3000 });
      return;
    }
    if (!result.added && !result.updated) {
      shell.toast({ text: "Already up to date", duration: 2000 });
      textarea.value = "";
      return;
    }
    shell.toast({
      text: `Imported ${result.added} new, ${result.updated} updated`,
      duration: 3000
    });
    textarea.value = "";
    logger.log("data", `Import finished: +${result.added}, ~${result.updated}`);
  });

  logger.log("data", "Data section ready");
}

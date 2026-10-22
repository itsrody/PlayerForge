export const CYAN = "\u001b[36m";
export const GREEN = "\u001b[32m";
export const RED = "\u001b[31m";
export const YELLOW = "\u001b[33m";
export const DIM = "\u001b[2m";
export const RESET = "\u001b[0m";

export function banner(msg) {
  console.log(`\n${CYAN}▸ ${msg}${RESET}`);
}

export function row(rows, { width = 74 } = {}) {
  if (rows.length === 0) {
    console.log(`  ${DIM}(no rows)${RESET}`);
    return;
  }
  const names = rows.map((r) => r.name);
  const longest = names.reduce((m, n) => Math.max(m, n.length), 0);
  for (const r of rows) {
    const status =
      r.status === "pass" ? `${GREEN}${"PASS"}${RESET}` :
      r.status === "fail" ? `${RED}${"FAIL"}${RESET}` :
      `${YELLOW}${"SKIP"}${RESET}`;
    const pad = " ".repeat(Math.max(2, width - r.name.length - 11));
    const note = r.note ? `  ${DIM}${r.note}${RESET}` : "";
    console.log(`  ${status}  ${r.name}${pad}${r.ms != null ? `${(r.ms).toFixed(0)}ms` : ""}${note}`);
  }
}

export function verdict(label, { failed, skipped }) {
  if (failed > 0) {
    console.log(`\n  ${RED}${failed} failed / ${skipped} skipped${RESET}`);
    return false;
  }
  console.log(`\n  ${GREEN}${label}: all checks passed (${skipped} skipped)${RESET}`);
  return true;
}

export function fatal(section, error, context) {
  console.error(`\n${RED}▸ ${section}${RESET}`);
  console.error(`  ${error.message}`);
  if (context) {
    console.error(`  ${context}`);
  }
}

export function todoNote(msg) {
  console.log(`  ${DIM}${msg}${RESET}`);
}

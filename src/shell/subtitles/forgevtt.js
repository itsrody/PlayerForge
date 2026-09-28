/** SRT timecode capture; global so srtToVtt rewrites every match in a line. */
const SRT_TIMECODE_RE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/g;
const SRT_BLOCK_RE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->/;
const BOM_RE = /^\uFEFF/;
const CRLF_RE = /\r\n?/g;

export function normalizeText(raw) {
  // NFC at the boundary: composed accents keep matching/timing stable no
  // matter how the source encoded them.
  return raw.normalize("NFC").replace(BOM_RE, "").replace(CRLF_RE, "\n");
}

/** Convert an SRT document into VTT (fixes timecode format, escapes stray "-->"). */
export function srtToVtt(raw) {
  const lines = normalizeText(raw).split("\n");
  const out = [];
  let inTimingBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\d+\s*$/.test(line) && i + 1 < lines.length && SRT_BLOCK_RE.test(lines[i + 1])) {
      inTimingBlock = false;
      continue;
    }
    if (SRT_BLOCK_RE.test(line)) {
      out.push(line.replace(SRT_TIMECODE_RE, (_m, h, m, s, ms) =>
        `${h.padStart(2, "0")}:${m}:${s}.${ms.padStart(3, "0")}`));
      inTimingBlock = true;
      continue;
    }
    if (inTimingBlock && line.includes("-->")) {
      out.push(line.replace(/-->/g, "--\\>"));
      inTimingBlock = false;
      continue;
    }
    out.push(line);
    if (line.trim() === "") {
      inTimingBlock = false;
    }
  }
  return `WEBVTT\n\n${out.join("\n").trim()}\n`;
}

/** Ensure a plain text document carries the WEBVTT magic header. */
export function ensureVttHeader(raw) {
  const text = normalizeText(raw);
  if (/^WEBVTT\b/.test(text)) {
    return text;
  }
  return `WEBVTT\n\n${text.trimStart()}`;
}

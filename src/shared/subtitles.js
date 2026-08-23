const SRT_BLOCK_RE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->/;
const CUE_LINE_RE = /^((?:\d+:\d{1,2}:\d{2}|\d{1,2}:\d{2})[.,]\d{1,3})\s+-->\s+((?:\d+:\d{1,2}:\d{2}|\d{1,2}:\d{2})[.,]\d{1,3})(.*)$/;
const TIMECODE_RE = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/;
const TAG_RE = /<\/?[a-zA-Z][^>]*>/g;
const ENTITY_MAP = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&nbsp;": "\xA0",
  "&lrm;": "\u200E",
  "&rlm;": "\u200F"
};
const ENTITY_RE = /&(?:amp|lt|gt|nbsp|lrm|rlm);/g;

export function normalizeText(raw) {
  return raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
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
      out.push(line.replace(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/g, (_m, h, m, s, ms) =>
        `${h.padStart(2, "0")}:${m}:${s}.${ms.padEnd(3, "0")}`));
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

export function timecodeToSeconds(timecode) {
  const match = TIMECODE_RE.exec(timecode);
  if (match) {
    return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + +("0." + match[4]);
  }
  return null;
}

function decodeCueText(text) {
  return text.replace(TAG_RE, "").replace(ENTITY_RE, (entity) => ENTITY_MAP[entity]);
}

function parseCueSettings(settings) {
  const parsed = {};
  for (const token of settings.trim().split(/\s+/)) {
    if (!token) {
      continue;
    }
    const colon = token.indexOf(":");
    if (colon <= 0) {
      continue;
    }
    const key = token.slice(0, colon);
    const value = token.slice(colon + 1);
    if (key === "line") {
      if (value.endsWith("%")) {
        parsed.line = Number(value.slice(0, -1));
      }
    } else if (key === "position") {
      parsed.position = Number(value.endsWith("%") ? value.slice(0, -1) : value);
    } else if (key === "align") {
      parsed.align = value;
    }
  }
  return parsed;
}

/**
 * Parse a VTT (or SRT already normalized to VTT) document into cue objects.
 * `offset` shifts every cue by a constant number of seconds.
 */
export function parseSubtitles(text, offset = 0) {
  const lines = normalizeText(text).split("\n");
  const cues = [];
  let i = 0;
  while (i < lines.length) {
    const match = CUE_LINE_RE.exec(lines[i]);
    if (!match) {
      i++;
      continue;
    }
    const start = timecodeToSeconds(match[1]);
    const end = timecodeToSeconds(match[2]);
    const settings = parseCueSettings(match[3]);
    i++;
    const bodyLines = [];
    while (i < lines.length && lines[i].trim() !== "") {
      bodyLines.push(lines[i]);
      i++;
    }
    i++;
    if (start == null || end == null) {
      continue;
    }
    const content = decodeCueText(bodyLines.join("\n")).trim();
    if (content) {
      cues.push({
        start: offset ? Math.max(0, start + offset) : start,
        end: offset ? Math.max(0, end + offset) : end,
        text: content,
        line: settings.line,
        position: settings.position,
        align: settings.align
      });
    }
  }
  return sortCues(cues);
}

export function sortCues(cues) {
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

/** SRT timecode capture; global so srtToVtt rewrites every match in a line. */
const SRT_TIMECODE_RE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/g;
const SRT_BLOCK_RE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->/;
const CUE_LINE_RE = /^((?:\d+:\d{1,2}:\d{2}|\d{1,2}:\d{2})[.,]\d{1,3})\s+-->\s+((?:\d+:\d{1,2}:\d{2}|\d{1,2}:\d{2})[.,]\d{1,3})(.*)$/;
const TIMECODE_RE = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/;
const METADATA_BLOCK_RE = /^(NOTE|STYLE|REGION)(?:[ \t]|$)/;
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
const NUMERIC_ENTITY_RE = /&#(x[0-9a-fA-F]+|\d+);/g;

export function normalizeText(raw) {
  // NFC at the boundary: composed accents keep matching/timing stable no
  // matter how the source encoded them.
  return raw.normalize("NFC").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
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

/**
 * Parse a WebVTT/SRT timecode ("HH:MM:SS.mmm", "MM:SS.mmm"; comma also
 * accepted as the fractional separator) into seconds.
 */
export function timecodeToSeconds(timecode) {
  const match = TIMECODE_RE.exec(timecode);
  if (!match) {
    return null;
  }
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number(match[4]) / 1000;
  return hours * 3600 + minutes * 60 + seconds + millis;
}

function decodeNumericEntity(entity) {
  const isHex = entity[2] === "x" || entity[2] === "X";
  const code = parseInt(entity.slice(isHex ? 3 : 2, -1), isHex ? 16 : 10);
  // Lone surrogates are unencodable - fromCodePoint would throw and one
  // hostile entity must not reject the whole track.
  if (!(code >= 1 && code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) {
    return "\uFFFD";
  }
  return String.fromCodePoint(code);
}

function decodeCueText(text) {
  return text
    .replace(TAG_RE, "")
    .replace(ENTITY_RE, (entity) => ENTITY_MAP[entity])
    .replace(NUMERIC_ENTITY_RE, decodeNumericEntity);
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

function parseCueBlock(block, offset) {
  const lines = block.split("\n");
  if (METADATA_BLOCK_RE.test(lines[0])) {
    return null;
  }
  let timingMatch = null;
  let timingIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    timingMatch = CUE_LINE_RE.exec(lines[i]);
    if (timingMatch) {
      timingIndex = i;
      break;
    }
  }
  if (!timingMatch) {
    return null;
  }
  const rawStart = timecodeToSeconds(timingMatch[1]);
  const rawEnd = timecodeToSeconds(timingMatch[2]);
  const settings = parseCueSettings(timingMatch[3]);
  if (rawStart == null || rawEnd == null || !(rawEnd > rawStart)) {
    return null;
  }
  const shiftedEnd = rawEnd + offset;
  if (shiftedEnd <= 0) {
    return null;
  }
  const content = decodeCueText(lines.slice(timingIndex + 1).join("\n").trim());
  if (!content) {
    return null;
  }
  return {
    start: Math.max(rawStart + offset, 0),
    end: shiftedEnd,
    text: content,
    line: settings.line,
    position: settings.position,
    align: settings.align
  };
}

/**
 * Parse a VTT (or SRT already normalized to VTT) document into cue objects
 * using blank-line-delimited blocks per the WebVTT grammar: NOTE/STYLE/REGION
 * metadata blocks are skipped, a cue is its timing line plus payload, and any
 * later timing-looking line inside a payload stays cue text.
 * `offset` shifts every cue by a constant number of seconds; cues pushed
 * fully before zero are dropped, partially shifted ones are clamped.
 */
export function parseSubtitles(text, offset = 0) {
  const cues = [];
  for (const block of normalizeText(text).split(/\n[ \t]*\n/)) {
    const cue = parseCueBlock(block, offset);
    if (cue) {
      cues.push(cue);
    }
  }
  return sortCues(cues);
}

export function sortCues(cues) {
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

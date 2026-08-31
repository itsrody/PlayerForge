/** SRT timecode capture; global so srtToVtt rewrites every match in a line. */
const SRT_TIMECODE_RE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/g;
const SRT_BLOCK_RE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->/;
const CUE_LINE_RE = /^((?:\d+:\d{1,2}:\d{2}|\d{1,2}:\d{2})[.,]\d{1,3})\s+-->\s+((?:\d+:\d{1,2}:\d{2}|\d{1,2}:\d{2})[.,]\d{1,3})(.*)$/;
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
 *
 * Manual charCode scanner instead of the anchored-regex + Number() shape:
 * the regex allocated a capture array (up to 4 groups) plus a Number() call
 * per field, and this runs a couple of times per cue line on track load.
 * Semantic match with the previous /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/
 * - the same inputs parse, the same garbage returns null.
 */
const ZERO = 48, NINE = 57, COLON = 58, DOT = 46, COMMA = 44;

function isDigitCode(c) {
  return c >= ZERO && c <= NINE;
}

export function timecodeToSeconds(timecode) {
  const n = timecode.length;
  let f = -1;
  let colons = 0;
  for (let k = 0; k < n; k++) {
    const c = timecode.charCodeAt(k);
    if (c === DOT || c === COMMA) {
      if (f !== -1) {
        return null;
      }
      f = k;
    } else if (c === COLON) {
      if (f !== -1) {
        return null;
      }
      colons++;
    } else if (!isDigitCode(c)) {
      return null;
    }
  }
  if (f === -1 || colons < 1 || colons > 2) {
    return null;
  }
  const fdigits = n - f - 1;
  if (fdigits < 1 || fdigits > 3) {
    return null;
  }

  let i = 0;
  const field = (max) => {
    let val = 0;
    let count = 0;
    while (i < f && isDigitCode(timecode.charCodeAt(i))) {
      val = val * 10 + (timecode.charCodeAt(i) - ZERO);
      i++;
      count++;
    }
    return { val, count };
  };

  // H:M:S (2 colons) or M:S (1 colon). Two colons put the first group in hours.
  if (colons === 2) {
    const h = field(Number.MAX_SAFE_INTEGER); // \d+
    if (h.count === 0 || i >= f || timecode.charCodeAt(i) !== COLON) {
      return null;
    }
    i++;
    const m = field(2); // \d{1,2}
    if (m.count < 1 || m.count > 2 || i >= f || timecode.charCodeAt(i) !== COLON) {
      return null;
    }
    i++;
    const s = field(2); // \d{2} exactly
    if (s.count !== 2 || i < f) {
      return null;
    }
    let ms = 0;
    for (let k = f + 1; k < n; k++) {
      ms = ms * 10 + (timecode.charCodeAt(k) - ZERO);
    }
    return h.val * 3600 + m.val * 60 + s.val + ms / 1000;
  }

  const m = field(2); // \d{1,2}
  if (m.count < 1 || m.count > 2 || i >= f || timecode.charCodeAt(i) !== COLON) {
    return null;
  }
  i++;
  const s = field(2); // \d{2} exactly
  if (s.count !== 2 || i < f) {
    return null;
  }
  let ms = 0;
  for (let k = f + 1; k < n; k++) {
    ms = ms * 10 + (timecode.charCodeAt(k) - ZERO);
  }
  return m.val * 60 + s.val + ms / 1000;
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
  const parsed = { line: 85, position: 50 };
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

/**
 * Cooperative variant of parseSubtitles for large track loads. Checks a
 * ~50ms time budget between blocks and, when spent, yields to the browser
 * via scheduler.yield() (Chromium 129+) so a huge VTT/SRT parse never blocks
 * video playback or paint. Falls back to synchronous parsing when
 * scheduler.yield is unavailable (jsdom/test hosts). Intentionally separate
 * from parseSubtitles so the hot, on-the-fly sync reparse (sync-offset
 * stepper) keeps its zero-await fast path.
 */
const YIELD_BUDGET_MS = 50;
export async function parseSubtitlesAsync(text, offset = 0) {
  const cueText = normalizeText(text);
  const blocks = cueText.split(/\n[ \t]*\n/);
  const canYield = typeof globalThis.scheduler?.yield === "function";
  const cues = [];
  let last = performance.now();
  for (let i = 0; i < blocks.length; i++) {
    const cue = parseCueBlock(blocks[i], offset);
    if (cue) {
      cues.push(cue);
    }
    if (canYield && (i & 127) === 0 && performance.now() - last > YIELD_BUDGET_MS) {
      await globalThis.scheduler.yield();
      last = performance.now();
    }
  }
  return sortCues(cues);
}

export function sortCues(cues) {
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

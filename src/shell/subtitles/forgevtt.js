import { yield_ } from "../../shared/runtime.js";

/** SRT timecode capture; global so srtToVtt rewrites every match in a line. */
const SRT_TIMECODE_RE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/g;
const SRT_BLOCK_RE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->/;
const METADATA_BLOCK_RE = /^(NOTE|STYLE|REGION)(?:[ \t]|$)/;
const ENTITY_MAP = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&nbsp;": "\xA0",
  "&lrm;": "\u200E",
  "&rlm;": "\u200F"
};
/** Single-pass tag-strip + entity-decode alternation: one regex scan over the
 *  payload instead of the previous three replace() sweeps on track load. */
const CUE_TEXT_RE = /<\/?[a-zA-Z][^>]*>|&(?:amp|lt|gt|nbsp|lrm|rlm);|&#(?:x[0-9a-fA-F]+|\d+);/g;
const BOM_RE = /^\uFEFF/;
const CRLF_RE = /\r\n?/g;

function normalizeText(raw) {
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
  return text.replace(CUE_TEXT_RE, (match) => {
    if (match.charCodeAt(0) === 38) {
      return match.charCodeAt(1) === 35 ? decodeNumericEntity(match) : ENTITY_MAP[match];
    }
    return "";
  });
}

/**
 * Shape-stable settings default, fast-returned for cues with no settings tail
 * (the common case on track load). One shared frozen object with the same
 * 3-key object shape as populated settings: parseCueBlock's settings reads stay
 * monomorphic and the no-settings path allocates nothing. Consumers only read
 * the fields into cue objects, so sharing is safe.
 */
const DEFAULT_CUE_SETTINGS = Object.freeze({ line: 85, position: 50, align: undefined });

function parseCueSettings(settings) {
  const rest = settings.trim();
  if (!rest) {
    return DEFAULT_CUE_SETTINGS;
  }
  const parsed = { line: 85, position: 50, align: undefined };
  for (const token of rest.split(/\s+/)) {
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
 * Recognition of a cue timing line as one single-exec regex. The unit's
 * history, newest first: today it rides the engine's C++ regex compiler - the
 * T2 reopen probe (check/.tmp/t2-reopen.mjs, Nov 2026) measured this twin
 * against the manual charCode scanner it replaced on the real engine at
 * whole-parse scale, exact cue-output parity on every corpus plus a hostile
 * column covering the grammar's every asymmetry (the start-side gap is
 * general \s, the end-side gap only [ \t]; the end fraction's cap at three
 * digits makes overflow settings text, which the greedy \d{1,3} + free tail
 * reproduce by backtracking). Measured savings per parse, five alternating
 * collections: 12-15% on the ingest tripwire shape itself (the hotpaths
 * corpus mirror, 19,349 cues / 1.07MB: 8.2ms manual -> 7.2ms), 7-11% on real
 * SRT/prose-heavy/VTT corpora at 2.4-2.7MB. Records before it: the
 * CUE_LINE_RE removal (a capture-heavy state machine had run over every line
 * of every block) and the manual scanner's own A/B era. The indexOf
 * pre-guard stays the admission gate: no regex runs on an arrow-less line,
 * the same guard the manual scanner opened with.
 */
const TWIN_RE = /^(?:(?<sh>\d+):(?<sm>\d{1,2}):(?<ss>\d{2})|(?<sm2>\d{1,2}):(?<ss2>\d{2}))[.,](?<sf>\d{1,3})\s+-->[ \t]+(?:(?<eh>\d+):(?<em>\d{1,2}):(?<es>\d{2})|(?<em2>\d{1,2}):(?<es2>\d{2}))[.,](?<eff>\d{1,3})(?<settings>[\s\S]*)$/;
function parseTimingLine(line) {
  if (line.indexOf("-->") < 0) {
    return null;
  }
  const m = TWIN_RE.exec(line);
  if (!m) {
    return null;
  }
  const g = m.groups;
  const start = g.sh !== undefined
    ? Number(g.sh) * 3600 + Number(g.sm) * 60 + Number(g.ss) + Number(g.sf) / 1000
    : Number(g.sm2) * 60 + Number(g.ss2) + Number(g.sf) / 1000;
  const end = g.eh !== undefined
    ? Number(g.eh) * 3600 + Number(g.em) * 60 + Number(g.es) + Number(g.eff) / 1000
    : Number(g.em2) * 60 + Number(g.es2) + Number(g.eff) / 1000;
  return { start, end, settings: parseCueSettings(g.settings) };
}

function parseCueBlock(block, offset) {
  const lines = block.split("\n");
  if (METADATA_BLOCK_RE.test(lines[0])) {
    return null;
  }
  for (let i = 0; i < lines.length; i++) {
    const t = parseTimingLine(lines[i]);
    if (t) {
      const shiftedEnd = t.end + offset;
      if (!(t.end > t.start) || shiftedEnd <= 0) {
        return null;
      }
      const content = decodeCueText(lines.slice(i + 1).join("\n").trim());
      if (!content) {
        return null;
      }
      return {
        start: Math.max(t.start + offset, 0),
        end: shiftedEnd,
        text: content,
        line: t.settings.line,
        position: t.settings.position,
        align: t.settings.align
      };
    }
  }
  return null;
}

/**
 * Parse a VTT (or SRT already normalized to VTT) document into cue objects
 * using a single forward line scan. Blank/whitespace-only lines end a block
 * (the `\n[ \t]*\n` separator the old split produced), a block whose first
 * line is NOTE/STYLE/REGION is skipped wholesale - regions deliberately: the
 * floor's VTTRegion interface exists (probed on 159) but its per-region
 * layout cannot express in this engine's percent-anchored slot model, and
 * consuming the native surface would route the render through the track
 * path the feature keeps closed -, a cue is its timing line
 * plus the payload after it, and any later timing-looking line inside a
 * payload stays cue text. `offset` shifts every cue by a constant number of
 * seconds; cues pushed fully before zero are dropped, partially shifted ones
 * are clamped.
 */
export function parseSubtitles(text, offset = 0) {
  const src = normalizeText(text);
  const n = src.length;
  const cues = [];
  let timing = null;
  let blockStarted = false;
  let metadataBlock = false;
  let payload = null;

  const finishBlock = () => {
    if (timing && timing.end > timing.start) {
      const shiftedEnd = timing.end + offset;
      if (shiftedEnd > 0) {
        const content = decodeCueText(payload.join("\n").trim());
        if (content) {
          cues.push({
            start: Math.max(timing.start + offset, 0),
            end: shiftedEnd,
            text: content,
            line: timing.settings.line,
            position: timing.settings.position,
            align: timing.settings.align
          });
        }
      }
    }
    timing = null;
    blockStarted = false;
    metadataBlock = false;
    payload = null;
  };

  for (let cur = 0; cur <= n; ) {
    const nl = src.indexOf("\n", cur);
    const lineEnd = nl === -1 ? n : nl;
    const line = src.slice(cur, lineEnd);
    cur = nl === -1 ? n + 1 : nl + 1;

    let blank = true;
    for (let k = 0; k < line.length; k++) {
      const c = line.charCodeAt(k);
      if (c !== 32 && c !== 9) {
        blank = false;
        break;
      }
    }
    if (blank) {
      if (blockStarted) {
        finishBlock();
      }
      continue;
    }
    if (!blockStarted) {
      blockStarted = true;
      if (METADATA_BLOCK_RE.test(line)) {
        metadataBlock = true;
        continue;
      }
    }
    if (metadataBlock) {
      continue;
    }
    if (timing) {
      payload.push(line);
    } else {
      const parsed = parseTimingLine(line);
      if (parsed) {
        timing = parsed;
        payload = [];
      }
    }
  }
  if (blockStarted) {
    finishBlock();
  }
  return sortCues(cues);
}

/**
 * Cooperative variant of parseSubtitles for large track loads. Checks a
 * ~50ms time budget between blocks and, when spent, hands control back via
 * the shared yield_() facade (scheduler.yield, the one cooperative backend)
 * so a huge VTT/SRT parse never blocks video playback or paint. The
 * isInputPending early-yield this once OR'd into the budget check is
 * deprecated (MDN: may report false, a removal candidate; Google's own
 * guidance is scheduler.yield instead) and its known failure mode is our
 * primary topology - it never returns true for input dispatched to
 * cross-origin frames, where this script mostly runs.
 * Intentionally separate from parseSubtitles so the hot,
 * on-the-fly sync reparse (sync-offset stepper) keeps its zero-await fast path.
 */
const YIELD_BUDGET_MS = 50;
export async function parseSubtitlesAsync(text, offset = 0) {
  const cueText = normalizeText(text);
  const blocks = cueText.split(/\n[ \t]*\n/);
  const cues = [];
  let last = performance.now();
  for (let i = 0; i < blocks.length; i++) {
    const cue = parseCueBlock(blocks[i], offset);
    if (cue) {
      cues.push(cue);
    }
    if ((i & 127) === 0 && performance.now() - last > YIELD_BUDGET_MS) {
      await yield_();
      last = performance.now();
    }
  }
  return sortCues(cues);
}

function sortCues(cues) {
  // Packed-key native sort: the ordering job hands to the C++ TypedArray
  // sort (comparator-free; a numeric sort with no callback per spec). Each
  // key packs the start's millisecond value in the high bits and the input
  // index in the low 2^21 bits, so ascending key order IS (start,
  // input-index) order — Array.sort's stability for equal starts reproduced
  // exactly, parity asserted including ties in the delegation probe
  // (8.4ns/record vs the comparator's 34 at the 19k ingest scale). The
  // pack is order-preserving because starts arrive ms-quantized: textual
  // timing parse plus the 0.25s sync-offset vocabulary (shiftTime's clamp
  // to 0 stays on the grid), so Math.round(start * 1000) is the parse's
  // own resolution, exact in float64 far past any track's length. Two
  // starts closer than 1ms would tie by input index instead of
  // exact-float order — a sub-ms ordering window the presented-frame
  // crank cannot see. The 2^21 index slots cap cue counts two orders
  // above the ~19k/1.1MB ingest tripwire.
  const CUE_KEY_SLOTS = 2097152; // 2^21
  const n = cues.length;
  if (n < 2) {
    return cues;
  }
  const keys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    keys[i] = Math.round(cues[i].start * 1000) * CUE_KEY_SLOTS + i;
  }
  keys.sort();
  // Scatter-back rides held references: an in-place scatter would let a
  // permuted read observe an earlier write (the read position can run
  // behind the write position), so the refs pass through one scratch
  // array before committing.
  const ordered = new Array(n);
  for (let i = 0; i < n; i++) {
    ordered[i] = cues[keys[i] % CUE_KEY_SLOTS];
  }
  for (let i = 0; i < n; i++) {
    cues[i] = ordered[i];
  }
  return cues;
}

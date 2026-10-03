/**
 * Which Firefox the harness actually launches.
 *
 * There are two separate questions here and conflating them is how a test run
 * ends up proving something about the wrong engine:
 *
 *   1. What is the SUPPORTED FLOOR? `platform/capabilities.json` owns that:
 *      `target.minFirefox`. It is the oldest release every capability in the
 *      manifest is allowed to assume, and it is a promise to users. Nothing
 *      here may raise it.
 *
 *   2. What did THIS RUN launch? That is a property of the machine, not of the
 *      project, and it is what this module resolves.
 *
 * The test target is deliberately bleeding-edge-first. A dev/nightly build is
 * where a Gecko regression shows up months before it reaches release, so a
 * harness that silently falls back to an older release channel reports green
 * for a build nobody will ship on. The previous resolver listed Developer
 * Edition third, behind release Firefox, so on a machine with both installed
 * the bleeding-edge build was the one that lost.
 *
 * The floor is still enforced, not replaced: a resolved browser older than
 * `target.minFirefox` fails the run rather than passing on a promise it cannot
 * keep. And nothing about the engine is implicit - `describeTarget()` is printed
 * by the runner, because a green integration run against an unstated engine is
 * not evidence about any engine in particular.
 *
 * Resolution order:
 *   FIREFOX_PATH      - explicit binary, wins outright (reported as `custom`)
 *   FIREFOX_CHANNEL   - pin a channel id from the table below
 *   auto              - first installed channel, bleeding-edge first
 *   PATH              - a `firefox` on PATH, last
 *   null              - hand off to geckodriver's own resolution
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, "..", "..");
const MANIFEST_PATH = join(PROJECT_ROOT, "platform", "capabilities.json");

/** @returns {{minFirefox: number, engine: string, manager: string}} */
export function readManifestTarget() {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")).target;
}

/** macOS app path for a channel, in the standard locations. */
function appBinary(appName) {
  return [
    join("/Applications", `${appName}.app`, "Contents", "MacOS", "firefox"),
    join(homedir(), "Applications", `${appName}.app`, "Contents", "MacOS", "firefox"),
  ];
}

/**
 * Installable channels, in resolution order.
 *
 * bleedingEdge marks the channels that run ahead of release. It drives the
 * auto order above and is reported, so a run can be told apart from one that
 * quietly fell back to release without reading this file.
 */
export const FIREFOX_CHANNELS = [
  {
    id: "dev",
    label: "Firefox Developer Edition",
    bleedingEdge: true,
    candidates: appBinary("Firefox Developer Edition"),
  },
  {
    id: "nightly",
    label: "Firefox Nightly",
    bleedingEdge: true,
    candidates: appBinary("Firefox Nightly"),
  },
  {
    id: "release",
    label: "Firefox",
    bleedingEdge: false,
    candidates: appBinary("Firefox"),
  },
];

/**
 * Parse `firefox --version` output.
 *
 * Gecko build strings carry the channel in the third field: `158.0b3` is a
 * Developer Edition build, `160.0a1` nightly, `157.0` release. The letter is
 * worth keeping rather than discarding with a loose major-version match,
 * because "it is 158" and "it is a 158 *beta*" answer different questions when
 * triaging a failure.
 *
 * @param {string} stdout
 * @returns {{version: string, major: number, prerelease: string|null}|null}
 */
export function parseVersion(stdout) {
  const m = /(\d+)\.(\d+)([ab]\d+)?/.exec(String(stdout));
  if (!m) return null;
  return {
    version: `${m[1]}.${m[2]}${m[3] ?? ""}`,
    major: Number(m[1]),
    prerelease: m[3] ?? null,
  };
}

function readVersion(binary) {
  try {
    const out = execFileSync(binary, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    return parseVersion(out);
  } catch {
    return null;
  }
}

function onPath() {
  try {
    const p = execFileSync("which", ["firefox"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return p && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the browser this run will launch.
 *
 * Never throws for a missing browser: `binary: null` is the documented "let
 * geckodriver decide" state, which is what the harness did before any of this.
 * The floor check is reported as `meetsFloor` rather than enforced here,
 * because the callers that care (the runner) want to fail with their own
 * message and exit path.
 *
 * @returns {{
 *   channel: string, label: string, binary: string|null, source: string,
 *   version: string|null, major: number|null, prerelease: string|null,
 *   bleedingEdge: boolean, minFirefox: number, meetsFloor: boolean
 * }}
 */
export function resolveFirefoxTarget() {
  const { minFirefox } = readManifestTarget();

  const build = (channel, label, binary, source, bleedingEdge) => {
    const v = binary ? readVersion(binary) : null;
    return {
      channel,
      label,
      binary,
      source,
      version: v?.version ?? null,
      major: v?.major ?? null,
      prerelease: v?.prerelease ?? null,
      bleedingEdge,
      minFirefox,
      meetsFloor: v ? v.major >= minFirefox : false,
    };
  };

  const envPath = process.env.FIREFOX_PATH;
  if (envPath && existsSync(envPath)) {
    return build("custom", "FIREFOX_PATH binary", envPath, "FIREFOX_PATH", true);
  }

  const pinned = process.env.FIREFOX_CHANNEL;
  if (pinned) {
    const found = FIREFOX_CHANNELS.find((c) => c.id === pinned);
    if (!found) {
      throw new Error(
        `FIREFOX_CHANNEL=${pinned} is not a known channel. Known: ${FIREFOX_CHANNELS.map((c) => c.id).join(", ")}.`
      );
    }
    const binary = found.candidates.find((p) => existsSync(p));
    if (!binary) {
      throw new Error(
        `FIREFOX_CHANNEL=${pinned} was requested but ${found.label} is not installed. Looked in:\n  ${found.candidates.join("\n  ")}`
      );
    }
    return build(found.id, found.label, binary, "FIREFOX_CHANNEL", found.bleedingEdge);
  }

  for (const channel of FIREFOX_CHANNELS) {
    const binary = channel.candidates.find((p) => existsSync(p));
    if (binary) return build(channel.id, channel.label, binary, "auto", channel.bleedingEdge);
  }

  const pathBinary = onPath();
  if (pathBinary) return build("path", "firefox on PATH", pathBinary, "PATH", false);

  return build("geckodriver", "geckodriver default", null, "geckodriver", false);
}

/** One-line summary for runner output. */
export function formatTarget(t) {
  if (!t.binary) return `${t.label} (binary unresolved - geckodriver will choose)`;
  const build = t.version ? `${t.version}${t.prerelease && !t.version.includes(t.prerelease) ? ` ${t.prerelease}` : ""}` : "version unknown";
  return `${t.label} ${build}  ${t.binary}  [${t.channel}/${t.source}${t.bleedingEdge ? ", bleeding-edge" : ""}]`;
}

/**
 * Assert the resolved target clears the support floor.
 *
 * A browser older than `target.minFirefox` means a capability the manifest
 * claims is load-bearing was never present, so a green run would be certifying
 * something the shipped floor does not guarantee.
 *
 * @param {ReturnType<typeof resolveFirefoxTarget>} t
 */
export function assertMeetsFloor(t) {
  if (t.major !== null && !t.meetsFloor) {
    throw new Error(
      `resolved Firefox ${t.version} is below the ${t.minFirefox} support floor (platform/capabilities.json target.minFirefox). ` +
        `Install a newer channel or point FIREFOX_PATH at one.`
    );
  }
  return t;
}
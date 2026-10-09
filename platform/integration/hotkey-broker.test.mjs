/**
 * One page-wide keyboard broker for N players, in a real Firefox instance on the 157+ floor.
 *
 * The keyboard used to be per-player: every InputForge attached its own
 * document-capture keydown/keyup pair and re-ran the same arbitration, which
 * with two or more loaded players answered "is this the engine the user last
 * touched?" - a record only ever written on pointerdown, or by a keydown that
 * had ALREADY passed that check. On a fresh multi-player page nothing had been
 * touched, so no engine accepted the keystroke, nothing wrote the record, and
 * the next key failed identically: hotkeys were dead until the user happened to
 * click a video. Verified before the fix - one player mutes on KeyM, two players
 * mute on nothing.
 *
 * The broker picks the owner up front on a ladder that always has an answer
 * (focused shell, then playing, then last-touched, then boot order), so these
 * assertions pin BOTH halves of the contract: never zero owners, never two.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { FirefoxDriver, TestServer, createTestPage, createTestMedia } from "../harness/firefox.mjs";

let driver;
let server;

const MEDIA_SECONDS = 90;

test.before(async () => {
  server = new TestServer();
  await server.start();
  driver = await FirefoxDriver.launch();
});

test.after(async () => {
  await driver?.destroy();
  await server?.stop();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Open a page with `players` Plyr players and wait for every shell. Each video
 * is pinned in page state and gets a gesture log, because the assertion has to
 * be about which MEDIA ELEMENT answered the keystroke - a leaked shell's DOM
 * leaves no trace otherwise.
 */
async function openPlayers(players) {
  const url = createTestPage(server, {
    videoSrc: createTestMedia(server, MEDIA_SECONDS),
    players
  });
  await driver.navigate(url);
  await driver.injectScript();

  const deadline = Date.now() + 20000;
  let shells = 0;
  while (Date.now() < deadline) {
    shells = await driver.eval(() => document.querySelectorAll(".pf-shell").length);
    if (shells === players) {
      break;
    }
    await sleep(100);
  }
  assert.equal(shells, players, `all ${players} players get a shell`);

  // The hotkey handler reads readyState through the native accessor from the
  // userscript realm, so the media has to be real and loaded.
  const ready = await driver.eval((_n) => {
    window.__vids = [...document.querySelectorAll(".plyr")].map((p) => p.querySelector("video"));
    window.__log = window.__log || [];
    window.__vids.forEach((video, i) => {
      const host = video.closest(".plyr").querySelector(".pf-shell") || video.closest(".plyr");
      host.addEventListener("pf:gesture-mute", () => window.__log.push(i));
    });
    return window.__vids.map((v) => v.readyState);
  }, players);
  assert.ok(ready.every((r) => r > 0), `every player has loaded media (got ${JSON.stringify(ready)})`);

  // Let the last shell's panel attach: the keydown broker is installed when the
  // first engine registers, but a gesture is only dispatched once the owning
  // shell is fully wired.
  await sleep(1500);
}

const keyM = () => driver.eval(() => {
  document.dispatchEvent(new KeyboardEvent("keydown", {
    key: "m", code: "KeyM", bubbles: true, cancelable: true
  }));
});

const owners = () => driver.eval(() => [...(window.__log || [])]);

test("a fresh multi-player page has exactly one key owner, not none", async () => {
  await openPlayers(3);

  // No pointerdown, no focus change: exactly the state that used to be dead.
  await keyM();
  await sleep(600);

  const seen = await owners();
  assert.equal(seen.length, 1, `one keystroke must reach exactly one player, saw ${JSON.stringify(seen)}`);
});

test("a second keystroke keeps going to the same owner, never doubling up", async () => {
  await openPlayers(2);

  await keyM();
  await sleep(500);
  await keyM();
  await sleep(500);

  const seen = await owners();
  assert.equal(seen.length, 2, "two keystrokes, two gestures");
  assert.equal(seen[0], seen[1], `both must land on the same player, saw ${JSON.stringify(seen)}`);
});

test("the playing player outranks an idle sibling", async () => {
  await openPlayers(2);
  // Autoplay policy rejects unmuted playback here, so mute first. The
  // assertion is about which shell answers the key, not about the mute itself.
  const playing = await driver.eval(() => {
    const video = window.__vids[1];
    video.muted = true;
    return video.play().then(() => !video.paused).catch(() => false);
  });
  assert.equal(playing, true, "the second player must really be playing, or this proves nothing");
  await sleep(400);

  await keyM();
  await sleep(600);

  const seen = await owners();
  assert.deepEqual(seen, [1], `the in-motion player should answer, saw ${JSON.stringify(seen)}`);
});

test("focus inside a player outranks a playing sibling", async () => {
  await openPlayers(2);
  const playing = await driver.eval(() => {
    const video = window.__vids[0];
    video.muted = true;
    return video.play().then(() => !video.paused).catch(() => false);
  });
  assert.equal(playing, true, "the first player must really be playing, or this proves nothing");
  // Scroll the target into view explicitly: boot used to focus the host
  // with a bare focus(), whose scroll side effect left the second player
  // visible, and this test silently depended on it. Parked focus is now
  // preventScroll, so a below-fold player stays occluded - and an occluded
  // shell is detached (display:none), in which focusing the probe is a
  // silent no-op that hands the keystroke to the playing sibling instead.
  await driver.eval(() => {
    document.querySelectorAll(".plyr")[1].scrollIntoView();
  });
  // Let the intersection crossing resolve through the occlusion gate before
  // focusing: the focus below must land in a rendered tree, not a detached
  // one, or it no-ops and the assertion after blames the broker.
  await sleep(600);
  await driver.eval(() => {
    // A non-interactive holder. It has to go INSIDE the shell's shadow root:
    // isInsideShell() tests shadow containment, so a light-DOM child of the
    // host is not "inside" the shell and would not count as focus at all.
    const host = document.querySelectorAll(".plyr")[1].querySelector(".pf-shell");
    const focusable = document.createElement("div");
    focusable.setAttribute("tabindex", "-1");
    focusable.id = "pf-focus-probe";
    host.shadowRoot.appendChild(focusable);
    focusable.focus();
  });
  await sleep(400);

  // Loud precondition: if the probe never took focus (still occluded,
  // detached, unrendered), the assertion below would blame the broker for a
  // focus that never happened. Note document.activeElement can never name a
  // shadow-interior node - it retargets to the host - so the read goes
  // through the shadow root itself.
  const focused = await driver.eval(
    () => document.querySelectorAll(".plyr")[1].querySelector(".pf-shell")
      .shadowRoot.activeElement?.id
  );
  assert.equal(focused, "pf-focus-probe", "the probe holds focus before the keystroke");

  await keyM();
  await sleep(600);

  const seen = await owners();
  assert.deepEqual(seen, [1], `the focused player should answer, saw ${JSON.stringify(seen)}`);
});

test("removing the key owner hands the keyboard to the survivor", async () => {
  await openPlayers(2);
  await keyM();
  await sleep(500);
  const first = await owners();
  assert.equal(first.length, 1, "one owner before removal");

  await driver.eval((idx) => window.__vids[idx].remove(), first[0]);
  // The kernel's removal grace plus watcher settle.
  await sleep(2500);

  await keyM();
  await sleep(600);
  const seen = await owners();
  assert.equal(seen.length, 2, "the survivor must answer the next keystroke");
  assert.notEqual(seen[1], first[0], `a removed player must never answer again, saw ${JSON.stringify(seen)}`);
});

test("a page-level key handler still never sees an owned press", async () => {
  await openPlayers(2);
  await driver.eval(() => {
    window.__pageSaw = [];
    // Bubble phase, registered after the broker's capture listener, so the
    // broker's stopImmediatePropagation is what keeps this quiet.
    document.addEventListener("keydown", (e) => window.__pageSaw.push(e.code));
  });

  await keyM();
  await sleep(600);

  const seen = await owners();
  assert.equal(seen.length, 1, "the press was claimed");
  const pageSaw = await driver.eval(() => window.__pageSaw);
  assert.deepEqual(pageSaw, [], "page handlers must not observe a claimed keypress");
});

test("tearing the last player down leaves no key owner behind", async () => {
  await openPlayers(1);
  await keyM();
  await sleep(500);
  assert.equal((await owners()).length, 1, "one owner while live");

  await driver.eval(() => window.__vids[0].remove());
  await sleep(2500);

  await keyM();
  await sleep(600);
  assert.equal((await owners()).length, 1, "a torn-down broker must claim nothing further");
});

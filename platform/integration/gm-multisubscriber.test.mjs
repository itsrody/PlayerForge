/**
 * The GM value-change listener table, in a real Firefox 157 instance.
 *
 * This exists because a whole class of bug was invisible here. Every
 * two-shell test in the suite put its players in SEPARATE frames, and each frame
 * gets its own userScript realm with its own GM listener table - so their
 * subscriptions could never collide. Two shells in ONE document share a realm
 * and therefore share a table on pf:resume, which is the only arrangement where
 * a listener table that holds one callback per key does any damage: the second
 * registration silently displaces the first and that subscriber's cross-tab
 * resume feed goes dead, with no test failing.
 *
 * Two things had to be true for this to be testable at all, and neither was:
 *
 *  1. The harness's delivery loop was dead code. readPrivileged() used to merge
 *     the fresh privileged snapshot into STORAGE, and pump() then compared
 *     fresh[key] against STORAGE[key] - two values sync() had just made
 *     identical. Object.is was always true, the loop always continued, and
 *     GM_addValueChangeListener never delivered anything at all.
 *  2. The store could not be written while a document was live. The seed path
 *     only runs before a document loads, so "another tab saved a new position"
 *     had no way to happen.
 *
 * The COUNT asserted here changed, deliberately. There is now one ResumeStore
 * per document rather than one per player, so two players register once between
 * them. That is the point of the change, so it is worth pinning: a regression
 * that handed every player its own store again would double the subscriptions
 * and re-open the divergent-copies bug where one player's History delete came
 * back from another player's copy. But it leaves PlayerForge registering a
 * single callback on this key, and under a per-key table nothing could collide
 * with anything - so the last test arms a harness-owned second registration (the
 * canary in api-gm.js) and keeps the fan-out itself covered.
 *
 * Delivery happens in the userScript realm, which WebDriver cannot observe, so
 * the GM-layer assertions are made against what it reports over PF_report: how
 * many registrations PlayerForge made on the key, and how many a single remote
 * write notified. The user-visible half - that BOTH players' History lists
 * actually show a row written by another tab - is asserted through the panel
 * DOM, which the page world can see.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { FirefoxDriver, TestServer, createTestPage, createTestMedia } from "../harness/firefox.mjs";
import { waitForShell } from "../harness/page.mjs";

const RESUME_KEY = "pf:resume";
const MEDIA_SECONDS = 90;

let driver;
let server;
let events;

test.before(async () => {
  server = new TestServer();
  await server.start();
  driver = await FirefoxDriver.launch();
  events = [];
  driver.onNativeDiagnostic((payload) => events.push(payload));
});

test.after(async () => {
  await driver?.destroy();
  await server?.stop();
});

/** The GM-layer reports seen so far, newest last. */
const gm = (ev) => events.filter((e) => e && e.ev === ev);

test.beforeEach(() => {
  // One document per test, and with it one fresh registration list, so counts
  // are per-test. Assertions read the LAST matching report rather than the
  // first: a store that writes back what it just adopted can produce an
  // extra delivery inside the polling window.
  events.length = 0;
});

/** Registrations PlayerForge made on the resume key. */
const resumeRegisters = () => gm("gm:register").filter((e) => e.key === RESUME_KEY);
/** Deliveries for the resume key. */
const resumeDelivers = () => gm("gm:deliver").filter((e) => e.key === RESUME_KEY);

/**
 * players: 2 puts two independently-anchored Plyr players in ONE document, so
 * one realm and one listener table - the arrangement that makes a
 * one-callback-per-key table destructive.
 */
async function openTwoPlayers() {
  const url = createTestPage(server, {
    videoSrc: createTestMedia(server, MEDIA_SECONDS),
    players: 2,
  });
  await driver.navigate(url);
  await driver.injectScript();
  await waitForShell(driver, 8000);

  // Registration is reported from inside the realm, so poll the reports rather
  // than sleeping a fixed amount.
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && resumeRegisters().length < 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  // Both shells must exist before "one subscription covers them" means anything.
  const shellCount = await driver.eval(() => document.querySelectorAll(".pf-shell").length);
  assert.equal(shellCount, 2, "both Plyr-anchored videos in one document get a shell");
  await new Promise((r) => setTimeout(r, 1000));
}

test("two players in one document share ONE pf:resume subscription", async () => {
  await openTwoPlayers();

  const registered = resumeRegisters();
  assert.equal(
    registered.length,
    1,
    `one document means one resume store, so one subscription, got ${JSON.stringify(registered)}`
  );
  // `total` is the table's depth at the moment of registration, so requiring it
  // to be 1 pins that nothing else was already holding this key - the arrangement
  // under which a one-per-key table displaces silently.
  assert.equal(
    registered[0].total,
    1,
    `the key holds exactly this one registration, got table depth ${registered[0].total}`
  );
});

test("one cross-context write is delivered once and reaches every player's History", async () => {
  await openTwoPlayers();
  const current = (await driver.gmStorage())[RESUME_KEY] ?? { version: 1, entries: [] };
  const deliveredBefore = resumeDelivers().length;

  const now = Date.now();
  const moved = {
    version: 1,
    entries: [
      {
        id: "remote-entry-1",
        domain: "127-0-0-1",
        path: "/remote",
        title: "Remote Page",
        duration: MEDIA_SECONDS,
        resume: 33,
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
  await driver.gmRemoteWrite({ [RESUME_KEY]: moved });

  const settle = Date.now() + 10000;
  while (Date.now() < settle && resumeDelivers().length <= deliveredBefore) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const delivered = resumeDelivers();
  assert.equal(
    delivered.length,
    deliveredBefore + 1,
    "one remote write is delivered once, not once per subscriber"
  );
  assert.equal(delivered[delivered.length - 1].notified, 1, "one registration hears it");
  assert.equal(delivered[delivered.length - 1].remote, true, "a cross-context write reports remote === true");

  // The delivered value is the one written, not a re-read of the realm's cache.
  const after = (await driver.gmStorage())[RESUME_KEY];
  assert.equal(after.entries.length, 1, "the remote value is what the store holds");
  assert.equal(after.entries[0].id, "remote-entry-1", "the remote entry is the one delivered");
  assert.ok(current, "the pre-write value was readable, so the write was a real change");

  // The part a user would actually notice: BOTH players' History lists show the
  // row another tab wrote. With one store per player this could not hold - the
  // second player's list was rendered from its own copy of the data.
  for (const index of [0, 1]) {
    const titles = await driver.eval(async (i) => {
      const host = document.querySelectorAll(".pf-shell")[i];
      host.dispatchEvent(new CustomEvent("pf:gesture-panel", { detail: { method: "test" } }));
      await new Promise((r) => setTimeout(r, 1500));
      const tab = [...host.shadowRoot.querySelectorAll(".pf-panel-tab[data-title]")].find(
        (t) => t.dataset.title === "History"
      );
      if (!tab) {
        return { error: "no history tab" };
      }
      tab.click();
      await new Promise((r) => setTimeout(r, 700));
      return {
        titles: [...host.shadowRoot.querySelectorAll(".pf-history-card")]
          .map((c) => c.querySelector(".pf-history-title")?.textContent)
          .filter(Boolean),
      };
    }, index);
    assert.ok(
      titles.titles?.includes("Remote Page"),
      `player ${index + 1}'s History must list the row another tab wrote, saw ${JSON.stringify(titles)}`
    );
  }
});

test("an unchanged store is not re-delivered", async () => {
  // The privileged snapshot comes back as a freshly structured-cloned object on
  // every poll, so identity is never equal for object values. Without a content
  // comparison this fires every 100ms forever and drives PF's resume and config
  // watchers in a loop - a harness that manufactures changes is worse than one
  // that delivers none, because it looks like it is working.
  await openTwoPlayers();
  const before = resumeDelivers().length;

  // A different key, so the write is real but pf:resume is untouched.
  await driver.gmRemoteWrite({ "pf:unrelated-probe": { touched: true } });
  await new Promise((r) => setTimeout(r, 1500));

  assert.equal(resumeDelivers().length, before, "an untouched key delivers nothing further");
});

test("a remote delete arrives as undefined rather than being ignored", async () => {
  // A key removed by another context must reach listeners as undefined.
  // Silently skipping it would leave a subscriber convinced its resume data
  // still exists.
  await openTwoPlayers();
  const deliveredBefore = resumeDelivers().length;
  await driver.gmRemoteWrite({ [RESUME_KEY]: { version: 1, entries: [] } });
  const settle = Date.now() + 10000;
  while (Date.now() < settle && resumeDelivers().length <= deliveredBefore) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(resumeDelivers().length > deliveredBefore, "the follow-up write was delivered");

  const deleteBefore = resumeDelivers().length;
  await driver.gmRemoteDelete(RESUME_KEY);
  const deleteSettle = Date.now() + 10000;
  while (Date.now() < deleteSettle && resumeDelivers().length <= deleteBefore) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const deletes = resumeDelivers();
  assert.equal(
    deletes.length,
    deleteBefore + 1,
    "a removed key is delivered, not treated as no change"
  );
  assert.equal(deletes[deletes.length - 1].notified, 1, "the registration hears the delete");
});

test("the table still delivers to TWO registrations on one key (harness canary)", async () => {
  // The regression this file was written against: a table holding one callback
  // per key, where a second registration displaces the first. PlayerForge now
  // registers once on pf:resume, so nothing under test can collide with
  // anything - the canary supplies the second registration, and if the table
  // ever goes back to one-per-key it would take PlayerForge's place and both the
  // notified count and the canary's own delivery would fail.
  await openTwoPlayers();
  await driver.eval((key) => {
    document.dispatchEvent(new CustomEvent("pf-harness-canary", { detail: { key } }));
  }, RESUME_KEY);

  const armed = Date.now() + 5000;
  while (Date.now() < armed && gm("gm:canary-armed").length < 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const canary = gm("gm:canary-armed");
  assert.equal(canary.length, 1, "the canary registered");
  assert.equal(
    canary[0].total,
    2,
    `both registrations are live at once, got table depth ${canary[0].total}`
  );

  const deliveredBefore = resumeDelivers().length;
  const now = Date.now();
  await driver.gmRemoteWrite({
    [RESUME_KEY]: {
      version: 1,
      entries: [
        {
          id: "fanout-entry",
          domain: "127-0-0-1",
          path: "/f",
          title: "F",
          duration: MEDIA_SECONDS,
          resume: 1,
          createdAt: now,
          updatedAt: now,
        },
      ],
    },
  });

  const settle = Date.now() + 10000;
  while (Date.now() < settle && resumeDelivers().length <= deliveredBefore) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const delivered = resumeDelivers();
  assert.equal(delivered.length, deliveredBefore + 1, "one write, one delivery");
  assert.equal(delivered[delivered.length - 1].notified, 2, "and BOTH registrations hear it");
  assert.equal(gm("gm:canary").length, 1, "the canary's own callback ran");
});

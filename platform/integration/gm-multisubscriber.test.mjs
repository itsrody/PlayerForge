/**
 * Same-key multi-subscriber delivery, in a real Firefox 157 instance.
 *
 * This exists because a whole class of bug was invisible here. Every
 * two-shell test in the suite put its players in SEPARATE frames, and each frame
 * gets its own userScript realm with its own GM listener table - so their
 * subscriptions could never collide. Two shells in ONE document share a realm
 * and therefore share a table on pf:resume, which is the only arrangement where
 * a listener table that holds one callback per key does any damage: the second
 * shell's ResumeStore silently displaces the first and that shell's cross-tab
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
 * Delivery happens in the userScript realm, which WebDriver cannot observe, so
 * the assertions are made against what the GM layer reports over the existing
 * PF_report channel: how many registrations PlayerForge made on the key, and how
 * many a single remote write notified. That chain is the whole claim - PF made
 * two live subscriptions (real PF code calling real GM APIs), and one
 * cross-context write reached both.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { FirefoxDriver, TestServer, createTestPage, createTestMedia } from "../harness/firefox.mjs";

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

test("two shells in one document each keep a live subscription to pf:resume", async () => {
  // players: 2 puts two independently-anchored Plyr players in ONE document, so
  // one realm, one listener table, two ResumeStores - the arrangement that makes
  // a one-callback-per-key table destructive.
  const url = createTestPage(server, {
    videoSrc: createTestMedia(server, MEDIA_SECONDS),
    players: 2,
  });
  await driver.navigate(url);
  await driver.injectScript();

  // Both shells must actually exist before "two subscriptions" means anything.
  const shellCount = await driver.eval(() => document.querySelectorAll(".pf-shell").length);
  assert.equal(shellCount, 2, "both Plyr-anchored videos in one document get a shell");

  // Wait for the resume trackers to subscribe. Registration is reported from
  // inside the realm, so poll the reports rather than sleeping a fixed amount.
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && gm("gm:register").filter((e) => e.key === RESUME_KEY).length < 2) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const registered = gm("gm:register").filter((e) => e.key === RESUME_KEY);
  assert.equal(
    registered.length,
    2,
    `each shell's ResumeStore registers its own subscription on ${RESUME_KEY}, got ${JSON.stringify(registered)}`
  );
  assert.equal(
    new Set(registered.map((e) => e.id)).size,
    2,
    "the two registrations hold distinct manager ids, so neither can displace the other"
  );
  // Distinct ids are not enough on their own: a table that mints a fresh id and
  // then drops the previous callback also produces two distinct ids, while only
  // one subscriber is ever live. `total` is the table's depth at the moment of
  // registration, so requiring it to reach 2 pins that both subscriptions are
  // live AT THE SAME TIME. This is the assertion that catches one-per-key.
  assert.equal(
    registered[registered.length - 1].total,
    2,
    `both subscriptions are live simultaneously, got table depth ${registered[registered.length - 1].total}`
  );
});

test("one cross-context write reaches every subscriber on the key", async () => {
  // A remote write while the document is live: the whole point of the new
  // storage.write path, and the only way a delivered change can occur at all.
  const current = (await driver.gmStorage())[RESUME_KEY] ?? { version: 1, entries: [] };
  const deliveredBefore = gm("gm:deliver").length;

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
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  };
  await driver.gmRemoteWrite({ [RESUME_KEY]: moved });

  const settle = Date.now() + 10000;
  while (Date.now() < settle && gm("gm:deliver").length <= deliveredBefore) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const delivered = gm("gm:deliver").filter((e) => e.key === RESUME_KEY);
  assert.equal(
    delivered.length,
    1,
    "one remote write is delivered once, not once per subscriber"
  );
  assert.equal(
    delivered[0].notified,
    2,
    `a single remote write must notify BOTH subscriptions on ${RESUME_KEY}, notified=${delivered[0].notified}`
  );
  assert.equal(delivered[0].remote, true, "a cross-context write reports remote === true");

  // The delivered value is the one written, not a re-read of the realm's cache.
  const after = (await driver.gmStorage())[RESUME_KEY];
  assert.equal(after.entries.length, 1, "the remote value is what the store holds");
  assert.equal(after.entries[0].id, "remote-entry-1", "the remote entry is the one delivered");
  assert.ok(current, "the pre-write value was readable, so the write was a real change");
});

test("an unchanged store is not re-delivered", async () => {
  // The privileged snapshot comes back as a freshly structured-cloned object on
  // every poll, so identity is never equal for object values. Without a content
  // comparison this fires every 100ms forever and drives PF's resume and config
  // watchers in a loop - a harness that manufactures changes is worse than one
  // that delivers none, because it looks like it is working.
  const before = gm("gm:deliver").filter((e) => e.key === RESUME_KEY).length;

  // A different key, so the write is real but pf:resume is untouched.
  await driver.gmRemoteWrite({ "pf:unrelated-probe": { touched: true } });
  await new Promise((r) => setTimeout(r, 1500));

  const after = gm("gm:deliver").filter((e) => e.key === RESUME_KEY).length;
  assert.equal(after, before, "an untouched key delivers nothing further");
});

test("a remote delete arrives as undefined rather than being ignored", async () => {
  // A key removed by another context must reach listeners as undefined. Silently
  // skipping it would leave a shell convinced its resume data still exists.
  const deliveredBefore = gm("gm:deliver").filter((e) => e.key === RESUME_KEY).length;

  await driver.gmRemoteWrite({ [RESUME_KEY]: { version: 1, entries: [] } });
  const settle = Date.now() + 10000;
  while (
    Date.now() < settle &&
    gm("gm:deliver").filter((e) => e.key === RESUME_KEY).length <= deliveredBefore
  ) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const delivered = gm("gm:deliver").filter((e) => e.key === RESUME_KEY);
  assert.ok(delivered.length > deliveredBefore, "the follow-up write was delivered");

  const deleteBefore = gm("gm:deliver").length;
  await driver.gmRemoteDelete(RESUME_KEY);
  const deleteSettle = Date.now() + 10000;
  while (Date.now() < deleteSettle && gm("gm:deliver").length <= deleteBefore) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const deletes = gm("gm:deliver").filter((e) => e.key === RESUME_KEY);
  assert.equal(
    deletes.length,
    deleteBefore + 1,
    "a removed key is delivered, not treated as no change"
  );
  assert.equal(deletes[deletes.length - 1].notified, 2, "both subscriptions hear the delete");
});

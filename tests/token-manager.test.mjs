import test from "node:test";
import assert from "node:assert/strict";
import { TOKEN_STATE, TokenManager } from "../src/shell/proxy/token-manager.js";

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function makeManager({ getToken = null, ...options } = {}) {
  const log = { now: 0, scheduled: [], requests: 0 };
  const scheduler = (fn, delay) => { log.scheduled.push({ fn, delay }); };
  const clock = () => log.now;
  const defaultGetToken = async () => ({
    token: `T${++log.requests}`,
    expires: (log.now + 10000) / 1000
  });
  const manager = new TokenManager({
    getToken: getToken ?? defaultGetToken,
    clock,
    scheduler,
    ...options
  });
  const events = [];
  manager.onChange((e) => events.push(e));
  const fireNext = (advance) => {
    const job = log.scheduled.shift();
    log.now += advance ?? job.delay;
    job.fn();
    return job;
  };
  return { manager, log, events, fireNext };
}

const states = (events) => events.filter((e) => e.type === "state").map((e) => e.to);

test("proactive refresh fires mid-TTL and re-arms with the fresh token", async () => {
  const { manager, log, events, fireNext } = makeManager();
  const armed = await manager.arm();
  assert.equal(armed.refreshed, true);
  assert.equal(manager.state, TOKEN_STATE.ARMED);
  assert.equal(manager.token.value, "T1");
  assert.equal(log.scheduled.length, 1);
  assert.equal(log.scheduled[0].delay, 5000, "fires at expiresAt - max(2s, ttl/2)");

  fireNext();
  await flush();
  assert.equal(log.requests, 2);
  assert.equal(manager.token.value, "T2");
  assert.equal(manager.state, TOKEN_STATE.ARMED);
  assert.equal(log.scheduled.length, 1, "re-armed with a fresh proactive timer");
  assert.deepEqual(states(events), ["refreshing", "armed", "refreshing", "armed"]);
});

test("reactive 403 consumes any in-flight refresh; non-token statuses pass through", async () => {
  const { manager, events } = makeManager();
  await manager.arm();
  assert.deepEqual(await manager.handleStatus(404), { refreshed: false, reason: "not-token-error" });
  const out = await manager.handleStatus(403);
  assert.equal(out.refreshed, true);
  assert.equal(manager.token.value, "T2");
  assert.ok(events.some((e) => e.type === "refresh" && e.ok && e.reactive === true));
});

test("403 during an in-flight refresh shares it instead of firing a second API call", async () => {
  const gate = deferred();
  const getToken = () => gate.promise;
  const { manager } = makeManager({ getToken });
  const arm = manager.arm();
  assert.equal(manager.state, TOKEN_STATE.REFRESHING);
  const reactive = manager.handleStatus(403);
  gate.resolve({ token: "T1", expires: 10 });
  const [armedOut, reactiveOut] = await Promise.all([arm, reactive]);
  assert.equal(armedOut.refreshed, true);
  assert.equal(reactiveOut.refreshed, true);
  assert.equal(manager.token.value, "T1");
});

test("URL rewrite applies the live token on every request and stays byte-stable", async () => {
  const { manager } = makeManager();
  await manager.arm();
  assert.equal(manager.rewriteUrl("https://x/seg.ts?codec=1"), "https://x/seg.ts?codec=1&md5=T1&expires=10");
  assert.equal(
    manager.rewriteUrl("https://x/{token}/{expires}/seg.ts"),
    "https://x/T1/10/seg.ts",
    "path placeholders win over the query form"
  );
  const again = manager.rewriteUrl("https://x/seg.ts?codec=1");
  assert.equal(again, "https://x/seg.ts?codec=1&md5=T1&expires=10", "no-op rewrite stays byte-identical");

  await manager.handleStatus(403);
  assert.equal(manager.rewriteUrl("https://x/seg.ts"), "https://x/seg.ts?md5=T2&expires=10", "refreshed credential now rewrites");
});

test("rewriteUrl is inert outside ARMED (stale token can never escape)", () => {
  const { manager } = makeManager();
  assert.equal(manager.rewriteUrl("https://x/seg.ts?md5=old"), "https://x/seg.ts?md5=old", "idle leaves URLs alone");
});

test("refresh-API failures back off exponentially, then a success re-arms", async () => {
  let calls = 0;
  const getToken = async () => {
    calls++;
    if (calls < 3) {
      throw new Error("token api 503");
    }
    return { token: "T3", expires: 10 };
  };
  const { manager, log, events, fireNext } = makeManager({ getToken });
  const first = await manager.arm();
  assert.deepEqual(first, { refreshed: false, token: null, reason: "provider-error" });
  assert.equal(manager.state, TOKEN_STATE.FAILED);
  assert.deepEqual(log.scheduled.map((s) => s.delay), [1000], "attempt 1 backoff");

  fireNext();
  await flush();
  assert.equal(calls, 2);
  assert.equal(manager.state, TOKEN_STATE.FAILED);
  assert.deepEqual(log.scheduled.map((s) => s.delay), [2000], "attempt 2 doubles the wait");

  fireNext();
  await flush();
  assert.equal(calls, 3);
  assert.equal(manager.state, TOKEN_STATE.ARMED);
  assert.equal(manager.token.value, "T3");
  assert.ok(events.some((e) => e.type === "refresh" && e.ok));
});

test("maxAttempts stops the auto-retry loop and degrades (manual kick still allowed)", async () => {
  const getToken = async () => { throw new Error("down"); };
  const { manager, log } = makeManager({ getToken, maxAttempts: 2 });
  await manager.arm();
  const fireNext = () => {
    const job = log.scheduled.shift();
    log.now += job.delay;
    job.fn();
  };
  fireNext();
  await flush();
  assert.equal(manager.state, TOKEN_STATE.FAILED);
  assert.equal(log.scheduled.length, 0, "exhausted: no further auto retries");
  assert.equal(manager.rewriteUrl("https://x/seg.ts?md5=stale"), "https://x/seg.ts?md5=stale", "degraded URLs are untouched");
});

test("destroy clears the timer, drops the credential, and aborts an in-flight refresh", async () => {
  const getToken = (signal) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  const { manager, log } = makeManager({ getToken });
  const arm = manager.arm();
  assert.equal(manager.state, TOKEN_STATE.REFRESHING);
  manager.destroy();
  const out = await arm;
  assert.deepEqual(out, { refreshed: false, token: null, reason: "aborted" });
  assert.equal(manager.state, TOKEN_STATE.IDLE);
  assert.equal(manager.token, null);
  assert.equal(log.scheduled.length, 0, "no stray timers after teardown");
});

test("destroy is idempotent and kills a previously-armed manager", async () => {
  const { manager } = makeManager();
  await manager.arm();
  manager.destroy();
  manager.destroy();
  assert.equal(manager.state, TOKEN_STATE.IDLE);
  assert.equal(manager.armed, false);
  assert.deepEqual(await manager.arm(), { refreshed: false, reason: "aborted" }, "post-teardown arm refuses");
});

test("IP-bound and cookie variants are honored; a passive manager does nothing", async () => {
  const ipGetToken = async () => ({
    token: "T",
    token_ip: "TIP",
    client_ip: "1.2.3.4",
    cookie: "sid=abc",
    expires: 10
  });
  const { manager } = makeManager({ getToken: ipGetToken });
  await manager.arm();
  assert.equal(manager.token.value, "TIP", "bound token wins");
  assert.equal(manager.token.ip, "TIP");
  assert.equal(manager.token.clientIp, "1.2.3.4");
  assert.equal(manager.token.cookie, "sid=abc");
  assert.equal(manager.rewriteUrl("https://x/seg.ts"), "https://x/seg.ts?md5=TIP&expires=10");

  const passive = new TokenManager({ clock: () => 0, scheduler: () => {} });
  assert.equal(passive.state, TOKEN_STATE.IDLE);
  assert.deepEqual(await passive.arm(), { refreshed: false, reason: "no-provider" });
  assert.equal(passive.state, TOKEN_STATE.IDLE, "no provider -> stays passive");
});

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
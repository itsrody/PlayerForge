// ==UserScript==
// @name         PlayerForge (Helium / Titanium)
// @namespace    https://github.com/PlayerForge
// @version      0.7.2
// @description  Helium Browser (desktop) and Titanium Browser (Android), Chromium 153+ / Tampermonkey 5.5+ (MV3) exclusive HTML5 video player enhancer with gestures, hotkeys, progress resume, subtitles, and an extensible plugin system
// @author       PlayerForge
// @icon         data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMDAiIGhlaWdodD0iMjAwIiB2aWV3Qm94PSIwIDAgNDggNDgiPjxnIGZpbGw9Im5vbmUiPjxwYXRoIGZpbGw9InVybCgjZmx1ZW50Q29sb3JWaWRlbzQ4MCkiIGQ9Im0yMi41IDI0bDE2LjIzMy0xMS4zMjVjMi4yMjEtMS41NSA1LjI2Ny4wNCA1LjI2NyAyLjc0N3YxNy4xNTZjMCAyLjcwOC0zLjA0NiA0LjI5Ny01LjI2NyAyLjc0N3oiLz48cGF0aCBmaWxsPSJ1cmwoI2ZsdWVudENvbG9yVmlkZW80ODIpIiBmaWxsLW9wYWNpdHk9Ii43NSIgZD0ibTIyLjUgMjRsMTYuMjMzLTExLjMyNWMyLjIyMS0xLjU1IDUuMjY3LjA0IDUuMjY3IDIuNzQ3djE3LjE1NmMwIDIuNzA4LTMuMDQ2IDQuMjk3LTUuMjY3IDIuNzQ3eiIvPjxwYXRoIGZpbGw9InVybCgjZmx1ZW50Q29sb3JWaWRlbzQ4MSkiIGQ9Ik00IDE2LjI1QTYuMjUgNi4yNSAwIDAgMSAxMC4yNSAxMGgxNC41QTYuMjUgNi4yNSAwIDAgMSAzMSAxNi4yNXYxNS41QTYuMjUgNi4yNSAwIDAgMSAyNC43NSAzOGgtMTQuNUE2LjI1IDYuMjUgMCAwIDEgNCAzMS43NXoiLz48cGF0aCBmaWxsPSJ1cmwoI2ZsdWVudENvbG9yVmlkZW80ODMpIiBkPSJNOCAzMGE0IDQgMCAwIDEgNC00aDEwYTQgNCAwIDAgMSAwIDhIMTJhNCA0IDAgMCAxLTQtNCIgb3BhY2l0eT0iLjUiLz48cGF0aCBmaWxsPSIjQkFCQUZGIiBkPSJNMTIuMDI2IDI4QzEwLjkwNyAyOCAxMCAyOC45MjIgMTAgMzAuMDU5cy45MDcgMi4wNTkgMi4wMjYgMi4wNTloNC4wNTFjMS4xMTkgMCAyLjAyNi0uOTIyIDIuMDI2LTIuMDZjMC0xLjEzNi0uOTA3LTIuMDU4LTIuMDI2LTIuMDU4em05Ljk0OCA0LjExOGMxLjEyIDAgMi4wMjYtLjkyMiAyLjAyNi0yLjA2QzI0IDI4LjkyMyAyMy4wOTMgMjggMjEuOTc0IDI4cy0yLjAyNS45MjItMi4wMjUgMi4wNTlzLjkwNiAyLjA1OSAyLjAyNSAyLjA1OSIvPjxkZWZzPjxyYWRpYWxHcmFkaWVudCBpZD0iZmx1ZW50Q29sb3JWaWRlbzQ4MCIgY3g9IjAiIGN5PSIwIiByPSIxIiBncmFkaWVudFRyYW5zZm9ybT0icm90YXRlKDcxLjg1IDEwLjg3IDI3LjUyMylzY2FsZSgzMy4yNjgzIDY1LjY0MzEpIiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+PHN0b3Agb2Zmc2V0PSIuMDgxIiBzdG9wLWNvbG9yPSIjRjA4QUY0Ii8+PHN0b3Agb2Zmc2V0PSIuMzk0IiBzdG9wLWNvbG9yPSIjOUM2Q0ZFIi8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjNEU0NERCIi8+PC9yYWRpYWxHcmFkaWVudD48cmFkaWFsR3JhZGllbnQgaWQ9ImZsdWVudENvbG9yVmlkZW80ODEiIGN4PSIwIiBjeT0iMCIgcj0iMSIgZ3JhZGllbnRUcmFuc2Zvcm09Im1hdHJpeCgzMS4wNjQ4MSAyOS42MzMzMiAtNjIuMTk2MjMgNjUuMjAwNzMgLS45MDggMTEuMTY3KSIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPjxzdG9wIHN0b3AtY29sb3I9IiNGMDhBRjQiLz48c3RvcCBvZmZzZXQ9Ii4zNDEiIHN0b3AtY29sb3I9IiM5QzZDRkUiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiM0RTQ0REIiLz48L3JhZGlhbEdyYWRpZW50PjxsaW5lYXJHcmFkaWVudCBpZD0iZmx1ZW50Q29sb3JWaWRlbzQ4MiIgeDE9IjI3LjUzNCIgeDI9IjQzLjk3OSIgeTE9IjI0IiB5Mj0iMjMuNDE0IiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+PHN0b3Agc3RvcC1jb2xvcj0iIzMxMkE5QSIvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzMxMkE5QSIgc3RvcC1vcGFjaXR5PSIwIi8+PC9saW5lYXJHcmFkaWVudD48bGluZWFyR3JhZGllbnQgaWQ9ImZsdWVudENvbG9yVmlkZW80ODMiIHgxPSI3LjU5MSIgeDI9IjEwLjMwOCIgeTE9IjI2IiB5Mj0iMzYuNjg4IiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+PHN0b3Agc3RvcC1jb2xvcj0iIzNCMTQ4QSIvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzRCMjBBMCIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPjwvZz48L3N2Zz4=
// @match        *://*/*
// @exclude      *://*.youtube.com/*
// @exclude      *://youtube.com/*
// @exclude      *://youtu.be/*
// @exclude      *://*.vimeo.com/*
// @exclude      *://vimeo.com/*
// @exclude      *://player.vimeo.com/*
// @exclude      *://*.netflix.com/*
// @exclude      *://netflix.com/*
// @exclude      *://*.disneyplus.com/*
// @exclude      *://disneyplus.com/*
// @exclude      *://*.primevideo.com/*
// @exclude      *://primevideo.com/*
// @exclude      *://*.hulu.com/*
// @exclude      *://hulu.com/*
// @exclude      *://*.max.com/*
// @exclude      *://*.hbomax.com/*
// @exclude      *://tv.apple.com/*
// @exclude      *://*.peacocktv.com/*
// @exclude      *://*.paramountplus.com/*
// @exclude      *://*.crunchyroll.com/*
// @exclude      *://*.bilibili.com/*
// @exclude      *://bilibili.com/*
// @exclude      *://*.dailymotion.com/*
// @exclude      *://dailymotion.com/*
// @exclude      *://*.twitch.tv/*
// @exclude      *://twitch.tv/*
// @exclude      *://*.facebook.com/*
// @exclude      *://facebook.com/*
// @exclude      *://fb.watch/*
// @exclude      *://*.x.com/*
// @exclude      *://*.twitter.com/*
// @exclude      *://*.instagram.com/*
// @exclude      *://instagram.com/*
// @exclude      *://*.tiktok.com/*
// @exclude      *://tiktok.com/*
// @exclude      *://*.reddit.com/*
// @exclude      *://reddit.com/*
// @exclude      *://*.tumblr.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_getResourceText
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      https://www.subtitlecat.com
// @resource     pfStyle https://raw.githubusercontent.com/itsrody/PlayerForge/chromium/dist/playerforge.css
// @sandbox      raw
// @run-at       document-start
// @license      MIT
// ==/UserScript==

(() => {
  // src/shared/logger.js
  var PREFIX = "[PlayerForge]";
  var STYLES = {
    kernel: "color: #FF6B35; font-weight: bold",
    shell: "color: #4ECDC4; font-weight: bold",
    warn: "color: #F38181; font-weight: bold",
    error: "color: #AA0000; font-weight: bold"
  };
  var enabled = false;
  function styleFor(channel) {
    return STYLES[channel] || "";
  }
  function log(channel, ...args) {
    if (!enabled) {
      return;
    }
    console.log(`%c${PREFIX}%c[${channel}]`, "color: #FF6B35", styleFor(channel), ...args);
  }
  function group(channel, label) {
    if (!enabled) {
      return;
    }
    console.group(`%c${PREFIX}%c[${channel}] ${label}`, "color: #FF6B35", styleFor(channel));
  }
  function groupEnd() {
    console.groupEnd();
  }
  function warn(channel, ...args) {
    console.warn(`%c${PREFIX}%c[${channel}]`, "color: #FF6B35", STYLES.warn, ...args);
  }
  function error(channel, ...args) {
    console.error(`%c${PREFIX}%c[${channel}]`, "color: #FF6B35", STYLES.error, ...args);
  }
  var logger = {
    log,
    warn,
    error,
    group,
    groupEnd,
    /** Enable chatter - wired to the #pf-debug hash / debug setting in kernel. */
    enable() {
      enabled = true;
    },
    disable() {
      enabled = false;
    },
    get enabled() {
      return enabled;
    }
  };

  // src/shared/storage.js
  var KEYS = {
    configs: "pf:configs",
    resume: "pf:resume",
    firstRun: "pf:first-run"
  };
  function gmGetValue(key, fallback) {
    return GM_getValue(key, fallback);
  }
  function gmSetValue(key, value) {
    GM_setValue(key, value);
  }
  function gmRegisterMenu(title, onClick, options) {
    if (typeof GM_registerMenuCommand !== "function") {
      return null;
    }
    return GM_registerMenuCommand(title, onClick, options);
  }
  function gmUnregisterMenu(handle) {
    if (handle == null || typeof GM_unregisterMenuCommand !== "function") {
      return;
    }
    GM_unregisterMenuCommand(handle);
  }
  function gmAddValueChangeListener(key, callback) {
    if (typeof GM_addValueChangeListener !== "function") {
      return null;
    }
    return GM_addValueChangeListener(key, callback);
  }
  function gmRemoveValueChangeListener(handle) {
    if (handle == null || typeof GM_removeValueChangeListener !== "function") {
      return;
    }
    GM_removeValueChangeListener(handle);
  }
  function gmGetResourceText(name) {
    if (typeof GM_getResourceText !== "function") {
      return null;
    }
    return GM_getResourceText(name);
  }
  function gmRequestText(url, { timeoutMs = 3e4 } = {}) {
    const { promise, resolve, reject } = Promise.withResolvers();
    GM_xmlhttpRequest({
      url,
      method: "GET",
      timeout: timeoutMs,
      onload: (res) => {
        if (res.status >= 200 && res.status < 300) {
          resolve(res);
        } else {
          reject(new Error(`HTTP ${res.status}`));
        }
      },
      onerror: () => reject(new Error("Network error")),
      ontimeout: () => reject(new Error(`Timed out after ${timeoutMs}ms`))
    });
    return promise;
  }
  function loadJsonObject(key, fallback) {
    const raw = gmGetValue(key, null);
    return raw && typeof raw === "object" ? raw : fallback;
  }
  var configCache = null;
  function readConfigDoc() {
    if (configCache == null) {
      configCache = loadJsonObject(KEYS.configs, { version: 1 });
    }
    return configCache;
  }
  function invalidateConfigCache() {
    configCache = null;
  }
  function isSafeKeySegment(key) {
    return key !== "__proto__" && key !== "constructor" && key !== "prototype";
  }
  function persistConfig(doc) {
    try {
      gmSetValue(KEYS.configs, doc);
    } catch (err) {
      logger.error("storage", "Failed to persist config:", err);
      return false;
    }
    configCache = doc;
    return true;
  }
  function getConfigValue(path, fallback) {
    let node = readConfigDoc();
    for (const segment of path.split(".")) {
      if (!isSafeKeySegment(segment)) {
        return fallback;
      }
      if (node == null || typeof node !== "object") {
        return fallback;
      }
      node = node[segment];
    }
    return node === void 0 ? fallback : node;
  }
  function setConfigValue(path, value) {
    setConfigFields({ [path]: value });
  }
  function setConfigFields(fields) {
    const doc = structuredClone(readConfigDoc());
    for (const [path, value] of Object.entries(fields)) {
      const segments = path.split(".");
      let node = doc;
      for (let i = 0; i < segments.length - 1; i++) {
        const segment = segments[i];
        if (!isSafeKeySegment(segment)) {
          logger.warn("storage", `Unsafe config path segment "${segment}" in "${path}" — batch dropped`);
          return;
        }
        if (node[segment] == null) {
          node[segment] = {};
        } else if (typeof node[segment] !== "object" || Array.isArray(node[segment])) {
          logger.warn("storage", `Non-object intermediate at "${path}" — batch dropped`);
          return;
        }
        node = node[segment];
      }
      const last = segments.at(-1);
      if (!isSafeKeySegment(last)) {
        logger.warn("storage", `Unsafe config leaf segment "${last}" in "${path}" — batch dropped`);
        return;
      }
      node[last] = value;
    }
    if (!persistConfig(doc)) {
      return;
    }
  }
  function deleteConfigField(path) {
    const doc = structuredClone(readConfigDoc());
    const segments = path.split(".");
    let node = doc;
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      if (!isSafeKeySegment(segment)) {
        return;
      }
      if (node == null || typeof node !== "object") {
        return;
      }
      node = node[segment];
    }
    const last = segments.at(-1);
    if (!isSafeKeySegment(last) || node == null || typeof node !== "object" || !Object.hasOwn(node, last)) {
      return;
    }
    delete node[last];
    if (!persistConfig(doc)) {
      return;
    }
  }

  // src/shared/perf-diag.js
  var MAX_REPORT = 3;
  var JANK_THRESHOLD_MS = 150;
  var observer = null;
  var enabled2 = false;
  function report(entries) {
    const list = entries.getEntries();
    const worst = list.filter((e) => e.duration >= JANK_THRESHOLD_MS).sort((a, b) => b.duration - a.duration).slice(0, MAX_REPORT);
    for (const entry of worst) {
      const blocked = entry.blockingDuration ?? 0;
      const forced = entry.scripts?.reduce((sum, s) => sum + (s.forcedStyleAndLayoutDuration ?? 0), 0) ?? 0;
      logger.warn(
        "perf",
        `LoAF ${entry.duration.toFixed(0)}ms (blocking ${blocked.toFixed(0)}ms, forced style+layout ${forced.toFixed(1)}ms)`
      );
      for (const script of entry.scripts ?? []) {
        if (script.name) {
          logger.warn("perf", `  - ${script.name}`);
        }
        if (script.forcedStyleAndLayoutDuration > 0) {
          logger.warn("perf", `     forced style+layout ${script.forcedStyleAndLayoutDuration.toFixed(1)}ms`);
        }
      }
    }
  }
  function install() {
    if (observer || enabled2 || typeof PerformanceObserver === "undefined") {
      return;
    }
    try {
      if (!PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")) {
        return;
      }
      observer = new PerformanceObserver(report);
      observer.observe({ type: "long-animation-frame", buffered: false });
    } catch {
      observer = null;
    }
  }
  function teardown() {
    if (!observer) {
      return;
    }
    observer.disconnect();
    observer = null;
  }
  function setPerfDiag(on) {
    if (on === enabled2) {
      return;
    }
    enabled2 = on;
    if (on) {
      install();
    } else {
      teardown();
    }
  }

  // src/shared/scheduler.js
  var HAS_POST_TASK = typeof globalThis.scheduler?.postTask === "function";
  var HAS_YIELD = typeof globalThis.scheduler?.yield === "function";
  function postTask(fn, { priority = "user-visible", delay: ms = 0, signal } = {}) {
    if (!HAS_POST_TASK) {
      const id = setTimeout(fn, ms);
      return { abort: () => clearTimeout(id) };
    }
    const ac = new AbortController();
    const dropOwnerSignal = () => signal?.removeEventListener("abort", onOwnerAbort);
    const onOwnerAbort = () => {
      dropOwnerSignal();
      ac.abort();
    };
    signal?.addEventListener("abort", onOwnerAbort, { once: true });
    const task = globalThis.scheduler.postTask(() => {
      dropOwnerSignal();
      fn();
    }, { priority, delay: ms, signal: ac.signal });
    task.catch(() => {
    });
    return {
      abort: () => {
        dropOwnerSignal();
        ac.abort();
      }
    };
  }
  var yield_ = HAS_YIELD ? () => globalThis.scheduler.yield() : typeof globalThis.requestAnimationFrame === "function" ? () => new Promise((r) => {
    globalThis.requestAnimationFrame(() => r());
  }) : () => Promise.resolve();

  // src/kernel/registry.js
  var ShellSlot = class {
    #current = null;
    register(shell) {
      this.#current = shell;
      logger.log("registry", `Shell registered: ${shell.sdk.name}`);
    }
    unregister(shell) {
      if (this.#current === shell) {
        this.#current = null;
      }
      logger.log("registry", `Shell unregistered: ${shell.sdk.name}`);
    }
    getByVideo(video) {
      return this.#current?.video === video ? this.#current : null;
    }
    getAll() {
      return this.#current ? [this.#current] : [];
    }
    destroyAll() {
      const shell = this.#current;
      this.#current = null;
      if (shell) {
        shell.destroy();
        logger.log("registry", "Destroyed shell");
      }
    }
  };

  // src/kernel/lifecycle.js
  function whenDomSettled(container, { quietMs = 50, capMs = 150, signal } = {}) {
    const { promise, resolve } = Promise.withResolvers();
    let settled = false;
    let settleHandle = null;
    let capHandle = null;
    const done = () => {
      if (settled) {
        return;
      }
      settled = true;
      observer3.disconnect();
      settleHandle?.abort();
      capHandle?.abort();
      resolve();
    };
    const observer3 = new MutationObserver(() => {
      settleHandle?.abort();
      settleHandle = postTask(done, { priority: "user-visible", delay: quietMs });
    });
    settleHandle = postTask(done, { priority: "user-visible", delay: quietMs });
    capHandle = postTask(done, { priority: "user-visible", delay: capMs });
    observer3.observe(container, { childList: true });
    signal?.addEventListener("abort", done, { once: true });
    return promise;
  }
  var LifecycleManager = class {
    #registry;
    #onShellCreated;
    #shellFactory = null;
    /** Videos with a settle wait in flight - dedups repeated discovery. */
    #pending = /* @__PURE__ */ new Set();
    /** Abort source for in-flight settle waits; aborted by destroy() (pagehide). */
    #scope = new AbortController();
    constructor(registry, onShellCreated) {
      this.#registry = registry;
      this.#onShellCreated = onShellCreated;
    }
    setShellFactory(factory) {
      this.#shellFactory = factory;
    }
    async onVideoFound({ video, container, sdk }) {
      logger.log("lifecycle", `video:found - ${sdk.name}`);
      if (this.#registry.getByVideo(video)) {
        logger.log("lifecycle", "Video already has a shell, skipping");
        return;
      }
      if (!this.#shellFactory) {
        logger.error("lifecycle", "No shell factory set!");
        return;
      }
      if (this.#pending.has(video)) {
        return;
      }
      this.#pending.add(video);
      await whenDomSettled(container, { signal: this.#scope.signal });
      this.#pending.delete(video);
      if (!video.isConnected || !container.isConnected) {
        logger.log("lifecycle", `${sdk.name} video left the document before settle - skipping`);
        return;
      }
      if (this.#registry.getByVideo(video)) {
        return;
      }
      try {
        const shell = this.#shellFactory({ video, container, sdk });
        await shell?.ready;
        this.#onShellCreated(shell);
        logger.log("lifecycle", `Shell created for ${sdk.name}`);
      } catch (err) {
        logger.error("lifecycle", `Failed to create shell for ${sdk.name}:`, err);
      }
    }
    onVideoRemoved({ video }) {
      const shell = this.#registry.getByVideo(video);
      if (shell) {
        shell.destroy();
        logger.log("lifecycle", `Shell destroyed: ${shell.sdk.name}`);
      }
    }
    /**
     * Tear down every in-flight settle wait: the observer + its two timers die
     * immediately instead of running their full quiet/cap window after pagehide.
     * Continuations resume and hit the still-connected guards, so nothing is
     * half-created on a dying page.
     */
    destroy() {
      this.#scope.abort();
    }
  };

  // src/kernel/dom-watch.js
  var DEFER_VISIBILITY_CAP_MS = 500;
  var COMPACTION_RATIO = 4;
  var slots = [];
  var live = 0;
  var observer2 = null;
  var observedDoc = null;
  var queued = false;
  var pendingRecords = [];
  var recycledRecords = [];
  var deferHandle = null;
  function flush() {
    queued = false;
    const records = pendingRecords;
    pendingRecords = recycledRecords;
    recycledRecords = [];
    const length = slots.length;
    for (let i = 0; i < length; i++) {
      const slot = slots[i];
      if (!slot) {
        continue;
      }
      try {
        slot[0](records);
      } catch (err) {
        logger.error("dom-watch", "A dom-watch subscriber threw during dispatch", err);
      }
    }
    if (live > 0 && slots.length > live * COMPACTION_RATIO) {
      let write = 0;
      for (let i = 0; i < slots.length; i++) {
        if (slots[i]) {
          slots[write++] = slots[i];
        }
      }
      slots.length = write;
    }
  }
  var onVisibilityChange = () => {
    if (document.visibilityState !== "hidden") {
      flushPending();
    }
  };
  function flushPending() {
    deferHandle?.abort();
    deferHandle = null;
    document.removeEventListener("visibilitychange", onVisibilityChange);
    flush();
  }
  function deferFlushUntilVisible() {
    if (deferHandle) {
      return;
    }
    deferHandle = postTask(flushPending, { priority: "background", delay: DEFER_VISIBILITY_CAP_MS });
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
  async function scheduleFlush() {
    await yield_();
    if (document.visibilityState === "hidden") {
      deferFlushUntilVisible();
      return;
    }
    flush();
  }
  function ensureObserver() {
    const doc = globalThis.document;
    if (!doc?.documentElement) {
      return;
    }
    if (observer2 && observedDoc === doc) {
      return;
    }
    observer2?.disconnect();
    queued = false;
    pendingRecords = [];
    recycledRecords = [];
    observer2 = new MutationObserver((records) => {
      Array.prototype.push.apply(pendingRecords, records);
      if (!queued) {
        queued = true;
        queueMicrotask(scheduleFlush);
      }
    });
    observer2.observe(doc.documentElement, { childList: true, subtree: true });
    observedDoc = doc;
  }
  function stopIfIdle() {
    if (live === 0 && observer2) {
      observer2.disconnect();
      observer2 = null;
      observedDoc = null;
      pendingRecords = [];
      recycledRecords = [];
      slots.length = 0;
      deferHandle?.abort();
      deferHandle = null;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  }
  function onDomMutations(handler, { signal } = {}) {
    ensureObserver();
    slots.push([handler]);
    live += 1;
    const index = slots.length - 1;
    const off = () => {
      if (slots[index]) {
        slots[index] = null;
        live -= 1;
      }
      stopIfIdle();
    };
    signal?.addEventListener("abort", off, { once: true });
    return off;
  }

  // src/kernel/sdk.js
  var REGISTRY = [
    { name: "JW Player", anchors: [".jwplayer", ".jw-wrapper"] },
    { name: "Video.js", anchors: ["[data-vjs-player]", ".video-js"] },
    { name: "Plyr", anchors: ["[data-plyr]", ".plyr__video-wrapper", ".plyr"] },
    { name: "ArtPlayer", anchors: [".art-video-player", ".artplayer"] },
    { name: "DPlayer", anchors: [".dplayer"] },
    { name: "MediaElement.js", anchors: [".mejs-container", ".mejs__container"] },
    { name: "XGPlayer", anchors: [".xgplayer"] },
    { name: "Aliplayer", anchors: [".prism-player"] },
    { name: "Fluid Player", anchors: [".fluid_video_wrapper"] },
    { name: "Flowplayer", anchors: [".fp-player", "flowplayer-ui", "[data-player-id]", ".flowplayer"] },
    { name: "Clappr", anchors: ["[data-player]"] },
    { name: "Vidstack", anchors: ["media-player"] },
    { name: "Mux Player", anchors: ["mux-player"] },
    { name: "Radiant Media Player", anchors: ["radiant-media-player"] },
    { name: "Laravel Video Embed", anchors: ["[data-page] > div:first-child", "#app[data-page]"] }
  ];
  var MIN_VIDEO_WIDTH = 100;
  var MIN_VIDEO_HEIGHT = 60;
  var matchCache = /* @__PURE__ */ new WeakMap();
  var chain = [];
  function fillComposedChain(start) {
    let len = 0;
    for (let node = start; node; ) {
      if (node.nodeType === 1) {
        chain[len++] = node;
      }
      node = node.parentNode ?? node.host ?? null;
    }
    return len;
  }
  function matchSdk(video) {
    const cached = matchCache.get(video);
    if (cached) {
      return cached;
    }
    const len = fillComposedChain(video);
    let best = null;
    for (let r = 0; r < REGISTRY.length; r++) {
      const record = REGISTRY[r];
      const anchors = record.anchors;
      for (let a = 0; a < anchors.length; a++) {
        const anchor = anchors[a];
        for (let hop = 0; hop < len; hop++) {
          if (chain[hop].matches(anchor)) {
            if (!best || hop < best.hops) {
              best = { record, el: chain[hop], hops: hop };
            }
            break;
          }
        }
      }
    }
    if (best) {
      matchCache.set(video, best);
    }
    return best;
  }
  var descriptorCache = /* @__PURE__ */ new WeakMap();
  function findSdkForVideo(video) {
    const cached = descriptorCache.get(video);
    if (cached !== void 0) {
      return cached;
    }
    const match = matchSdk(video);
    if (!match) {
      descriptorCache.set(video, null);
      return null;
    }
    const descriptor = {
      name: match.record.name,
      host: match.record.host ?? null,
      container: resolveContainer(match),
      anchor: match.el,
      hops: match.hops
    };
    descriptorCache.set(video, descriptor);
    return descriptor;
  }
  function resolveContainer({ record, el: el2 }) {
    if (!record.host) {
      return el2;
    }
    const len = fillComposedChain(el2);
    for (let hop = 0; hop < len; hop++) {
      if (chain[hop].matches(record.host)) {
        return chain[hop];
      }
    }
    return el2;
  }
  function videoFromEvent(event) {
    const target = event.target;
    if (target?.localName === "video") {
      return target;
    }
    for (const node of event.composedPath?.() ?? []) {
      if (node?.localName === "video") {
        return node;
      }
    }
    return null;
  }
  function* videosFromMutations(mutations) {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) {
          continue;
        }
        if (node.localName === "video") {
          yield node;
        } else if (node.querySelectorAll) {
          yield* node.querySelectorAll("video");
        }
      }
    }
  }
  function meetsMinSize(video, minWidth = MIN_VIDEO_WIDTH, minHeight = MIN_VIDEO_HEIGHT) {
    if (typeof video.checkVisibility === "function" && !video.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
      return false;
    }
    try {
      const rect = video.getBoundingClientRect();
      return rect.width >= minWidth && rect.height >= minHeight;
    } catch {
      return false;
    }
  }
  function watchMediaEvents(onVideo, { signal } = {}) {
    const onMediaEvent = (event) => {
      const video = videoFromEvent(event);
      if (video) {
        onVideo(video);
      }
    };
    document.addEventListener("loadeddata", onMediaEvent, { capture: true, signal });
    document.addEventListener("play", onMediaEvent, { capture: true, signal });
    return () => {
      document.removeEventListener("loadeddata", onMediaEvent, true);
      document.removeEventListener("play", onMediaEvent, true);
    };
  }
  function watchDocumentVideos(onVideo) {
    const offEvents = watchMediaEvents(onVideo);
    const offMutations = onDomMutations((mutations) => {
      for (const video of videosFromMutations(mutations)) {
        onVideo(video);
      }
    });
    return () => {
      offEvents();
      offMutations();
    };
  }

  // src/kernel/contract.js
  var SHELL_MARKER = "data-pf-shell";
  var DEBUG_LOGS_KEY = "debug.logs";
  var GESTURE_EVENTS = {
    hold: "pf:gesture-hold",
    release: "pf:gesture-release",
    scrub: "pf:gesture-scrub",
    scrubEnd: "pf:gesture-scrub-end",
    swipeStart: "pf:gesture-swipe-start",
    swipe: "pf:gesture-swipe",
    dbltap: "pf:gesture-dbltap",
    skip: "pf:gesture-skip",
    volume: "pf:gesture-volume",
    mute: "pf:gesture-mute",
    pip: "pf:gesture-pip",
    panel: "pf:gesture-panel",
    pinch: "pf:gesture-pinch"
  };
  var FRAMEWORK_TUNING = {
    removalGraceMs: 500
  };

  // src/kernel/kernel.js
  var MAX_REMOVAL_DEPTH = 8;
  var REMOVAL_DEPTH_MARGIN = 1;
  var Kernel = class {
    #registry;
    #lifecycle;
    /** Shell-ready listeners (direct callbacks, no bus). */
    #createdListeners = /* @__PURE__ */ new Set();
    #initialized = false;
    // Weak: an adopted video orphaned by an untracked removal path must not
    // pin the element (and its whole subtree) for the page's lifetime.
    #seenVideos = /* @__PURE__ */ new WeakSet();
    #removalObservers = /* @__PURE__ */ new Set();
    #removalTimers = /* @__PURE__ */ new Map();
    /** Unsubscribe for the shared discovery tap; dropped at pagehide. */
    #stopDiscoveryTap = null;
    /** True once the full-document discovery tap has been downgraded. */
    #discoveryDowngraded = false;
    #scope = new AbortController();
    /** The shell host provider, registered by the shell plugin (never imported). */
    #shellProvider = null;
    #onPageShow = (event) => {
      if (!event.persisted) {
        return;
      }
      logger.log("kernel", "Restored from bfcache - reconciling");
      for (const shell of this.#registry.getAll()) {
        if (!shell.video.isConnected) {
          this.#seenVideos.delete(shell.video);
          shell.destroy();
          logger.log("kernel", `Reconciled orphaned shell: ${shell.sdk.name}`);
        }
      }
    };
    #onPageHide = (event) => {
      if (!event.persisted) {
        logger.log("kernel", "Page hiding, cleaning up");
        this.#stopDiscoveryTap?.();
        this.#stopDiscoveryTap = null;
        for (const observer3 of this.#removalObservers) {
          observer3.disconnect();
        }
        this.#removalObservers.clear();
        for (const cancel of this.#removalTimers.values()) {
          cancel();
        }
        this.#removalTimers.clear();
        this.#lifecycle.destroy();
        this.#registry.destroyAll();
        this.#scope.abort();
      }
    };
    constructor() {
      this.#registry = new ShellSlot();
      this.#lifecycle = new LifecycleManager(this.#registry, (shell) => this.#notifyShellCreated(shell));
      this.#lifecycle.setShellFactory((discovery) => this.#createShell(discovery));
    }
    /**
     * The shell plugin registers its host provider here; the framework never
     * imports the shell, it only calls the provider it was handed. Provider
     * shape: `{ create({ video, container, sdk, onDestroy }) -> host }`.
     */
    registerShellProvider(provider) {
      this.#shellProvider = provider;
    }
    /** Register a shell-ready listener directly; returns an unsubscribe. */
    onShellCreated(cb) {
      this.#createdListeners.add(cb);
      return () => this.#createdListeners.delete(cb);
    }
    /** Register the shell then fan out to every shell-ready listener. */
    #notifyShellCreated(shell) {
      this.#registry.register(shell);
      for (const cb of this.#createdListeners) {
        try {
          cb(shell);
        } catch (err) {
          logger.error("kernel", "Shell-created listener threw:", err);
        }
      }
    }
    init() {
      if (this.#initialized) {
        return;
      }
      this.#initialized = true;
      logger.log("kernel", "Initializing kernel");
      const storedDebug = getConfigValue(DEBUG_LOGS_KEY, false);
      const hashDebug = location.hash.includes("pf-debug");
      if (storedDebug || hashDebug) {
        this.#setDebugRuntime(true);
        logger.log("kernel", `Debug logs on (${[storedDebug && "setting", hashDebug && "hash"].filter(Boolean).join(" + ")})`);
      }
      const { signal } = this.#scope;
      document.addEventListener("pageshow", this.#onPageShow, { signal });
      window.addEventListener("pagehide", this.#onPageHide, { signal });
      this.#stopDiscoveryTap = watchDocumentVideos((video) => this.#adoptVideo(video));
      for (const video of document.querySelectorAll("video")) {
        this.#adoptVideo(video);
      }
      logger.log("kernel", "Kernel ready - discovery tap active");
    }
    /**
     * After the first successful adoption, drop the full-document discovery tap
     * (the heavier childList+subtree observer) and fall back to the cheap
     * capture-mode media-event tap. On MPA pages there is no second player to
     * surface, so keeping the per-mutation scan alive for the whole page taxes
     * every DOM change for nothing; the media-event tap still catches a
     * script-lazy SDK player that fires loadeddata/play, so discovery never goes
     * fully quiet. Idempotent; pagehide still tears the remaining tap down.
     */
    #downgradeDiscoveryTap() {
      if (this.#discoveryDowngraded) {
        return;
      }
      this.#discoveryDowngraded = true;
      this.#stopDiscoveryTap?.();
      this.#stopDiscoveryTap = watchMediaEvents((video) => this.#adoptVideo(video));
    }
    /** Adopt the video, emit discovery and start removal watching. */
    #adoptVideo(video) {
      if (this.#seenVideos.has(video) || video.hasAttribute(SHELL_MARKER)) {
        return;
      }
      const sdk = findSdkForVideo(video);
      if (!sdk) {
        return;
      }
      if (!meetsMinSize(video)) {
        return;
      }
      const container = sdk.container;
      if (!container) {
        logger.warn("kernel", "No container for video - skipping");
        return;
      }
      this.#seenVideos.add(video);
      logger.log("kernel", `${sdk.name} adopted (${video.videoWidth}x${video.videoHeight}, ${Math.round(video.duration)}s)`);
      this.#lifecycle.onVideoFound({
        video,
        container,
        sdk
      });
      this.#watchVideoRemoval(video, container, sdk.hops);
      this.#downgradeDiscoveryTap();
    }
    #watchVideoRemoval(video, container, hops) {
      const watchDepth = Number.isInteger(hops) && hops > 0 ? Math.min(hops + REMOVAL_DEPTH_MARGIN, MAX_REMOVAL_DEPTH) : MAX_REMOVAL_DEPTH;
      const anchors = [];
      const scheduleGraceTimer = (done) => {
        const handle = postTask(done, {
          priority: "user-visible",
          delay: FRAMEWORK_TUNING.removalGraceMs,
          signal: this.#scope.signal
        });
        return () => handle.abort();
      };
      const checkAnchors = () => {
        if (this.#removalTimers.has(video)) {
          return;
        }
        if (!video.isConnected) {
          this.#removalTimers.set(video, scheduleGraceTimer(() => {
            this.#removalTimers.delete(video);
            if (!video.isConnected) {
              stopWatching();
              this.#lifecycle.onVideoRemoved({ video });
            } else {
              reanchorObservers();
            }
          }));
          return;
        }
        if (video.parentElement !== anchors[0]) {
          reanchorObservers();
        }
      };
      const observer3 = new MutationObserver(checkAnchors);
      this.#removalObservers.add(observer3);
      const reanchorObservers = () => {
        for (const target of anchors) {
          observer3.unobserve(target);
        }
        anchors.length = 0;
        let anchor = video.parentElement || container;
        for (let depth = 0; anchor && depth < watchDepth; depth++, anchor = anchor.parentElement) {
          observer3.observe(anchor, { childList: true });
          anchors.push(anchor);
        }
      };
      const stopWatching = () => {
        observer3.disconnect();
        this.#removalObservers.delete(observer3);
        this.#removalTimers.get(video)?.();
        this.#removalTimers.delete(video);
        this.#seenVideos.delete(video);
      };
      reanchorObservers();
    }
    #createShell({ video, container, sdk }) {
      const provider = this.#shellProvider;
      if (!provider) {
        logger.error("kernel", "No shell provider registered");
        return null;
      }
      const shell = provider.create({
        video,
        container,
        sdk,
        onDestroy: () => this.#registry.unregister(shell)
      });
      return shell;
    }
    /**
     * Toggle the most recently created shell's panel from outside the input
     * stack (GM menu). Warns unconditionally when nothing can host a panel -
     * the user clicked something and must know why nothing happened.
     */
    togglePanel() {
      const shells = this.#registry.getAll();
      const host = shells.length ? shells.at(-1).shellHost : null;
      if (!host) {
        logger.warn("kernel", "Panel toggle requested but no player is active on this page");
        return;
      }
      host.dispatchEvent(new CustomEvent(GESTURE_EVENTS.panel, {
        detail: { method: "menu" }
      }));
    }
    #setDebugRuntime(on) {
      if (on) {
        logger.enable();
      } else {
        logger.disable();
      }
      setPerfDiag(on);
    }
  };

  // src/shared/shadow.js
  function deepestActiveElement(host) {
    let el2 = host?.shadowRoot?.activeElement ?? document.activeElement;
    while (el2?.shadowRoot) {
      el2 = el2.shadowRoot.activeElement;
    }
    return el2;
  }
  function isInsideShell(host, node) {
    return node === host || (host.shadowRoot?.contains(node) ?? host.contains(node));
  }
  var fs = false;
  var fsSubscribers = /* @__PURE__ */ new Set();
  function initFullscreenGate(doc = document) {
    fs = !!doc.fullscreenElement;
    const update = () => {
      const next = !!doc.fullscreenElement;
      if (next === fs) {
        return;
      }
      fs = next;
      for (const cb of fsSubscribers) {
        cb(next);
      }
    };
    doc.addEventListener("fullscreenchange", update);
  }
  function subscribeFullscreen(cb, signal) {
    fsSubscribers.add(cb);
    if (signal) {
      signal.addEventListener("abort", () => fsSubscribers.delete(cb), { once: true });
    }
    return () => fsSubscribers.delete(cb);
  }

  // src/shared/formatters.js
  var fmtPercent = (v) => `${v}%`;
  var fmtEm = (v) => `${v}em`;
  var fmtSeconds = (v) => `${v}s`;

  // src/shell/chrome/config.js
  var SETTINGS_PREFIX = "settings";
  var SETTINGS_SCHEMA = [
    {
      key: "controller.stepSeek",
      type: "options",
      label: "Skip Step",
      options: [5, 10, 15],
      fmt: fmtSeconds,
      default: 5,
      group: "Playback"
    },
    {
      key: "gestures.hotkeys",
      type: "bool",
      label: "Hotkeys",
      default: true,
      group: "Features"
    },
    {
      key: "gestures.hold",
      type: "bool",
      label: "Speed Up Hold",
      default: true,
      group: "Features"
    },
    {
      key: "gestures.scrub",
      type: "bool",
      label: "Scrub Seeking",
      default: true,
      group: "Features"
    },
    {
      key: "gestures.swipe",
      type: "bool",
      label: "Swiping",
      default: true,
      group: "Features"
    },
    {
      key: "gestures.dbltap",
      type: "bool",
      label: "Double-tap Skip",
      default: true,
      group: "Features"
    },
    {
      key: "gestures.pinch",
      type: "bool",
      label: "Pinch to Fill",
      default: true,
      group: "Features"
    },
    {
      key: "gestures.haptics",
      type: "bool",
      label: "Haptic Feedback",
      default: true,
      group: "Features"
    },
    {
      key: "fullscreen.edgeToEdge",
      type: "bool",
      label: "Edge-to-edge Fullscreen",
      default: true,
      group: "Features"
    },
    {
      key: "ui.compact",
      type: "bool",
      label: "Compact Panel",
      default: false,
      group: "Interface"
    }
  ];
  var DEFAULT_SETTINGS = Object.fromEntries(
    SETTINGS_SCHEMA.map((definition) => [definition.key, definition.default])
  );
  function coerceSetting(definition, value) {
    if (definition.type === "bool") {
      return typeof value === "boolean" ? value : definition.default;
    }
    if (definition.type === "options") {
      return definition.options.includes(value) ? value : definition.default;
    }
    return value;
  }
  var cache = {};
  for (const definition of SETTINGS_SCHEMA) {
    cache[definition.key] = coerceSetting(definition, getConfigValue(`${SETTINGS_PREFIX}.${definition.key}`, definition.default));
  }
  function getSetting(key) {
    return cache[key];
  }
  function setSetting(key, value) {
    cache[key] = value;
    setConfigValue(`${SETTINGS_PREFIX}.${key}`, value);
  }
  function refreshSettingsCache() {
    invalidateConfigCache();
    let changed = 0;
    for (const definition of SETTINGS_SCHEMA) {
      const key = definition.key;
      const fresh = coerceSetting(definition, getConfigValue(`${SETTINGS_PREFIX}.${key}`, DEFAULT_SETTINGS[key]));
      if (cache[key] !== fresh) {
        cache[key] = fresh;
        changed++;
      }
    }
    if (changed > 0) {
      logger.log("settings", `Live-reloaded ${changed} setting(s) from storage`);
    }
  }
  gmAddValueChangeListener(KEYS.configs, () => refreshSettingsCache());
  function addSettingsSection(panel) {
    if (!panel?.body) {
      return;
    }
    const sectionRoot = panel.addSection("Settings", "settings");
    if (!sectionRoot) {
      return;
    }
    let currentGroup = null;
    let groupGrid = null;
    for (const definition of SETTINGS_SCHEMA) {
      if (definition.group !== currentGroup) {
        currentGroup = definition.group;
        const groupSection = panel.el("div", { class: "pf-panel-section" }, sectionRoot);
        panel.addLabel(groupSection, definition.group);
        groupGrid = panel.el("div", { class: "pf-panel-grid" }, groupSection);
      }
      if (definition.type === "bool") {
        const cellAttrs = { class: "pf-panel-cell" };
        const cell = panel.el("div", cellAttrs, groupGrid);
        const toggleLabel = panel.el("label", { class: "pf-settings-toggle" }, cell);
        const checkbox = panel.addControl(toggleLabel, {
          type: "checkbox",
          checked: getSetting(definition.key),
          onChange: (checked) => {
            setSetting(definition.key, checked);
          }
        });
        checkbox.setAttribute("aria-label", definition.label);
        panel.el("span", {}, toggleLabel).textContent = definition.label;
      } else if (definition.type === "options") {
        const cell = panel.el("div", { class: "pf-panel-cell pf-options-cell" }, groupGrid);
        panel.addLabel(cell, definition.label);
        const row = panel.el("div", { class: "pf-options-row" }, cell);
        const current = getSetting(definition.key);
        for (const opt of definition.options) {
          const btn = panel.el("button", {
            type: "button",
            class: opt === current ? "pf-btn pf-options-btn pf-options-active" : "pf-btn pf-options-btn"
          }, row);
          btn.textContent = definition.fmt(opt);
          btn.addEventListener("click", () => {
            setSetting(definition.key, opt);
            for (const b of row.children) {
              b.classList.toggle("pf-options-active", b === btn);
            }
          });
        }
      } else {
        panel.addControl(groupGrid, {
          type: "stepper",
          label: definition.label,
          min: definition.min,
          max: definition.max,
          step: definition.step,
          value: getSetting(definition.key),
          head: true,
          format: definition.fmt,
          // Typing stays local until blur/Enter - no GM_setValue per keystroke
          // (subtitle steppers keep live output, so they stay immediate).
          deferTextInput: true,
          onChange: (parsed) => setSetting(definition.key, parsed)
        });
      }
    }
    logger.log("settings", "Settings section ready");
  }

  // src/shared/tuning.js
  var TUNING = {
    gestures: {
      /** Hold-to-speed-up: press must stay still and last this long. */
      holdTimeoutMs: 300,
      holdCancelMovePx: 10,
      doubleTapWindowMs: 300,
      /** Swipe-exit hot zones as a viewport fraction. */
      edgeZoneRatio: 0.15,
      scrollStartPx: 15,
      axisDominanceRatio: 2,
      pinchMinDistancePx: 50,
      pinchScaleThreshold: 0.2,
      pinchBaselineDelayMs: 2,
      trackpadCooldownMs: 500,
      /** Click/dblclick suppression window after a consumed gesture. */
      suppressWindowMs: 600,
      /** Horizontal travel that dismisses the HUD. */
      swipeExitMinPx: 100,
      /** Idle time that resets the double-tap skip streak. */
      streakResetMs: 600
    },
    controller: {
      holdSpeed: 2,
      streakMax: 10,
      /** Stored raw around the 150 anchor; effective multiplier = value / 150. */
      scrubSensitivity: 100
    },
    scrub: {
      /**
       * Velocity-proportional scrub. The amount of time moved per pixel is a
       * monotonic saturating function of the finger's real-time speed (measured
       * px/s by the forge at move granularity and updated live): a slow stroke
       * moves ~slowFullWidthSeconds across the container width, a fast stroke
       * covers fastFullWidthFraction of the playback DURATION. The curve rises
       * smoothly past the knee, then saturates so high-speed scrubbing stays
       * stable (scrubTo clamps to [0, duration]). Because it follows the hand's
       * current velocity rather than hold time, and scales the ceiling with the
       * runtime, the seek amount is proportional to velocity in real time and
       * traverses any content length uniformly - signed by drag direction.
       */
      velocity: {
        /** Full-width stroke at near-zero speed: the "1s" deliberate floor. */
        slowFullWidthSeconds: 1,
        /** Fraction of the PLAYBACK DURATION a full-width fast stroke can cover.
         *  The fast ceiling scales with content length so the same gesture
         *  traverses a short clip or a long movie proportionally (regular-player
         *  feel) - 0.5 = up to half the runtime per full-width fast stroke. */
        fastFullWidthFraction: 0.5,
        /** Velocity (px/s) at which the gain sits ~halfway between slow and fast. */
        kneeVelocityPxS: 400,
        /** Curve shape; >1 rises later and punchier, <1 hurries to the ceiling. */
        exponent: 1.5
      },
      /** Sub-pixel moves are ignored so a holding finger doesn't micro-shimmer. */
      deadZonePx: 0.5,
      /**
       * Time constant (ms) of the velocity low-pass filter in the forge:
       * alpha = 1 - exp(-dt/tau). Because alpha derives from real elapsed time
       * rather than event count, the smoothing window is the same absolute time
       * at any display rate - adaptive-refresh correct - and the small tau keeps
       * the signal responsive enough to track speed changes mid-stroke.
       */
      velocityFilterMs: 60
    },
    resume: {
      /** Minimum wall-clock time between incremental persists (timeupdate-driven). */
      saveIntervalMs: 6e4,
      metadataWaitMs: 1e4,
      /** Progress at/after which the entry resets so the video restarts next time. */
      completionRatio: 0.95,
      /** Ignore tiny drifts between saves. */
      saveEpsilonSeconds: 3,
      durationFuzz: 2,
      /** Only auto-seek when the saved position is meaningful. */
      minPosition: 5,
      staleDays: 14,
      /** Hard ceiling for stored entries regardless of age pruning. */
      maxEntries: 1e3
    },
    filter: {
      /** Trailing flush for color steppers: preview is instant, storage waits. */
      persistDebounceMs: 300
    },
    subtitles: {
      syncDebounceMs: 150
    },
    toast: {
      /** Completed-action feedback: skip, volume, fullscreen exit, fill. */
      flashMs: 800,
      /** Plain status messages. */
      infoMs: 2500,
      /** Toasts carrying a clickable button - extra reading time. */
      actionMs: 4e3,
      /** Onboarding hints. */
      hintMs: 5e3
    }
  };

  // src/shared/time.js
  function formatTime(seconds) {
    if (!(seconds > 0)) {
      return "0:00";
    }
    seconds = Math.floor(seconds);
    const h = seconds / 3600 | 0;
    const m = seconds % 3600 / 60 | 0;
    const s = seconds % 60;
    const mm = m < 10 ? "0" + m : "" + m;
    const ss = s < 10 ? "0" + s : "" + s;
    return h > 0 ? h + ":" + mm + ":" + ss : m + ":" + ss;
  }
  function delay(fn, ms) {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  }
  function debounce(fn, ms) {
    let cancel = null;
    let pendingArgs = null;
    const debounced = (...args) => {
      pendingArgs = args;
      cancel?.();
      cancel = delay(() => {
        cancel = null;
        fn(...pendingArgs);
        pendingArgs = null;
      }, ms);
    };
    debounced.flush = () => {
      if (!cancel) {
        return;
      }
      cancel();
      cancel = null;
      fn(...pendingArgs);
      pendingArgs = null;
    };
    debounced.cancel = () => {
      cancel?.();
      cancel = null;
      pendingArgs = null;
    };
    return debounced;
  }

  // src/shell/chrome/haptics.js
  var PATTERNS = {
    /** Speed-up hold engaged. */
    hold: 12,
    /** Scrub session latched. */
    scrub: [10, 24, 10],
    /** Pinch-fill engaged or released. */
    pinch: [8, 14, 8, 14, 8],
    /** Fullscreen double-tap committed (skip/toggle). */
    dbltap: [14, 40, 14],
    /** Swipe gesture committed (exit fullscreen). */
    swipe: [10, 30, 10]
  };
  var canVibrate = typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
  function gestureHaptic(type) {
    if (!canVibrate || !getSetting("gestures.haptics")) {
      return;
    }
    const pattern = PATTERNS[type];
    if (pattern != null) {
      try {
        navigator.vibrate(pattern);
      } catch {
      }
    }
  }

  // src/shared/timing.js
  var EASE_CURVE = "cubic-bezier(0.22, 1, 0.36, 1)";
  var EASE_SNAPPY_CURVE = "cubic-bezier(0.16, 1, 0.3, 1)";
  var EASE_BOUNCE_CURVE = "cubic-bezier(0.34, 1.56, 0.64, 1)";
  var EASE_OUT_CURVE = "cubic-bezier(0.4, 0, 1, 1)";
  var FLASH_EASING = "ease-out";
  var EASE_MS = 180;
  var EASE_SNAPPY_MS = 120;
  var EASE_BOUNCE_MS = 250;
  var EASE_OUT_MS = 200;
  var FLASH_MS = 400;
  var EASE = `${EASE_MS}ms ${EASE_CURVE}`;
  var EASE_BOUNCE = `${EASE_BOUNCE_MS}ms ${EASE_BOUNCE_CURVE}`;
  var EASE_OUT = `${EASE_OUT_MS}ms ${EASE_OUT_CURVE}`;

  // src/shell/inputs/actions.js
  var INPUT_BINDINGS = [
    // - Pointer intents -
    { id: "hold-speed", gesture: "hold", setting: "gestures.hold", fs: false },
    { id: "drag-scrub", gesture: "scrub", setting: "gestures.scrub", fs: true },
    { id: "drag-swipe", gesture: "swipe", setting: "gestures.swipe", fs: true },
    { id: "double-tap", gesture: "dbltap", setting: "gestures.dbltap", fs: true },
    { id: "pinch-fill", gesture: "pinch", setting: "gestures.pinch", fs: true },
    // - Keyboard -
    {
      id: "key-skip-right",
      gesture: "key",
      code: "ArrowRight",
      emit: GESTURE_EVENTS.skip,
      direction: "right",
      setting: "gestures.hotkeys",
      fs: false
    },
    {
      id: "key-skip-left",
      gesture: "key",
      code: "ArrowLeft",
      emit: GESTURE_EVENTS.skip,
      direction: "left",
      setting: "gestures.hotkeys",
      fs: false
    },
    {
      id: "key-volume-up",
      gesture: "key",
      code: "ArrowUp",
      emit: GESTURE_EVENTS.volume,
      direction: "up",
      setting: "gestures.hotkeys",
      fs: false
    },
    {
      id: "key-volume-down",
      gesture: "key",
      code: "ArrowDown",
      emit: GESTURE_EVENTS.volume,
      direction: "down",
      setting: "gestures.hotkeys",
      fs: false
    },
    {
      id: "key-mute",
      gesture: "key",
      code: "KeyM",
      emit: GESTURE_EVENTS.mute,
      setting: "gestures.hotkeys",
      fs: false
    },
    {
      id: "key-pip",
      gesture: "key",
      code: "KeyP",
      emit: GESTURE_EVENTS.pip,
      setting: "gestures.hotkeys",
      fs: false
    },
    {
      id: "key-panel",
      gesture: "key",
      code: "KeyS",
      emit: GESTURE_EVENTS.panel,
      setting: "gestures.hotkeys",
      fs: false,
      allowControlFocus: true
    }
  ];
  function gateOpen(binding) {
    return (!binding.setting || getSetting(binding.setting)) && (!binding.fs || fs);
  }
  var BY_GESTURE = /* @__PURE__ */ new Map();
  for (const binding of INPUT_BINDINGS) {
    let list = BY_GESTURE.get(binding.gesture);
    if (!list) {
      list = [];
      BY_GESTURE.set(binding.gesture, list);
    }
    list.push(binding);
  }
  function allowsIntent(gesture) {
    const bindings = BY_GESTURE.get(gesture);
    if (!bindings) {
      return false;
    }
    for (let i = 0; i < bindings.length; i++) {
      if (gateOpen(bindings[i])) {
        return true;
      }
    }
    return false;
  }
  var KEY_BINDINGS = BY_GESTURE.get("key");
  function isKeyArmed(binding) {
    return gateOpen(binding);
  }
  var SCRUB_KNEE_PX_PER_S = TUNING.scrub.velocity.kneeVelocityPxS;
  var SCRUB_EXPONENT = TUNING.scrub.velocity.exponent;
  var SCRUB_DEAD_ZONE_PX = TUNING.scrub.deadZonePx;
  var SCRUB_SLOW_FULL_WIDTH_SECONDS = TUNING.scrub.velocity.slowFullWidthSeconds;
  var SCRUB_FAST_FULL_WIDTH_FRACTION = TUNING.scrub.velocity.fastFullWidthFraction;
  var SCRUB_SENSITIVITY = TUNING.controller.scrubSensitivity / 150;
  var stateFor = /* @__PURE__ */ (() => {
    const states = /* @__PURE__ */ new WeakMap();
    return (shell) => {
      let state = states.get(shell);
      if (!state) {
        state = {
          savedRate: 1,
          activeHolds: /* @__PURE__ */ new Set(),
          scrubbing: false,
          scrubDuration: 0,
          scrubSlowGain: 0,
          scrubFastGain: 0,
          scrubSensitivity: 0,
          scrubDirectionMomentum: 0,
          lastScrubToastAt: 0,
          scrubToastText: null,
          scrubToastSecDuration: NaN,
          scrubToastSecCurrent: NaN,
          streakCount: 0,
          lastSkipDirection: null,
          streakResetAt: 0,
          fillActive: false
        };
        states.set(shell, state);
      }
      return state;
    };
  })();
  function performSkip(shell, state, direction) {
    const now = performance.now();
    const streakMax = TUNING.controller.streakMax;
    if (now - state.streakResetAt >= TUNING.gestures.streakResetMs) {
      state.streakCount = 0;
      state.lastSkipDirection = null;
    }
    if (direction === state.lastSkipDirection) {
      state.streakCount = Math.min(state.streakCount + 1, streakMax);
    } else {
      state.streakCount = 1;
      state.lastSkipDirection = direction;
    }
    state.streakResetAt = now;
    const step = getSetting("controller.stepSeek") * state.streakCount;
    shell.media.skip(direction === "right" ? step : -step);
    shell.toastFlash(
      direction === "right" ? "right-arrows" : "left-arrows",
      `${step}s`,
      "skip"
    );
  }
  var EASE_STYLE = EASE_SNAPPY_CURVE;
  var EASE_MS2 = EASE_SNAPPY_MS;
  var pendingEase = /* @__PURE__ */ new WeakMap();
  function cancelEase(video) {
    const prior = pendingEase.get(video);
    if (prior) {
      prior();
    }
  }
  function dropPromotion(video) {
    if (video.style.willChange === "transform") {
      video.style.willChange = "";
    }
  }
  function easeTransformTo(video, transform) {
    const prior = pendingEase.get(video);
    if (prior) {
      prior();
    }
    if (transform) {
      video.style.willChange = "transform";
    }
    if (typeof video.animate === "function") {
      const animation = video.animate(
        [
          { transform: getComputedStyle(video).transform || "none" },
          { transform: transform || "none" }
        ],
        { duration: EASE_MS2, easing: EASE_STYLE, fill: "both" }
      );
      const stop = () => {
        if (pendingEase.get(video) !== stop) {
          return;
        }
        pendingEase.delete(video);
        video.style.transition = "";
        animation.cancel();
      };
      pendingEase.set(video, stop);
      animation.addEventListener("finish", () => {
        if (pendingEase.get(video) !== stop) {
          return;
        }
        video.style.transition = "";
        video.style.transform = transform;
        animation.cancel();
        pendingEase.delete(video);
        dropPromotion(video);
      });
      animation.addEventListener("cancel", () => {
        if (pendingEase.get(video) === stop) {
          pendingEase.delete(video);
          dropPromotion(video);
        }
      });
      return;
    }
    const pendingStop = () => {
      video.removeEventListener("transitionend", onEnd);
      video.removeEventListener("transitioncancel", onCancel);
      if (pendingEase.get(video) === pendingStop) {
        pendingEase.delete(video);
        dropPromotion(video);
      }
    };
    const onEnd = (event) => {
      if (event.propertyName === "transform") {
        pendingStop();
      }
    };
    const onCancel = () => pendingStop();
    pendingEase.set(video, pendingStop);
    video.addEventListener("transitionend", onEnd);
    video.addEventListener("transitioncancel", onCancel);
    video.style.transition = `transform ${EASE_MS2}ms ${EASE_STYLE}`;
    video.style.transform = transform;
  }
  function clearFillMode(shell, state, animate = true) {
    if (!state.fillActive) {
      return;
    }
    state.fillActive = false;
    const video = shell.video;
    if (video) {
      if (animate) {
        easeTransformTo(video, "");
      } else {
        const prior = pendingEase.get(video);
        if (prior) {
          prior();
        }
        video.style.transition = "none";
        video.style.transform = "";
        video.style.willChange = "";
        video.style.transition = "";
      }
      video.style.objectFit = state.priorObjectFit || "";
      state.priorObjectFit = "";
    }
  }
  function computeCoverScale(video, ref) {
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    if (!videoWidth || !videoHeight) {
      return 0;
    }
    const refWidth = ref?.width;
    const refHeight = ref?.height;
    if (!refWidth || !refHeight) {
      return 0;
    }
    const aspect = videoWidth / videoHeight;
    const fittedWidth = Math.min(refWidth, refHeight * aspect);
    const fittedHeight = Math.min(refHeight, refWidth / aspect);
    return Math.max(refWidth / fittedWidth, refHeight / fittedHeight);
  }
  function volumeIcon(volume, muted) {
    return muted ? "muted" : volume > 0.7 ? "volume-1" : volume > 0.4 ? "volume-2" : "volume-3";
  }
  function volumePercent(volume) {
    return `${Math.round(volume * 100)}%`;
  }
  function attachInputActions(shell, host, signal) {
    subscribeFullscreen((active) => {
      if (!active) {
        const state = stateFor(shell);
        if (state.fillActive) {
          clearFillMode(shell, state, false);
        }
      }
    }, signal);
    host.addEventListener(GESTURE_EVENTS.hold, ({ detail }) => {
      if (!shell.video) {
        return;
      }
      const state = stateFor(shell);
      const source = detail.method || "pointer";
      if (state.activeHolds.has(source) || (state.activeHolds.add(source), state.activeHolds.size > 1)) {
        return;
      }
      const speed = TUNING.controller.holdSpeed;
      state.savedRate = shell.playbackRate;
      shell.media.beginBoost(speed);
      gestureHaptic("hold");
      shell.toast({ icon: "right-arrows", text: `${speed}x`, group: "hold" });
    }, { signal });
    host.addEventListener(GESTURE_EVENTS.release, ({ detail }) => {
      const state = stateFor(shell);
      const source = detail.method || "pointer";
      if (!state.activeHolds.delete(source) || state.activeHolds.size > 0) {
        return;
      }
      if (shell.video) {
        shell.media.endBoost(state.savedRate);
      }
      shell.hideToast("hold");
    }, { signal });
    host.addEventListener(GESTURE_EVENTS.scrub, ({ detail }) => {
      if (!shell.video) {
        return;
      }
      const state = stateFor(shell);
      const now = performance.now();
      if (!state.scrubbing) {
        const duration = shell.duration;
        if (!duration || !Number.isFinite(duration)) {
          return;
        }
        const width = shell.referenceBox.width || 640;
        const fastCeiling = duration * SCRUB_FAST_FULL_WIDTH_FRACTION;
        state.scrubbing = true;
        state.scrubDuration = duration;
        state.scrubSlowGain = SCRUB_SLOW_FULL_WIDTH_SECONDS / width;
        state.scrubFastGain = fastCeiling / width;
        state.scrubSensitivity = SCRUB_SENSITIVITY;
        state.scrubDirectionMomentum = 0;
        gestureHaptic("scrub");
      }
      if (Math.abs(detail.dx) < SCRUB_DEAD_ZONE_PX) {
        return;
      }
      const v = Math.abs(detail.velocity);
      const t = Math.min(1, (v / SCRUB_KNEE_PX_PER_S) ** SCRUB_EXPONENT);
      const gain = state.scrubSlowGain + (state.scrubFastGain - state.scrubSlowGain) * t;
      const deltaSeconds = detail.dx * gain * state.scrubSensitivity;
      shell.media.scrubToLatched(shell.currentTime + deltaSeconds, state.scrubDuration);
      const instantDirection = detail.dx > 1 ? 1 : detail.dx < -1 ? -1 : 0;
      state.scrubDirectionMomentum = state.scrubDirectionMomentum * 0.6 + instantDirection * 0.4;
      if (now - state.lastScrubToastAt < 100) {
        return;
      }
      state.lastScrubToastAt = now;
      const secDuration = Math.floor(state.scrubDuration);
      const secCurrent = Math.floor(shell.video.currentTime);
      if (secDuration !== state.scrubToastSecDuration || secCurrent !== state.scrubToastSecCurrent) {
        state.scrubToastText = `${formatTime(state.scrubDuration)} / ${formatTime(shell.video.currentTime)}`;
        state.scrubToastSecDuration = secDuration;
        state.scrubToastSecCurrent = secCurrent;
      }
      shell.toast({
        icon: state.scrubDirectionMomentum >= 0 ? "right-arrows" : "left-arrows",
        text: state.scrubToastText,
        group: "scrub"
      });
    }, { signal });
    host.addEventListener(GESTURE_EVENTS.scrubEnd, () => {
      const state = stateFor(shell);
      if (!state.scrubbing) {
        return;
      }
      state.scrubbing = false;
      state.scrubDirectionMomentum = 0;
      state.scrubDuration = 0;
      state.scrubSlowGain = 0;
      state.scrubFastGain = 0;
      state.scrubSensitivity = 0;
      state.scrubToastText = null;
      state.scrubToastSecDuration = NaN;
      state.scrubToastSecCurrent = NaN;
      shell.hideToast("scrub");
    }, { signal });
    host.addEventListener(GESTURE_EVENTS.swipeStart, ({ detail }) => {
      if (detail.direction === "down") {
        shell.toast({
          icon: "fs-exiting",
          text: "Exiting Fullscreen",
          group: "fs"
        });
      }
    }, { signal });
    host.addEventListener(GESTURE_EVENTS.swipe, ({ detail }) => {
      const state = stateFor(shell);
      if (detail.direction !== "down") {
        return;
      }
      if (detail.distance > TUNING.gestures.swipeExitMinPx) {
        gestureHaptic("swipe");
        clearFillMode(shell, state, false);
        shell.toastFlash("fs-exit", "Fullscreen Exited", "fs");
        shell.exitFullscreen();
      } else {
        shell.hideToast("fs");
      }
    }, { signal });
    host.addEventListener(GESTURE_EVENTS.dbltap, ({ detail }) => {
      gestureHaptic("dbltap");
      if (detail.zone === "left-edge" || detail.zone === "right-edge") {
        performSkip(shell, stateFor(shell), detail.zone === "left-edge" ? "left" : "right");
      } else if (detail.zone === "screen") {
        shell.media.togglePlay();
      }
    }, { signal });
    host.addEventListener(GESTURE_EVENTS.skip, ({ detail }) => {
      performSkip(shell, stateFor(shell), detail.direction);
    }, { signal });
    host.addEventListener(GESTURE_EVENTS.volume, ({ detail }) => {
      if (!shell.video) {
        return;
      }
      shell.media.nudgeVolume(detail.direction);
      shell.toastFlash(volumeIcon(shell.volume, false), volumePercent(shell.volume), "volume");
    }, { signal });
    host.addEventListener(GESTURE_EVENTS.mute, () => {
      if (!shell.video) {
        return;
      }
      shell.media.toggleMute();
      shell.toastFlash(volumeIcon(shell.volume, shell.muted), shell.muted ? "Muted" : volumePercent(shell.volume), "volume");
    }, { signal });
    host.addEventListener(GESTURE_EVENTS.pip, () => {
      if (!shell.video) {
        return;
      }
      if (!shell.media.pictureInPictureSupported()) {
        shell.toastInfo("pip", "Picture-in-Picture not supported", "pip");
        return;
      }
      shell.media.togglePictureInPicture().then((active) => {
        shell.toastFlash("pip", active ? "Picture-in-Picture" : "Exited Picture-in-Picture", "pip");
      }).catch(() => {
        shell.toastInfo("pip", "Picture-in-Picture unavailable", "pip");
      });
    }, { signal });
    host.addEventListener(GESTURE_EVENTS.pinch, ({ detail }) => {
      if (!shell.video) {
        return;
      }
      const state = stateFor(shell);
      const video = shell.video;
      if (detail.direction === "out" && !state.fillActive) {
        const scale = computeCoverScale(video, shell.referenceBox);
        if (scale <= 1) {
          return;
        }
        gestureHaptic("pinch");
        state.priorObjectFit = video.style.objectFit;
        video.style.objectFit = "contain";
        easeTransformTo(video, `scale(${scale})`);
        state.fillActive = true;
        shell.toastFlash("fill-aspect", "Fill Mode", "pinch");
      } else if (detail.direction === "in" && state.fillActive) {
        clearFillMode(shell, state);
      }
    }, { signal });
  }

  // src/shared/dom-manager.js
  var DOMManager = class {
    /** [target, event, handler, opts] triples for automatic removeEventListener. */
    #listeners = [];
    /** [observer] MutationObserver instances for automatic disconnect. */
    #observers = [];
    /** [observer] ResizeObserver instances for automatic disconnect. */
    #resizeObservers = [];
    /** [element] Created elements for automatic remove(). */
    #elements = [];
    /** [el, attr, value, original] triples for attribute rollback on destroy. */
    #attrRollbacks = [];
    /** [el, prop, value, original] triples for style rollback on destroy. */
    #styleRollbacks = [];
    /** [fn] External cleanup callbacks (e.g. dom-watch unsubscribe handles). */
    #cleanups = [];
    #destroyed = false;
    /**
     * Add an event listener that is automatically removed on destroy.
     * Returns the handler for call-site reference (e.g. passing to removeEventListener
     * before destroy is called).
     */
    listen(target, event, handler, opts) {
      if (this.#destroyed) return handler;
      target.addEventListener(event, handler, opts);
      this.#listeners.push([target, event, handler, opts]);
      return handler;
    }
    /**
     * Create a MutationObserver that is automatically disconnected on destroy.
     * Returns the observer for manual use between creation and destroy.
     */
    observeMutations(target, opts, callback) {
      if (this.#destroyed) return null;
      const observer3 = new MutationObserver(callback);
      observer3.observe(target, opts);
      this.#observers.push(observer3);
      return observer3;
    }
    /**
     * Create a ResizeObserver that is automatically disconnected on destroy.
     * Returns the observer for manual use between creation and destroy.
     */
    observeResize(target, callback) {
      if (this.#destroyed) return null;
      const observer3 = new ResizeObserver(callback);
      observer3.observe(target);
      this.#resizeObservers.push(observer3);
      return observer3;
    }
    /**
     * Create an element and append it to a parent. The element is automatically
     * removed from the DOM on destroy.
     */
    createElement(tag, attrs, parent) {
      if (this.#destroyed) return null;
      const doc = parent?.ownerDocument ?? document;
      const node = doc.createElement(tag);
      if (attrs) {
        for (const [key, value] of Object.entries(attrs)) {
          if (key === "class") {
            node.className = value;
          } else if (key === "style" && typeof value === "object") {
            Object.assign(node.style, value);
          } else if (key.startsWith("on") && typeof value === "function") {
            node.addEventListener(key.slice(2), value);
          } else {
            node.setAttribute(key, value);
          }
        }
      }
      parent?.appendChild(node);
      this.#elements.push(node);
      return node;
    }
    /**
     * Set an attribute on an element, recording the original value for
     * automatic restoration on destroy. If the element already has the
     * attribute, the original is preserved (first-write wins).
     */
    markAttribute(el2, attr, value) {
      if (this.#destroyed) return;
      const existing = this.#attrRollbacks.find(([e, a]) => e === el2 && a === attr);
      if (!existing) {
        const original = el2.getAttribute(attr);
        this.#attrRollbacks.push([el2, attr, value, original]);
      }
      el2.setAttribute(attr, value);
    }
    /**
     * Set an inline style property, recording the original value for
     * automatic restoration on destroy.
     */
    markStyle(el2, prop, value) {
      if (this.#destroyed) return;
      const existing = this.#styleRollbacks.find(([e, p]) => e === el2 && p === prop);
      if (!existing) {
        const original = el2.style.getPropertyValue(prop);
        this.#styleRollbacks.push([el2, prop, value, original]);
      }
      el2.style.setProperty(prop, value);
    }
    /**
     * Register an external cleanup callback (e.g. an unsubscribe handle from
     * dom-watch.js or a pool destroy). Called in reverse order on destroy.
     */
    onCleanup(fn) {
      if (this.#destroyed) {
        fn();
        return;
      }
      this.#cleanups.push(fn);
    }
    /**
     * Register an external AbortSignal whose abort triggers cleanup of the
     * given handler on the given target. Useful for wiring a parent scope's
     * signal to this manager's listener registry.
     */
    wireSignal(target, event, handler, opts, signal) {
      this.listen(target, event, handler, opts);
      signal?.addEventListener("abort", () => {
        target.removeEventListener(event, handler, opts);
      }, { once: true });
    }
    /**
     * Tear down every tracked artifact in reverse registration order.
     * Idempotent — safe to call multiple times.
     */
    destroy() {
      if (this.#destroyed) return;
      this.#destroyed = true;
      for (let i = this.#cleanups.length - 1; i >= 0; i--) {
        try {
          this.#cleanups[i]();
        } catch {
        }
      }
      this.#cleanups.length = 0;
      for (const [el2, attr, , original] of this.#attrRollbacks) {
        if (original == null) {
          el2.removeAttribute(attr);
        } else {
          el2.setAttribute(attr, original);
        }
      }
      this.#attrRollbacks.length = 0;
      for (const [el2, prop, , original] of this.#styleRollbacks) {
        if (original) {
          el2.style.setProperty(prop, original);
        } else {
          el2.style.removeProperty(prop);
        }
      }
      this.#styleRollbacks.length = 0;
      for (let i = this.#elements.length - 1; i >= 0; i--) {
        this.#elements[i].remove();
      }
      this.#elements.length = 0;
      for (const observer3 of this.#resizeObservers) {
        observer3.disconnect();
      }
      this.#resizeObservers.length = 0;
      for (const observer3 of this.#observers) {
        observer3.disconnect();
      }
      this.#observers.length = 0;
      for (const [target, event, handler, opts] of this.#listeners) {
        target.removeEventListener(event, handler, opts);
      }
      this.#listeners.length = 0;
    }
  };

  // src/shell/inputs/forge.js
  var WHEEL_CAPTURE = { capture: true, passive: false };
  var EDGE_ZONE_RATIO = TUNING.gestures.edgeZoneRatio;
  var EDGE_ZONE_START = 1 - TUNING.gestures.edgeZoneRatio;
  var HOLD_TIMEOUT_MS = TUNING.gestures.holdTimeoutMs;
  var HOLD_CANCEL_MOVE_PX = TUNING.gestures.holdCancelMovePx;
  var SCROLL_START_PX = TUNING.gestures.scrollStartPx;
  var AXIS_DOMINANCE_RATIO = TUNING.gestures.axisDominanceRatio;
  var PINCH_MIN_DISTANCE_PX = TUNING.gestures.pinchMinDistancePx;
  var PINCH_SCALE_THRESHOLD = TUNING.gestures.pinchScaleThreshold;
  var PINCH_BASELINE_DELAY_MS = TUNING.gestures.pinchBaselineDelayMs;
  var TRACKPAD_COOLDOWN_MS = TUNING.gestures.trackpadCooldownMs;
  var SUPPRESS_WINDOW_MS = TUNING.gestures.suppressWindowMs;
  var DOUBLE_TAP_WINDOW_MS = TUNING.gestures.doubleTapWindowMs;
  var SCRUB_VELOCITY_TAU_S = TUNING.scrub.velocityFilterMs / 1e3;
  var activeForges = /* @__PURE__ */ new Set();
  var lastActiveForge = null;
  var firstTwoPointers = { x0: 0, y0: 0, x1: 0, y1: 0 };
  function captureFirstTwo(pointers, out) {
    let n = 0;
    for (const point of pointers.values()) {
      if (n === 0) {
        out.x0 = point.x;
        out.y0 = point.y;
      } else {
        out.x1 = point.x;
        out.y1 = point.y;
        return true;
      }
      n = 1;
    }
    return false;
  }
  var scrubDetail = { zone: "", method: "pointer", dx: 0, velocity: 0, timestamp: 0 };
  var scrubPool = null;
  function pooledScrubEvent() {
    const Ctor = globalThis.CustomEvent;
    if (scrubPool && scrubPool.Ctor === Ctor) {
      return scrubPool.event;
    }
    scrubPool = {
      Ctor,
      event: new Ctor(GESTURE_EVENTS.scrub, {
        detail: scrubDetail,
        bubbles: false,
        composed: false
      })
    };
    return scrubPool.event;
  }
  var dispatchPool = /* @__PURE__ */ new Map();
  function pooledDispatchEvent(name, detail) {
    const Ctor = globalThis.CustomEvent;
    const stale = dispatchPool.get(name);
    if (stale && stale.Ctor === Ctor) {
      stale.event.detail = detail;
      return stale.event;
    }
    const event = new Ctor(name, { detail, bubbles: false, composed: false });
    dispatchPool.set(name, { Ctor, event });
    return event;
  }
  function clickTime(event) {
    return event.timeStamp > 0 ? event.timeStamp : performance.now();
  }
  var InputForge = class {
    #video;
    #zone;
    #eventTarget;
    /** DOM lifecycle manager: listeners, observers, style rollbacks. */
    #dom = new DOMManager();
    /** Sub-component scope: signal exposed via getter for action wiring. */
    #scope = new AbortController();
    #destroyed = false;
    // Cached <video> box for hit-testing, invalidated on resize/fullscreen so
    // pointerdown never forces a synchronous layout flush with getBoundingClientRect.
    #videoRect = null;
    // Pointer session state.
    #primaryPointerId = null;
    #startX = 0;
    #startY = 0;
    #startTime = 0;
    #holdTimer = null;
    #holding = false;
    /** -Infinity so the very first tap can never match against boot time. */
    #lastTapTime = -Infinity;
    #gestureZone = null;
    // Click/dblclick suppression after gestures: a deadline consumed by the
    // capture handlers when the next click actually arrives (no per-gesture timer).
    #suppressClickUntil = 0;
    // Scrub state.
    #scrubbing = false;
    #scrubLastX = 0;
    #scrubLastTime = 0;
    #scrubVelocity = 0;
    // Swipe state.
    #swiping = false;
    #swipeDirection = null;
    #swipeBaseTransform = "";
    #lastSwipeDrag = NaN;
    #lastSwipeTransform = "";
    /**
     * Once a scrub/swipe session latches, the gesture already started fullscreen
     * (both intents are fs-gated), so this flag replaces the per-move `fs` gate
     * read and the live intent-gate scans - the session keeps running even if
     * the page loses fullscreen mid-stroke, which matches the pre-existing
     * behavior. Reset at the session's end.
     */
    #gestureFsActive = false;
    // Pinch state.
    #pointers = /* @__PURE__ */ new Map();
    #pinchStartDistance = 0;
    #pinchFired = false;
    #pinchZone = null;
    #pinchInitTimer = null;
    // Keyboard hold state.
    #keyboardHoldTimer = null;
    #keyboardHolding = false;
    #keyboardHoldStart = 0;
    // Trackpad ctrl+wheel pinch cooldown: a lazy deadline avoids per-gesture timers.
    #trackpadPinchCooldownUntil = -Infinity;
    /** Whether the (non-passive) wheel pinch listener is currently attached. */
    #trackpadPinchSubscribed = false;
    /** Stable reference so the scoped wheel listener can be removed again. */
    #wheelHandler = null;
    constructor(video, zone, eventTarget) {
      this.#video = video;
      this.#zone = zone;
      this.#eventTarget = eventTarget;
      const { signal } = this.#scope;
      this.#dom.markStyle(zone, "touch-action", "none");
      const options = { capture: true, passive: true, signal };
      zone.addEventListener("pointerdown", (event) => this.#handlePointerDown(event), options);
      zone.addEventListener("pointermove", (event) => this.#handlePointerMove(event), options);
      zone.addEventListener("pointerup", (event) => this.#handlePointerUp(event), options);
      zone.addEventListener("pointercancel", (event) => this.#handlePointerCancel(event), options);
      zone.addEventListener("click", (event) => this.#handleClickCapture(event), { capture: true, signal });
      zone.addEventListener("dblclick", (event) => this.#handleDblClickCapture(event), { capture: true, signal });
      window.addEventListener("pointerup", (event) => this.#handlePointerUp(event), options);
      window.addEventListener("pointercancel", (event) => this.#handlePointerCancel(event), options);
      document.addEventListener("keydown", (event) => this.#handleKeydown(event), { capture: true, signal });
      document.addEventListener("keyup", (event) => this.#handleKeyup(event), { capture: true, signal });
      window.addEventListener("blur", () => this.#finishKeyboardHold(false), { signal });
      subscribeFullscreen(() => {
        this.setTrackpadPinchEnabled(fs);
      }, this.#scope.signal);
      activeForges.add(this);
    }
    /** Engine lifetime signal - action wiring shares it and dies with it. */
    get signal() {
      return this.#scope.signal;
    }
    /**
     * Subscribe/unsubscribe the trackpad pinch wheel listener. It is the only
     * non-passive listener here besides the activation suppressors, so it lives
     * only while its feature can fire (fullscreen). Driven natively by
     * fullscreenchange; exposed for explicit scoping in tests.
     */
    setTrackpadPinchEnabled(enabled3) {
      if (this.#destroyed || enabled3 === this.#trackpadPinchSubscribed) {
        return;
      }
      if (enabled3) {
        this.#trackpadPinchSubscribed = true;
        this.#wheelHandler = (event) => this.#handleWheelCapture(event);
        this.#zone.addEventListener("wheel", this.#wheelHandler, WHEEL_CAPTURE);
      } else {
        this.#detachTrackpadPinch();
      }
    }
    #detachTrackpadPinch() {
      if (!this.#trackpadPinchSubscribed) {
        return;
      }
      this.#trackpadPinchSubscribed = false;
      if (this.#wheelHandler) {
        this.#zone.removeEventListener("wheel", this.#wheelHandler, true);
        this.#wheelHandler = null;
      }
    }
    /** Snap any inline transform back with a short transition. */
    #restoreTransform() {
      easeTransformTo(this.#video, this.#swipeBaseTransform || "");
    }
    destroy() {
      if (!this.#destroyed) {
        this.#detachTrackpadPinch();
        this.#endPointerSession();
        this.#destroyed = true;
        clearTimeout(this.#holdTimer);
        this.#holdTimer = null;
        clearTimeout(this.#keyboardHoldTimer);
        this.#keyboardHoldTimer = null;
        clearTimeout(this.#pinchInitTimer);
        this.#pinchInitTimer = null;
        this.#videoRect = null;
        this.#pointers.clear();
        cancelEase(this.#video);
        this.#dom.destroy();
        activeForges.delete(this);
        if (lastActiveForge === this) {
          lastActiveForge = null;
        }
        this.#resetKeyboardHold();
        this.#scope.abort();
      }
    }
    /** Suppress the click/dblclick that follows an interactive gesture. */
    #suppressNextActivations() {
      this.#suppressClickUntil = performance.now() + SUPPRESS_WINDOW_MS;
    }
    #resetKeyboardHold() {
      this.#keyboardHolding = false;
      clearTimeout(this.#keyboardHoldTimer);
      this.#keyboardHoldTimer = null;
    }
    #hitTestVideo(pointerEvent) {
      if (!this.#videoRect) {
        this.#videoRect = this.#video.getBoundingClientRect();
      }
      const rect = this.#videoRect;
      return pointerEvent.clientX >= rect.left && pointerEvent.clientX <= rect.right && pointerEvent.clientY >= rect.top && pointerEvent.clientY <= rect.bottom;
    }
    #zoneForPoint(pointerEvent) {
      const screenWidth = typeof screen !== "undefined" && screen.width > 0 ? screen.width : window.innerWidth;
      if (pointerEvent.clientX < screenWidth * EDGE_ZONE_RATIO) {
        return "left-edge";
      } else if (pointerEvent.clientX > screenWidth * EDGE_ZONE_START) {
        return "right-edge";
      } else {
        return "screen";
      }
    }
    /** End the current pointer interaction: fire release/scrub-end/swipe-cancel. */
    #endPointerSession() {
      this.#clearHoldTimer();
      if (this.#holding) {
        this.#holding = false;
        this.#dispatch(GESTURE_EVENTS.release, {
          zone: this.#gestureZone,
          method: "pointer",
          duration: performance.now() - this.#startTime
        });
      }
      if (this.#scrubbing) {
        this.#scrubbing = false;
        this.#dispatch(GESTURE_EVENTS.scrubEnd, {
          zone: this.#gestureZone || "screen",
          method: "pointer"
        });
      }
      if (this.#swiping) {
        this.#swiping = false;
        this.#swipeDirection = null;
        this.#lastSwipeDrag = NaN;
        this.#lastSwipeTransform = "";
        this.#restoreTransform();
      }
      this.#gestureFsActive = false;
      this.#suppressNextActivations();
    }
    #clearHoldTimer() {
      clearTimeout(this.#holdTimer);
      this.#holdTimer = null;
    }
    #beginPinchTracking() {
      this.#endPointerSession();
      this.#primaryPointerId = null;
      for (const pointerId of this.#pointers.keys()) {
        this.#pointerOp("releasePointerCapture", pointerId);
      }
      this.#pinchStartDistance = 0;
      this.#pinchFired = false;
      this.#pinchZone = this.#gestureZone || "screen";
      clearTimeout(this.#pinchInitTimer);
      this.#pinchInitTimer = setTimeout(() => {
        this.#pinchInitTimer = null;
        if (this.#destroyed || this.#pointers.size < 2) {
          return;
        }
        captureFirstTwo(this.#pointers, firstTwoPointers);
        this.#pinchStartDistance = Math.hypot(firstTwoPointers.x1 - firstTwoPointers.x0, firstTwoPointers.y1 - firstTwoPointers.y0);
      }, PINCH_BASELINE_DELAY_MS);
    }
    #checkPinch() {
      if (!fs || this.#pinchFired || this.#pinchStartDistance < PINCH_MIN_DISTANCE_PX) {
        return;
      }
      if (!captureFirstTwo(this.#pointers, firstTwoPointers)) {
        return;
      }
      const scaleDelta = (Math.hypot(firstTwoPointers.x1 - firstTwoPointers.x0, firstTwoPointers.y1 - firstTwoPointers.y0) - this.#pinchStartDistance) / this.#pinchStartDistance;
      if (scaleDelta > PINCH_SCALE_THRESHOLD || scaleDelta < -PINCH_SCALE_THRESHOLD) {
        this.#pinchFired = true;
        this.#suppressNextActivations();
        this.#dispatch(GESTURE_EVENTS.pinch, {
          zone: this.#pinchZone,
          method: "pointer",
          direction: scaleDelta > 0 ? "out" : "in"
        });
      }
    }
    /**
     * Decide whether keyboard shortcuts should apply: yes when focus sits
     * on a target that cannot consume the keystroke itself - inside the
     * container, or at page level (SPA roots park focus on app wrappers,
     * not body) while this engine owns playback.
     */
    #shouldHandleKeys(allowControlFocus = false) {
      const activeElement = deepestActiveElement(this.#eventTarget);
      if (!this.#zone) {
        return false;
      }
      if (!this.#keysAllowedForTarget(activeElement, allowControlFocus)) {
        return false;
      }
      if (isInsideShell(this.#eventTarget, activeElement)) {
        return true;
      }
      if (!this.#isActive(this)) {
        return false;
      }
      let candidates = 0;
      let includesThis = false;
      for (const forge of activeForges) {
        if (this.#isActive(forge)) {
          candidates++;
          includesThis ||= forge === this;
        }
      }
      if (candidates === 1) {
        return includesThis;
      } else if (candidates > 1) {
        return lastActiveForge === this;
      }
      return false;
    }
    /**
     * Whether a focused element must keep its keystrokes (playback keys yield).
     * Text entry, links, selects/options and inputs always win. Buttons only
     * win when they belong to PlayerForge's own chrome - clicking a NATIVE
     * player control must never silence hotkeys (desktop-player parity), while
     * pf stepper/select controls genuinely consume arrows.
     */
    #keysAllowedForTarget(el2, allowControlFocus) {
      if (!el2 || el2 === document.body || el2 === document.documentElement) {
        return true;
      }
      if (this.#isTextEntryTarget(el2) || el2.closest?.("a[href]")) {
        return false;
      }
      const tag = el2.tagName;
      if (tag === "SELECT" || tag === "OPTION" || tag === "INPUT") {
        return !!allowControlFocus;
      }
      if (tag === "BUTTON") {
        return !!allowControlFocus || !isInsideShell(this.#eventTarget, el2);
      }
      return true;
    }
    #isTextEntryTarget(el2) {
      if (!el2) {
        return false;
      }
      if (el2.isContentEditable || el2.tagName === "TEXTAREA") {
        return true;
      }
      if (el2.tagName === "INPUT") {
        const type = (el2.getAttribute("type") || "text").toLowerCase();
        return type !== "checkbox" && type !== "radio" && type !== "button" && type !== "submit" && type !== "reset" && type !== "color";
      }
      return false;
    }
    /** An engine can own playback when its video is loaded and not finished. */
    #isActive(forge) {
      return !forge.#destroyed && forge.#video.readyState > 0 && !forge.#video.ended;
    }
    #dispatch(eventName, detail) {
      if (!this.#destroyed && this.#eventTarget) {
        this.#eventTarget.dispatchEvent(pooledDispatchEvent(eventName, detail));
      }
    }
    #pointerOp(op, pointerId) {
      if (pointerId != null) {
        try {
          this.#zone[op](pointerId);
        } catch {
        }
      }
    }
    #handlePointerDown(event) {
      this.#videoRect = null;
      if (event.button !== 0 || this.#eventTarget && isInsideShell(this.#eventTarget, event.target) || this.#pointers.size === 0 && !this.#hitTestVideo(event)) {
        return;
      }
      lastActiveForge = this;
      const existing = this.#pointers.get(event.pointerId);
      if (existing) {
        existing.x = event.clientX;
        existing.y = event.clientY;
      } else {
        this.#pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }
      if (this.#pointers.size === 2) {
        if (allowsIntent("pinch")) {
          this.#beginPinchTracking();
        }
        return;
      }
      if (!(this.#pointers.size > 2)) {
        this.#primaryPointerId = event.pointerId;
        this.#startX = event.clientX;
        this.#startY = event.clientY;
        this.#startTime = performance.now();
        this.#holding = false;
        this.#suppressClickUntil = 0;
        this.#gestureZone = this.#zoneForPoint(event);
        this.#scrubbing = false;
        this.#scrubLastX = event.clientX;
        this.#scrubLastTime = this.#startTime;
        this.#scrubVelocity = 0;
        this.#swiping = false;
        this.#swipeDirection = null;
        this.#lastSwipeDrag = NaN;
        this.#lastSwipeTransform = "";
        this.#clearHoldTimer();
        this.#holdTimer = setTimeout(() => {
          this.#holdTimer = null;
          if (this.#primaryPointerId !== null && !this.#video.paused && allowsIntent("hold")) {
            this.#holding = true;
            this.#pointerOp("setPointerCapture", this.#primaryPointerId);
            this.#dispatch(GESTURE_EVENTS.hold, {
              zone: this.#gestureZone,
              method: "pointer",
              duration: performance.now() - this.#startTime
            });
          }
        }, HOLD_TIMEOUT_MS);
      }
    }
    #handlePointerMove(event) {
      const x = event.clientX;
      const y = event.clientY;
      const pointer = this.#pointers.get(event.pointerId);
      if (pointer) {
        pointer.x = x;
        pointer.y = y;
      }
      if (this.#pointers.size === 2 && this.#pinchStartDistance > 0) {
        this.#checkPinch();
        return;
      }
      if (this.#primaryPointerId === null || event.pointerId !== this.#primaryPointerId) {
        return;
      }
      const now = performance.now();
      const dx = Math.abs(x - this.#startX);
      const dy = Math.abs(y - this.#startY);
      if (dx > HOLD_CANCEL_MOVE_PX || dy > HOLD_CANCEL_MOVE_PX) {
        this.#clearHoldTimer();
      }
      if ((this.#gestureFsActive || fs) && !this.#holding) {
        if (!this.#scrubbing && !this.#swiping) {
          if (allowsIntent("scrub") && dx > SCROLL_START_PX && dx > dy * AXIS_DOMINANCE_RATIO) {
            this.#scrubbing = true;
            this.#gestureFsActive = true;
            this.#pointerOp("setPointerCapture", this.#primaryPointerId);
            this.#scrubLastX = x;
            this.#scrubLastTime = now;
            this.#scrubVelocity = 0;
          } else if (allowsIntent("swipe") && dy > SCROLL_START_PX && dy > dx * AXIS_DOMINANCE_RATIO) {
            this.#swiping = true;
            this.#gestureFsActive = true;
            this.#swipeDirection = y > this.#startY ? "down" : "up";
            this.#swipeBaseTransform = this.#video.style.transform || "";
            if (this.#swipeDirection === "down") {
              this.#video.style.willChange = "transform";
            }
            this.#pointerOp("setPointerCapture", this.#primaryPointerId);
            this.#suppressNextActivations();
            event.stopImmediatePropagation();
            this.#dispatch(GESTURE_EVENTS.swipeStart, {
              zone: this.#gestureZone || "screen",
              method: "pointer",
              direction: this.#swipeDirection
            });
          }
        }
        if (this.#scrubbing) {
          event.stopImmediatePropagation();
          this.#advanceScrub(event);
        }
        if (this.#swiping && this.#swipeDirection === "down") {
          event.stopImmediatePropagation();
          const drag = y - this.#startY;
          if (drag !== this.#lastSwipeDrag) {
            const t = this.#swipeBaseTransform ? this.#swipeBaseTransform + " translateY(" + drag + "px)" : "translateY(" + drag + "px)";
            if (t !== this.#lastSwipeTransform) {
              this.#video.style.transform = t;
              this.#lastSwipeTransform = t;
            }
            this.#lastSwipeDrag = drag;
          }
        }
      }
    }
    /**
     * Consume every coalesced sample of the move so high-rate Chromium pointer
     * streams scrub at full fidelity; one semantic event is emitted per move.
     *
     * Real-time velocity is measured at move granularity from true event
     * timestamps (the live event's own DOMHighResTimeStamp, same epoch as
     * performance.now()) and smoothed with a first-order time-based filter,
     * alpha = 1 - exp(-dt/tau). Because alpha derives from the real interval
     * between moves, the smoothing window is the same absolute time at any
     * display rate - adaptive-refresh correct - while the small tau keeps the
     * signal responsive enough to track speed changes mid-stroke, so the seek
     * amount stays proportional to the hand in real time.
     *
     * Chromium's PointerEvent.getPredictedEvents() returns extrapolated FUTURE
     * positions. We speculatively "draw ahead" with them, matching the drawing
     * idiom in the Pointer Events spec (predict, then discard once real points
     * arrive): predicted travel feeds the VELOCITY estimate only, never the
     * confirmed seek delta (#scrubLastX stays pinned to real samples). Because
     * scrub's amount is a monotonic function of velocity, a fresher, higher
     * velocity read makes the response feel ahead of the hand - lower perceived
     * latency - while the absolute position stays grounded in real motion, so a
     * prediction can never overshoot or drift a fast flick. Prediction is
     * bounded: only the first predicted sample, capped to the confirmed travel.
     */
    #advanceScrub(event) {
      let totalStep = 0;
      const hasCoalesced = typeof event.getCoalescedEvents === "function";
      const samples = hasCoalesced ? event.getCoalescedEvents() : null;
      if (samples) {
        const count = samples.length + 1;
        let lastX = this.#scrubLastX;
        for (let i = 0; i < count; i++) {
          const sample = i < samples.length ? samples[i] : event;
          totalStep += sample.clientX - lastX;
          lastX = sample.clientX;
        }
        this.#scrubLastX = lastX;
      } else {
        totalStep = event.clientX - this.#scrubLastX;
        this.#scrubLastX = event.clientX;
      }
      const hasPredicted = hasCoalesced && typeof event.getPredictedEvents === "function";
      let velocityStep = totalStep;
      if (hasPredicted) {
        const predicted = event.getPredictedEvents();
        if (predicted && predicted.length) {
          velocityStep += Math.sign(totalStep) * Math.min(Math.abs(predicted[0].clientX - event.clientX), Math.abs(totalStep));
        }
      }
      const now = event.timeStamp;
      const dt = (now - this.#scrubLastTime) / 1e3;
      this.#scrubLastTime = now;
      const instantVelocity = dt > 1e-3 ? velocityStep / dt : 0;
      const alpha = dt > 0 ? 1 - Math.exp(-dt / SCRUB_VELOCITY_TAU_S) : 0;
      this.#scrubVelocity += alpha * (instantVelocity - this.#scrubVelocity);
      scrubDetail.zone = this.#gestureZone || "screen";
      scrubDetail.method = "pointer";
      scrubDetail.dx = totalStep;
      scrubDetail.velocity = this.#scrubVelocity;
      scrubDetail.timestamp = now;
      if (!this.#destroyed && this.#eventTarget) {
        this.#eventTarget.dispatchEvent(pooledScrubEvent());
      }
    }
    #handlePointerUp(event) {
      this.#pointers.delete(event.pointerId);
      if (this.#pinchStartDistance > 0 && this.#pointers.size < 2) {
        this.#pinchStartDistance = 0;
        this.#pinchFired = false;
        this.#pinchZone = null;
      }
      if (this.#primaryPointerId === null || event.pointerId !== this.#primaryPointerId) {
        return;
      }
      this.#clearHoldTimer();
      const elapsed = performance.now() - this.#startTime;
      const dx = event.clientX - this.#startX;
      const dy = event.clientY - this.#startY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (this.#holding) {
        this.#holding = false;
        this.#suppressNextActivations();
        event.stopImmediatePropagation();
        this.#dispatch(GESTURE_EVENTS.release, {
          zone: this.#gestureZone,
          method: "pointer",
          duration: elapsed
        });
      } else if (this.#scrubbing) {
        this.#scrubbing = false;
        this.#gestureFsActive = false;
        this.#suppressNextActivations();
        event.stopImmediatePropagation();
        this.#dispatch(GESTURE_EVENTS.scrubEnd, {
          zone: this.#gestureZone || "screen",
          method: "pointer"
        });
      } else if (this.#swiping) {
        this.#swiping = false;
        this.#gestureFsActive = false;
        this.#suppressNextActivations();
        event.stopImmediatePropagation();
        this.#restoreTransform();
        this.#dispatch(GESTURE_EVENTS.swipe, {
          zone: this.#gestureZone || "screen",
          method: "pointer",
          direction: this.#swipeDirection,
          distance
        });
        this.#swipeDirection = null;
        this.#lastSwipeDrag = NaN;
        this.#lastSwipeTransform = "";
      } else if (elapsed < HOLD_TIMEOUT_MS && this.#gestureZone !== null && allowsIntent("dbltap")) {
        const now = performance.now();
        if (now - this.#lastTapTime < DOUBLE_TAP_WINDOW_MS) {
          this.#lastTapTime = -Infinity;
          this.#suppressNextActivations();
          this.#dispatch(GESTURE_EVENTS.dbltap, { zone: this.#gestureZone, method: "pointer" });
        } else {
          this.#lastTapTime = now;
        }
      }
      this.#primaryPointerId = null;
      this.#gestureZone = null;
    }
    #handlePointerCancel(event) {
      this.#pointers.delete(event.pointerId);
      if (this.#pinchStartDistance > 0 && this.#pointers.size < 2) {
        this.#pinchStartDistance = 0;
        this.#pinchFired = false;
        this.#pinchZone = null;
      }
      if (this.#primaryPointerId === null || event.pointerId !== this.#primaryPointerId) {
        return;
      }
      this.#endPointerSession();
      this.#primaryPointerId = null;
      this.#gestureZone = null;
    }
    #handleClickCapture(event) {
      if (clickTime(event) < this.#suppressClickUntil) {
        this.#suppressClickUntil = 0;
        event.stopImmediatePropagation();
        event.preventDefault();
      }
    }
    #handleDblClickCapture(event) {
      if (clickTime(event) < this.#suppressClickUntil) {
        this.#suppressClickUntil = 0;
        event.stopImmediatePropagation();
        event.preventDefault();
      }
    }
    #handleWheelCapture(event) {
      if (fs && event.ctrlKey && !event.momentum && allowsIntent("pinch")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (performance.now() >= this.#trackpadPinchCooldownUntil) {
          this.#trackpadPinchCooldownUntil = performance.now() + TRACKPAD_COOLDOWN_MS;
          this.#suppressNextActivations();
          this.#dispatch(GESTURE_EVENTS.pinch, {
            zone: "screen",
            method: "trackpad",
            direction: event.deltaY < 0 ? "out" : "in"
          });
        }
      }
    }
    /**
     * Space is absent from the binding table on purpose: it carries hold-to-
     * speed semantics and intentionally ignores the hotkeys toggle. The
     * capture-phase keydown preventDefault cancels the UA's own Space-activates-
     * video default so it cannot fight the hold, and a bare tap toggles play/
     * pause on the real keyup.
     */
    #handleKeydown(event) {
      if (event.repeat) {
        return;
      }
      if (event.code === "Space") {
        if (this.#shouldHandleKeys(false)) {
          lastActiveForge = this;
          event.preventDefault();
          this.#keyboardHoldStart = performance.now();
          this.#keyboardHolding = false;
          clearTimeout(this.#keyboardHoldTimer);
          this.#keyboardHoldTimer = setTimeout(() => {
            this.#keyboardHoldTimer = null;
            if (!this.#video.paused && allowsIntent("hold")) {
              this.#keyboardHolding = true;
              this.#dispatch(GESTURE_EVENTS.hold, {
                zone: "screen",
                method: "keyboard",
                duration: performance.now() - this.#keyboardHoldStart
              });
            }
          }, HOLD_TIMEOUT_MS);
        }
        return;
      }
      for (const binding of KEY_BINDINGS) {
        if (binding.code !== event.code) {
          continue;
        }
        if (!isKeyArmed(binding)) {
          continue;
        }
        if (!this.#shouldHandleKeys(!!binding.allowControlFocus)) {
          continue;
        }
        lastActiveForge = this;
        event.preventDefault();
        event.stopImmediatePropagation();
        const detail = { method: "keyboard" };
        if (binding.direction) {
          detail.direction = binding.direction;
        }
        this.#dispatch(binding.emit, detail);
        return;
      }
    }
    #handleKeyup(event) {
      if (event.code !== "Space") {
        return;
      }
      this.#finishKeyboardHold(true);
    }
    /**
     * End a Space session: an active hold always releases (restoring playback
     * rate via the action layer), a bare tap toggles play/pause - but only on
     * a real keyup. Blur finishes silently-with-release and never toggles.
     */
    #finishKeyboardHold(allowToggle) {
      const wasHolding = this.#keyboardHolding;
      const shouldToggle = allowToggle && !wasHolding && this.#shouldHandleKeys();
      clearTimeout(this.#keyboardHoldTimer);
      this.#keyboardHoldTimer = null;
      this.#keyboardHolding = false;
      if (wasHolding) {
        this.#dispatch(GESTURE_EVENTS.release, {
          zone: "screen",
          method: "keyboard",
          duration: performance.now() - this.#keyboardHoldStart
        });
      } else if (shouldToggle) {
        if (this.#video.paused) {
          this.#video.play().catch((err) => {
            if (err.name !== "AbortError" && err.name !== "NotAllowedError") {
              logger.log("forge", "bare-tap play rejected:", err.name);
            }
          });
        } else {
          this.#video.pause();
        }
      }
    }
  };

  // src/shared/context.js
  var CTX_REQUEST_TYPE = "pf:ctx-request";
  var CTX_RESPONSE_TYPE = "pf:ctx";
  var FS_REQUEST_TYPE = "pf:req-fullscreen";
  var DOMAIN_TLDS = {
    multi: /* @__PURE__ */ new Set(["co", "com", "org", "net", "gov", "edu", "ac", "mil"]),
    single: /* @__PURE__ */ new Set([
      "biz",
      "info",
      "name",
      "mobi",
      "asia",
      "tel",
      "travel",
      "jobs",
      "museum",
      "coop",
      "aero",
      "app",
      "blog",
      "dev",
      "fun",
      "game",
      "host",
      "live",
      "love",
      "new",
      "news",
      "one",
      "online",
      "page",
      "park",
      "plus",
      "pro",
      "shop",
      "site",
      "store",
      "tech",
      "video",
      "work",
      "xyz",
      "club",
      "life",
      "world",
      "today",
      "tools",
      "social",
      "beer",
      "email",
      "space",
      "cool",
      "social",
      "games",
      "legal",
      "luxury",
      "fans",
      "buzz",
      "country",
      "kim",
      "pub",
      "rest"
    ])
  };
  var IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
  var DOMAIN_KEY_CACHE_MAX = 256;
  var domainKeyCache = /* @__PURE__ */ new Map();
  function getDomainKey(hostname) {
    if (!hostname) {
      return "";
    }
    if (domainKeyCache.has(hostname)) {
      return domainKeyCache.get(hostname);
    }
    let key;
    if (IPV4_RE.test(hostname)) {
      key = hostname.replaceAll(".", "-");
    } else if (hostname.includes(":")) {
      key = hostname.replace(/[\\[\]:]+/g, "-").replace(/^-+|-+$/g, "") || "ipv6";
    } else {
      const parts = hostname.toLowerCase().replace(/^www\./, "").split(".");
      const multiPartTlds = DOMAIN_TLDS.multi;
      const singleLabelTlds = DOMAIN_TLDS.single;
      let idx = parts.length - 1;
      if (parts[idx] && (parts[idx].length <= 3 || singleLabelTlds.has(parts[idx]))) {
        idx--;
      }
      if (parts[idx] && multiPartTlds.has(parts[idx])) {
        idx--;
      }
      if (idx === parts.length - 1 && parts.length >= 2) {
        idx--;
      }
      key = parts[Math.max(0, idx)] || "";
    }
    domainKeyCache.set(hostname, key);
    if (domainKeyCache.size > DOMAIN_KEY_CACHE_MAX) {
      const evict = Math.ceil(DOMAIN_KEY_CACHE_MAX / 4);
      let i = 0;
      for (const k of domainKeyCache.keys()) {
        domainKeyCache.delete(k);
        if (++i >= evict) break;
      }
    }
    return key;
  }
  function boundaryContains(a, b) {
    return a.startsWith(`${b}.`) || a.endsWith(`.${b}`) || b.startsWith(`${a}.`) || b.endsWith(`.${a}`);
  }
  var distRows = null;
  var distRowLen = 0;
  function ensureDistRows(len) {
    if (!distRows || distRowLen < len + 1) {
      distRows = [new Int32Array(len + 1), new Int32Array(len + 1)];
      distRowLen = len + 1;
    }
  }
  function boundedLevenshtein(a, b, max = Infinity) {
    const lenA = a.length;
    const lenB = b.length;
    if (Math.abs(lenA - lenB) > max) {
      return max + 1;
    }
    let rows = a;
    let cols = b;
    if (lenB > lenA) {
      rows = b;
      cols = a;
    }
    const m = cols.length;
    ensureDistRows(m);
    let prev = distRows[0];
    let curr = distRows[1];
    for (let j = 0; j <= m; j++) {
      prev[j] = j;
    }
    for (let i = 1; i <= rows.length; i++) {
      curr[0] = i;
      let rowMin = i;
      const ch = rows[i - 1];
      for (let j = 1; j <= m; j++) {
        const cost = ch === cols[j - 1] ? 0 : 1;
        const v = cost === 0 ? prev[j - 1] : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
        curr[j] = v;
        if (v < rowMin) {
          rowMin = v;
        }
      }
      if (rowMin > max) {
        return max + 1;
      }
      const tmp = prev;
      prev = curr;
      curr = tmp;
    }
    return prev[m];
  }
  function domainsMatch(a, b) {
    if (!a || !b) {
      return false;
    }
    return a === b || boundaryContains(a, b);
  }
  function domainScore(a, b) {
    if (!a || !b) {
      return 0;
    }
    if (a === b) {
      return 3;
    }
    if (boundaryContains(a, b)) {
      return 2;
    }
    return Math.max(0, 3 - boundedLevenshtein(a, b, 3));
  }
  function hashEntry(domainKey, path, duration) {
    let hash = 5381;
    for (let i = 0; i < domainKey.length; i++) {
      hash = (hash << 5) + hash + domainKey.charCodeAt(i) | 0;
    }
    hash = (hash << 5) + hash + 58 | 0;
    hash = (hash << 5) + hash + 58 | 0;
    for (let i = 0; i < path.length; i++) {
      hash = (hash << 5) + hash + path.charCodeAt(i) | 0;
    }
    hash = (hash << 5) + hash + 58 | 0;
    hash = (hash << 5) + hash + 58 | 0;
    const dur = String(Math.round(duration));
    for (let i = 0; i < dur.length; i++) {
      hash = (hash << 5) + hash + dur.charCodeAt(i) | 0;
    }
    return (hash < 0 ? -hash : hash).toString(36).substring(0, 8);
  }
  var TITLE_TAGS = /(?:^|[- ])(?:uncensored|uncut|leaked|censored|raw|bd|hdrip|dvdrip|webrip|bluray|remux|cam|reduc(?:ing)?\s*mosaic|english\s*subtitle)/gi;
  var RECORDING_CODE_RE = /^\[([A-Z]+-\d+)(?:-[^\]]*)?\]/;
  var BRACKET_STRIP_RE = /\[[^\]]*\]/g;
  var EN_DASH_RE = /[\u2013\u2014]/g;
  var NON_LATIN_RE = /[^\p{Script=Latin}\p{Script=Common}]+/gu;
  var WS_COLLAPSE_RE = /\s{2,}/g;
  var LEAD_PUNCT_RE = /^[\s\-–—|·:,/]+/;
  var TRAIL_PUNCT_RE = /[\s\-–—|·:,/]+$/;
  function stripNonAscii(raw) {
    if (!raw) return "";
    let code = "";
    const codeMatch = raw.match(RECORDING_CODE_RE);
    if (codeMatch) {
      code = `[${codeMatch[1]}]`;
      raw = raw.slice(codeMatch[0].length);
    }
    let s = raw;
    s = s.replace(BRACKET_STRIP_RE, " ");
    s = s.replace(TITLE_TAGS, " ");
    s = s.replace(EN_DASH_RE, " ");
    s = s.replace(NON_LATIN_RE, " ");
    s = s.replace(WS_COLLAPSE_RE, " ").replace(LEAD_PUNCT_RE, "").replace(TRAIL_PUNCT_RE, "").trim();
    if (code) {
      return `${code} ${s}`.trim();
    }
    return s || raw;
  }
  var frameContextBridge = null;
  function ownPageContext(win = window) {
    return {
      domain: getDomainKey(win.location.hostname),
      path: win.location.pathname,
      title: stripNonAscii(win.document?.title ?? "")
    };
  }
  async function getPageContext() {
    if (window.top === window) {
      return ownPageContext();
    }
    try {
      return ownPageContext(window.top);
    } catch {
      if (!frameContextBridge) {
        frameContextBridge = requestPageContextFromParent();
        frameContextBridge.then(
          () => {
            frameContextBridge = null;
          },
          () => {
            frameContextBridge = null;
          }
        );
      }
      const bridged = await frameContextBridge;
      return bridged ?? ownPageContext();
    }
  }
  var CTX_RETRY_BACKOFF = [60, 150, 320, 640];
  var CTX_RETRY_JITTER_MS = 250;
  var contextPipe = null;
  var legacyChain = false;
  function requestPageContextOverPipe(timeoutMs, deadline) {
    const { promise, resolve } = Promise.withResolvers();
    const ac = new AbortController();
    const pipe = contextPipe;
    let settled = false;
    let answered = false;
    const settle = (context) => {
      if (settled) {
        return;
      }
      settled = true;
      ac.abort();
      resolve(context);
    };
    const onData = (event) => {
      const data = event.data;
      if (answered) {
        return;
      }
      if (data && typeof data === "object" && data.type === CTX_RESPONSE_TYPE && typeof data.domain === "string") {
        answered = true;
        settle({
          domain: data.domain,
          path: data.path,
          title: stripNonAscii(typeof data.title === "string" ? data.title : "")
        });
      }
    };
    let signal;
    try {
      signal = AbortSignal.any([ac.signal, AbortSignal.timeout(timeoutMs)]);
    } catch {
      signal = null;
    }
    const dropDeadPipe = () => {
      if (contextPipe === pipe) {
        contextPipe = null;
        try {
          pipe.port.close();
        } catch {
        }
      }
    };
    if (signal) {
      signal.addEventListener("abort", () => {
        if (answered) {
          return;
        }
        dropDeadPipe();
        settle(null);
      }, { once: true });
    } else {
      const timer = setTimeout(() => {
        if (answered) {
          return;
        }
        dropDeadPipe();
        ac.abort();
        settle(null);
      }, Math.max(0, deadline - Date.now()));
      ac.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    }
    pipe.port.addEventListener("message", onData, { signal: ac.signal });
    try {
      pipe.port.postMessage({ type: CTX_REQUEST_TYPE, nonce: crypto.randomUUID() });
    } catch {
      dropDeadPipe();
      settle(null);
    }
    return promise;
  }
  function requestPageContextFromParent(timeoutMs = CTX_REQUEST_TIMEOUT_MS) {
    if (contextPipe) {
      return requestPageContextOverPipe(timeoutMs, Date.now() + timeoutMs);
    }
    const { promise, resolve } = Promise.withResolvers();
    const ac = new AbortController();
    let nonce = null;
    let retryTimer = null;
    let attemptCount = 0;
    let replyPort = null;
    let transferPort = null;
    let settled = false;
    let signal;
    let useSignalAny = false;
    try {
      signal = AbortSignal.any([ac.signal, AbortSignal.timeout(timeoutMs)]);
      useSignalAny = true;
    } catch {
      signal = ac.signal;
    }
    const deadline = useSignalAny ? 0 : Date.now() + timeoutMs;
    const settle = (context, viaPort) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(retryTimer);
      ac.abort();
      if (replyPort) {
        if (viaPort) {
          importMarshalPipe(replyPort);
          legacyChain = false;
        } else {
          try {
            replyPort.removeEventListener("message", onReplyPort);
            replyPort.close();
          } catch {
          }
        }
      }
      resolve(context);
    };
    const onReplyPort = (event) => {
      const data = event.data;
      if (data && typeof data === "object" && data.type === CTX_RESPONSE_TYPE && typeof data.domain === "string") {
        settle({
          domain: data.domain,
          path: data.path,
          title: stripNonAscii(typeof data.title === "string" ? data.title : "")
        }, true);
      }
    };
    if (!legacyChain && typeof MessageChannel === "function") {
      try {
        const mc = new MessageChannel();
        replyPort = mc.port1;
        transferPort = mc.port2;
        replyPort.addEventListener("message", onReplyPort);
        replyPort.start();
      } catch {
        replyPort = null;
        transferPort = null;
      }
    }
    const onMessage = (event) => {
      const data = event.data;
      if (event.source === window.parent && data && typeof data === "object" && data.type === CTX_RESPONSE_TYPE && data.nonce === nonce && typeof data.domain === "string") {
        legacyChain = true;
        settle({
          domain: data.domain,
          path: data.path,
          title: stripNonAscii(typeof data.title === "string" ? data.title : "")
        }, false);
      }
    };
    if (useSignalAny) {
      signal.addEventListener("abort", () => {
        settle(null, false);
      }, { once: true });
    }
    window.addEventListener("message", onMessage, { signal });
    let portAttached = false;
    const sendRequest = () => {
      nonce = crypto.randomUUID();
      const msg = { type: CTX_REQUEST_TYPE, nonce };
      if (transferPort && !portAttached) {
        try {
          window.parent.postMessage(msg, "*", [transferPort]);
          portAttached = true;
          return;
        } catch {
          transferPort = null;
        }
      }
      window.parent.postMessage(msg, "*");
    };
    const attempt = () => {
      if (useSignalAny ? signal.aborted : Date.now() >= deadline) {
        if (!useSignalAny) ac.abort();
        settle(null, false);
        return;
      }
      sendRequest();
      const base = CTX_RETRY_BACKOFF[Math.min(attemptCount, CTX_RETRY_BACKOFF.length - 1)];
      attemptCount++;
      retryTimer = setTimeout(attempt, base + Math.floor(Math.random() * (CTX_RETRY_JITTER_MS + 1)));
    };
    attempt();
    return promise;
  }
  function importMarshalPipe(port) {
    if (contextPipe) {
      try {
        contextPipe.port.close();
      } catch {
      }
    }
    contextPipe = { port };
  }
  function stopContextPipe() {
    if (contextPipe) {
      try {
        contextPipe.port.close();
      } catch {
      }
    }
    contextPipe = null;
    legacyChain = false;
  }
  var NONCE_TTL_MS = 5e3;
  var CTX_REQUEST_TIMEOUT_MS = 3e3;
  var CTX_PIPE_IDLE_MS = 6e4;
  function createTopFrameResponder(resolveContext, ownOrigin = location.origin, post = defaultPostToSource) {
    const pipePorts = /* @__PURE__ */ new Set();
    const pipeEntryByPort = /* @__PURE__ */ new Map();
    const dropPipe = (entry) => {
      if (!pipePorts.delete(entry)) {
        return;
      }
      pipeEntryByPort.delete(entry.port);
      entry.port.removeEventListener("message", entry.handler);
      entry.port.removeEventListener("messageerror", entry.onError);
      entry.port.close();
    };
    const touchPipe = (entry) => {
      entry.lastUsed = performance.now();
      const cutoff = entry.lastUsed - CTX_PIPE_IDLE_MS;
      for (const candidate of pipePorts) {
        if (candidate.lastUsed < cutoff) {
          dropPipe(candidate);
        }
      }
    };
    const onPipeRequest = (entry) => (event) => {
      touchPipe(entry);
      const data = event.data;
      if (!data || typeof data !== "object" || data.type !== CTX_REQUEST_TYPE || typeof data.nonce !== "string") {
        return;
      }
      const { domain, path, title } = resolveContext();
      try {
        entry.port.postMessage({ type: CTX_RESPONSE_TYPE, domain, path, title });
      } catch {
        dropPipe(entry);
      }
    };
    return (event) => {
      const data = event && event.data;
      if (!data || typeof data !== "object" || data.type !== CTX_REQUEST_TYPE || typeof data.nonce !== "string" || !event.source) {
        return;
      }
      if (event.origin !== ownOrigin && !isOwnFrame(event.source)) {
        return;
      }
      const { domain, path, title } = resolveContext();
      const ports = event.ports || [];
      if (ports.length) {
        const port = ports[0];
        let entry = pipeEntryByPort.get(port);
        if (!entry) {
          entry = { port, lastUsed: performance.now(), handler: null, onError: null };
          entry.handler = onPipeRequest(entry);
          entry.onError = () => dropPipe(entry);
          port.addEventListener("message", entry.handler);
          port.addEventListener("messageerror", entry.onError);
          port.start();
          pipeEntryByPort.set(port, entry);
          pipePorts.add(entry);
        }
        try {
          port.postMessage({ type: CTX_RESPONSE_TYPE, domain, path, title });
          return;
        } catch {
          dropPipe(entry);
        }
      }
      post(event.source, {
        type: CTX_RESPONSE_TYPE,
        nonce: data.nonce,
        domain,
        path,
        title
      }, event.origin || "*");
    };
  }
  function defaultPostToSource(source, message, origin) {
    source.postMessage(message, origin);
  }
  function createFrameRelay() {
    const pending = /* @__PURE__ */ new Map();
    return (event) => {
      const data = event && event.data;
      if (!data || typeof data !== "object") {
        return;
      }
      if (data.type === CTX_REQUEST_TYPE && typeof data.nonce === "string" && event.source) {
        if (!iframeElementForWindow(event.source)) {
          return;
        }
        const now = Date.now();
        for (const [nonce, entry] of pending) {
          if (entry.deadline < now) {
            pending.delete(nonce);
          }
        }
        pending.set(data.nonce, { source: event.source, origin: event.origin, deadline: now + NONCE_TTL_MS });
        const ports = event.ports || [];
        try {
          window.parent.postMessage(data, "*", ports.length ? ports : void 0);
        } catch {
          window.parent.postMessage(data, "*");
        }
      } else if (data.type === CTX_RESPONSE_TYPE && pending.has(data.nonce)) {
        if (event.source !== window.parent) {
          return;
        }
        const requester = pending.get(data.nonce);
        pending.delete(data.nonce);
        requester.source?.postMessage(data, requester.origin || "*");
      }
    };
  }
  function isOwnFrame(source) {
    const scan = (doc, depth) => {
      if (depth > 4) {
        return false;
      }
      for (const iframe of doc.querySelectorAll("iframe")) {
        if (iframe.contentWindow === source) {
          return true;
        }
        try {
          const nested = iframe.contentDocument;
          if (nested && scan(nested, depth + 1)) {
            return true;
          }
        } catch {
        }
      }
      return false;
    };
    return scan(document, 0);
  }
  var iframeCache = /* @__PURE__ */ new Map();
  var iframeCacheDoc = null;
  var iframeCacheActive = false;
  var iframeCacheObserver = null;
  function seedIframeCache() {
    iframeCache.clear();
    for (const ifr of document.querySelectorAll("iframe")) {
      const win = ifr.contentWindow;
      if (win) {
        iframeCache.set(win, ifr);
      }
    }
  }
  function registerIframe(ifr) {
    const win = ifr.contentWindow;
    if (win) {
      iframeCache.set(win, ifr);
    }
  }
  function collectIframes(node) {
    if (!node || node.nodeType !== 1) {
      return;
    }
    if (node.localName === "iframe") {
      registerIframe(node);
      return;
    }
    const set = node.querySelectorAll("iframe");
    for (let i = 0; i < set.length; i++) {
      registerIframe(set[i]);
    }
  }
  function diffIframeCache(records) {
    for (const record of records) {
      const added = record.addedNodes;
      for (let i = 0; i < added.length; i++) {
        collectIframes(added[i]);
      }
    }
    for (const [win, ifr] of iframeCache) {
      if (!ifr.isConnected) {
        iframeCache.delete(win);
      }
    }
  }
  function startIframeCache(ac) {
    if (typeof MutationObserver !== "function") {
      return;
    }
    if (iframeCacheActive && iframeCacheDoc === document) {
      return;
    }
    if (iframeCacheActive) {
      stopIframeCache();
    }
    seedIframeCache();
    iframeCacheDoc = document;
    iframeCacheActive = true;
    iframeCacheObserver = new MutationObserver(diffIframeCache);
    try {
      iframeCacheObserver.observe(document.documentElement || document, { childList: true, subtree: true });
    } catch {
      stopIframeCache();
      return;
    }
    ac.signal.addEventListener("abort", () => {
      stopIframeCache();
    }, { once: true });
  }
  function stopIframeCache() {
    iframeCacheObserver?.disconnect();
    iframeCacheObserver = null;
    iframeCacheActive = false;
    iframeCacheDoc = null;
  }
  function ensureIframeCacheCurrent() {
    if (!iframeCacheActive || iframeCacheDoc === document) {
      return;
    }
    if (typeof MutationObserver !== "function") {
      stopIframeCache();
      return;
    }
    iframeCacheObserver?.disconnect();
    seedIframeCache();
    iframeCacheDoc = document;
    try {
      iframeCacheObserver = new MutationObserver(diffIframeCache);
      iframeCacheObserver.observe(document.documentElement, { childList: true, subtree: true });
    } catch {
      stopIframeCache();
    }
  }
  function iframeElementForWindow(win) {
    if (!win) {
      return null;
    }
    if (iframeCacheActive) {
      ensureIframeCacheCurrent();
      return iframeCache.get(win) || null;
    }
    for (const iframe of document.querySelectorAll("iframe")) {
      if (iframe.contentWindow === win) {
        return iframe;
      }
    }
    return null;
  }
  function grantFullscreen(frameElement) {
    if (!frameElement.hasAttribute("allowfullscreen")) {
      frameElement.setAttribute("allowfullscreen", "");
    }
    const allow = frameElement.getAttribute("allow") || "";
    if (!/(?:^|\s)fullscreen(?:\s|$)/.test(allow)) {
      frameElement.setAttribute("allow", `${allow ? `${allow} ` : ""}fullscreen`);
    }
    return frameElement;
  }
  var fullscreenProvisionSent = false;
  function requestFullscreenProvision() {
    if (fullscreenProvisionSent) {
      return;
    }
    fullscreenProvisionSent = true;
    window.parent?.postMessage({ type: FS_REQUEST_TYPE }, "*");
  }
  function createTopFrameProvisioner() {
    return (event) => {
      const data = event && event.data;
      if (!data || typeof data !== "object" || data.type !== FS_REQUEST_TYPE) {
        return;
      }
      const frameElement = iframeElementForWindow(event.source);
      if (frameElement) {
        grantFullscreen(frameElement);
      }
    };
  }
  function createFrameProvisioner() {
    return (event) => {
      const data = event && event.data;
      if (!data || typeof data !== "object" || data.type !== FS_REQUEST_TYPE) {
        return;
      }
      const frameElement = iframeElementForWindow(event.source);
      if (frameElement) {
        grantFullscreen(frameElement);
        window.parent?.postMessage(data, "*");
      }
    };
  }
  function installContextBridge() {
    const ac = new AbortController();
    const maybeStartIframeCache = () => {
      if (!iframeCacheActive || iframeCacheDoc !== document) {
        startIframeCache(ac);
      }
    };
    window.addEventListener("message", maybeStartIframeCache, { signal: ac.signal });
    const handlers = window === window.top ? [
      createTopFrameResponder(() => ({
        domain: getDomainKey(location.hostname),
        path: location.pathname,
        title: stripNonAscii(document.title)
      })),
      createTopFrameProvisioner()
    ] : [
      createFrameRelay(),
      createFrameProvisioner()
    ];
    for (const handler of handlers) {
      window.addEventListener("message", handler, { signal: ac.signal });
    }
    return () => {
      ac.abort();
      stopContextPipe();
    };
  }

  // src/shell/resume.js
  function sortByUpdatedAt(entries, descending = false) {
    return [...entries].sort((a, b) => {
      const diff = (a.updatedAt || 0) - (b.updatedAt || 0);
      return descending ? -diff : diff;
    });
  }
  var RESUME_STALE_DAYS = TUNING.resume.staleDays;
  var RESUME_MAX_ENTRIES = TUNING.resume.maxEntries;
  var RESUME_DURATION_FUZZ = TUNING.resume.durationFuzz;
  var RESUME_METADATA_WAIT_MS = TUNING.resume.metadataWaitMs;
  var RESUME_MIN_POSITION = TUNING.resume.minPosition;
  var RESUME_SAVE_EPSILON_S = TUNING.resume.saveEpsilonSeconds;
  var RESUME_COMPLETION_RATIO = TUNING.resume.completionRatio;
  var RESUME_ENTRY_FIELDS = /* @__PURE__ */ new Set([
    "id",
    "domain",
    "path",
    "title",
    "duration",
    "resume",
    "createdAt",
    "updatedAt",
    "pending"
  ]);
  function isValidStore(raw) {
    return raw && typeof raw === "object" && Array.isArray(raw.entries);
  }
  var ResumeStore = class {
    #state = null;
    #loaded = false;
    #listenerId = null;
    #listeners = /* @__PURE__ */ new Set();
    /**
     * Subscribe to store changes. The callback receives a `structural` flag -
     * true when the entry SET changed (create/remove/import/cross-tab merge),
     * false for pure position/timestamp updates. Returns an unsubscribe fn.
     * Consumers that snapshot the whole list (History) re-render on structural
     * changes only; position-only persists stay invisible to them.
     */
    onChange(cb) {
      this.#listeners.add(cb);
      return () => this.#listeners.delete(cb);
    }
    #notify(structural = false) {
      for (const cb of this.#listeners) {
        cb(structural);
      }
    }
    constructor() {
      this.#listenerId = gmAddValueChangeListener(KEYS.resume, () => this.#adoptExternal());
    }
    /** Release the cross-tab change subscription (SPA re-entry / shell teardown). */
    destroy() {
      gmRemoveValueChangeListener(this.#listenerId);
      this.#listenerId = null;
      this.#listeners.clear();
    }
    #adoptExternal() {
      if (!this.#loaded) {
        return;
      }
      const raw = loadJsonObject(KEYS.resume, null);
      if (isValidStore(raw)) {
        const { added, updated } = this.#mergeRaw(raw);
        if (added || updated) {
          this.#notify(true);
        }
      }
    }
    #mergeRaw(raw) {
      let added = 0;
      let updated = 0;
      const byId = /* @__PURE__ */ new Map();
      for (const entry of this.#state.entries) {
        byId.set(entry.id, entry);
      }
      for (const incoming of raw.entries) {
        if (!incoming || typeof incoming !== "object" || typeof incoming.id !== "string") {
          continue;
        }
        const known = byId.get(incoming.id);
        if (!known) {
          const filtered = {};
          for (const key of RESUME_ENTRY_FIELDS) {
            if (key in incoming) {
              filtered[key] = incoming[key];
            }
          }
          filtered.id = incoming.id;
          byId.set(incoming.id, filtered);
          added++;
        } else if ((incoming.updatedAt || 0) > (known.updatedAt || 0)) {
          for (const key of RESUME_ENTRY_FIELDS) {
            if (key in incoming) {
              known[key] = incoming[key];
            }
          }
          updated++;
        }
      }
      if (added === 0 && updated === 0) {
        return { added, updated };
      }
      this.#state.entries = [...byId.values()];
      return { added, updated };
    }
    ensureLoaded() {
      if (this.#loaded) {
        return;
      }
      const raw = loadJsonObject(KEYS.resume, null);
      if (isValidStore(raw)) {
        const valid = raw.entries.filter((entry) => entry && typeof entry === "object" && typeof entry.id === "string");
        if (valid.length !== raw.entries.length) {
          logger.warn("resume", `Dropped ${raw.entries.length - valid.length} malformed entries`);
        }
        this.#state = { ...raw, version: 1, entries: valid };
      } else {
        this.#state = { version: 1, entries: [] };
        gmSetValue(KEYS.resume, this.#state);
        logger.warn("resume", "Resume store missing or corrupt - reset");
      }
      const stalePending = this.#state.entries.filter((entry) => entry.pending).length;
      if (stalePending) {
        this.#state.entries = this.#state.entries.filter((entry) => !entry.pending);
        this.#state.updatedAt = Date.now();
        gmSetValue(KEYS.resume, this.#state);
        logger.log("resume", `Dropped ${stalePending} stale pending entries`);
      }
      this.#loaded = true;
    }
    /**
     * Store-level invariants over the current entries: age pruning plus the
     * hard entry cap (oldest evicted). Returns a fresh array; callers assign.
     */
    #enforceBounds(days = RESUME_STALE_DAYS) {
      const entries = this.#state.entries;
      if (entries.length <= RESUME_MAX_ENTRIES) {
        const cutoff2 = Date.now() - days * 864e5;
        for (let i = 0; i < entries.length; i++) {
          if (entries[i].updatedAt <= cutoff2) {
            return entries.filter((e) => e.updatedAt > cutoff2);
          }
        }
        return entries;
      }
      const cutoff = Date.now() - days * 864e5;
      const kept = entries.filter((entry) => entry.updatedAt > cutoff);
      kept.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
      return kept.slice(kept.length - RESUME_MAX_ENTRIES);
    }
    #persist(structural = false) {
      try {
        const raw = loadJsonObject(KEYS.resume, null);
        if (isValidStore(raw)) {
          this.#mergeRaw(raw);
        }
        this.#state.entries = this.#enforceBounds();
        this.#state.updatedAt = Date.now();
        gmSetValue(KEYS.resume, this.#state);
        this.#notify(structural);
      } catch (err) {
        logger.error("resume", "Failed to persist resume store:", err);
      }
    }
    findMatch(domainKey, path, duration) {
      this.ensureLoaded();
      const targetDuration = Number(duration) || NaN;
      const maxFuzz = RESUME_DURATION_FUZZ;
      let best = null;
      let bestScore = -Infinity;
      for (const entry of this.#state.entries) {
        if (entry.path !== path || entry.pending || !domainsMatch(entry.domain, domainKey)) {
          continue;
        }
        const fuzz = Math.abs(entry.duration - targetDuration);
        if (fuzz > maxFuzz || Number.isNaN(fuzz)) {
          continue;
        }
        const score = 4e6 + domainScore(entry.domain, domainKey) * 1e3 - Math.min(fuzz, 999);
        if (score > bestScore) {
          bestScore = score;
          best = entry;
        }
      }
      return best;
    }
    createEntry(domainKey, path, title, duration) {
      this.ensureLoaded();
      const id = hashEntry(domainKey, path, duration);
      const existingById = this.#state.entries.find((entry2) => entry2.id === id);
      if (existingById && domainsMatch(existingById.domain, domainKey)) {
        return existingById;
      }
      const existingByMatch = this.findMatch(domainKey, path, duration);
      if (existingByMatch) {
        return existingByMatch;
      }
      const entry = {
        id,
        domain: domainKey,
        path,
        // NFC so stored titles compare equal regardless of source encoding.
        title: (title || "").normalize("NFC"),
        duration: Number(duration) || NaN,
        resume: 0,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      this.#state.entries.push(entry);
      this.#persist(true);
      return entry;
    }
    updateResume(id, position) {
      this.ensureLoaded();
      const entry = this.#state.entries.find((candidate) => candidate.id === id);
      if (entry) {
        entry.resume = position;
        entry.updatedAt = Date.now();
        this.#persist();
      }
    }
    getEntries() {
      this.ensureLoaded();
      return sortByUpdatedAt(this.#state.entries, true);
    }
    removeEntry(id) {
      this.ensureLoaded();
      const before = this.#state.entries.length;
      this.#state.entries = this.#state.entries.filter((entry) => entry.id !== id);
      if (this.#state.entries.length < before) {
        this.#persist(true);
      }
    }
    cleanStale(days = RESUME_STALE_DAYS) {
      this.ensureLoaded();
      const before = this.#state.entries.length;
      this.#state.entries = this.#enforceBounds(days);
      const removed = before - this.#state.entries.length;
      if (removed > 0) {
        this.#persist(true);
        logger.log("resume", `Pruned ${removed} resume entries`);
      }
    }
    /** Whole-store JSON snapshot for the clipboard bridge and backups. */
    exportData() {
      this.ensureLoaded();
      return JSON.stringify(this.#state);
    }
    /**
     * Merge a previously exported JSON document via LWW. Returns
     * {added, updated} counts, or null when the text is not a data document.
     */
    importData(text) {
      this.ensureLoaded();
      let raw;
      try {
        raw = JSON.parse(text);
      } catch {
        return null;
      }
      if (!isValidStore(raw)) {
        return null;
      }
      const result = this.#mergeRaw(raw);
      if (result.added || result.updated) {
        this.#persist(true);
      }
      return result;
    }
  };
  var ResumeTracker = class {
    #shell;
    #store = new ResumeStore();
    #entry = null;
    /** Every media listener this tracker attaches dies with this signal. */
    #scope = new AbortController();
    /** Eagerly resolved context promise — kicked off in the constructor. */
    #contextPromise;
    #lastSavedPosition = 0;
    /** Wall-clock floor for persists - keeps the write cadence bounded. */
    #lastSavedWall = 0;
    /** Off-screen save gate observer; disconnected in destroy(). */
    #intersectionObserver = null;
    #destroyed = false;
    constructor(shell) {
      this.#shell = shell;
      this.#contextPromise = getPageContext();
      this.#store.ensureLoaded();
      this.#init().catch((err) => logger.error("resume", "Init failed:", err));
    }
    async #init() {
      const shell = this.#shell;
      const context = await this.#contextPromise;
      if (!context) {
        logger.log("resume", "Top context unavailable - skipping");
        return;
      }
      const video = shell.video;
      if (!video.duration || !isFinite(video.duration)) {
        const { signal } = this.#scope;
        const { promise: metadataReady, resolve: resolveMetadata } = Promise.withResolvers();
        const finishWaiting = () => resolveMetadata();
        const onDurationChange = () => {
          if (video.duration && isFinite(video.duration)) {
            finishWaiting();
          }
        };
        const onLoaded = () => finishWaiting();
        const onError = () => finishWaiting();
        let waitSignal;
        try {
          waitSignal = AbortSignal.any([signal, AbortSignal.timeout(RESUME_METADATA_WAIT_MS)]);
        } catch {
          waitSignal = signal;
          const timeoutHandle = setTimeout(finishWaiting, RESUME_METADATA_WAIT_MS);
          signal.addEventListener("abort", () => clearTimeout(timeoutHandle), { once: true });
        }
        waitSignal.addEventListener("abort", finishWaiting, { once: true });
        video.addEventListener("loadedmetadata", onLoaded, { signal: waitSignal });
        video.addEventListener("durationchange", onDurationChange, { signal: waitSignal });
        video.addEventListener("error", onError, { signal: waitSignal });
        await metadataReady;
        if (this.#destroyed) {
          logger.log("resume", "Shell destroyed before metadata - skipping");
          return;
        }
        if (!video.isConnected) {
          logger.log("resume", "Video detached before metadata - skipping");
          return;
        }
      }
      const duration = Number(video.duration);
      if (!Number.isFinite(duration) || duration <= 0) {
        logger.log("resume", "No duration available - skipping");
        return;
      }
      this.#store.cleanStale();
      const match = this.#store.findMatch(context.domain, context.path, duration);
      if (match) {
        this.#entry = match;
        logger.log("resume", `Matched ${match.id} - resume at ${match.resume}s`);
      } else {
        this.#entry = this.#store.createEntry(context.domain, context.path, context.title, duration);
        logger.log("resume", `Created ${this.#entry.id} for ${context.domain}${context.path}`);
      }
      const savedPosition = Number(this.#entry.resume) || NaN;
      if (savedPosition > RESUME_MIN_POSITION) {
        shell.media.seekTo(savedPosition);
        shell.toastAction("resume", `Resumed at ${formatTime(savedPosition)}`, "resume", [{
          icon: "reload",
          title: "Start over",
          onClick: () => {
            this.#lastSavedPosition = 0;
            shell.media.seekTo(0);
          }
        }]);
      }
      this.#lastSavedPosition = Number.isFinite(savedPosition) ? savedPosition : shell.currentTime || NaN;
      this.#startProgressWatch(shell);
    }
    #saveProgress(currentTime) {
      if (Math.abs(currentTime - this.#lastSavedPosition) < RESUME_SAVE_EPSILON_S) {
        return;
      }
      this.#lastSavedPosition = currentTime;
      this.#lastSavedWall = Date.now();
      if (this.#entry.duration > 0 && currentTime / this.#entry.duration >= RESUME_COMPLETION_RATIO) {
        this.#entry.resume = 0;
        this.#store.updateResume(this.#entry.id, 0);
        return;
      }
      this.#store.updateResume(this.#entry.id, currentTime);
    }
    #startProgressWatch(shell) {
      const video = shell.video;
      const { signal } = this.#scope;
      this.#lastSavedWall = Date.now();
      const saveIfDue = () => {
        if (shell.paused || Date.now() - this.#lastSavedWall < TUNING.resume.saveIntervalMs) {
          return;
        }
        this.#saveProgress(shell.currentTime);
      };
      let onScreen = true;
      if (typeof IntersectionObserver === "function") {
        const io = new IntersectionObserver(([entry]) => {
          onScreen = entry.isIntersecting;
        });
        io.observe(video);
        this.#intersectionObserver = io;
      }
      const gatedSaveIfDue = () => {
        if (onScreen) {
          saveIfDue();
        }
      };
      video.addEventListener("timeupdate", gatedSaveIfDue, { signal, passive: true });
      video.addEventListener("pause", () => {
        if (typeof video.requestVideoFrameCallback === "function") {
          video.requestVideoFrameCallback((_now, metadata) => {
            this.#saveProgress(metadata.mediaTime);
          });
        } else {
          this.#saveProgress(shell.currentTime);
        }
      }, { signal, passive: true });
    }
    /** Clipboard bridge passthroughs (see ResumeStore exportData/importData). */
    exportResume() {
      return this.#store.exportData();
    }
    importResume(text) {
      return this.#store.importData(text);
    }
    getEntries() {
      return this.#store.getEntries();
    }
    removeEntry(id) {
      this.#store.removeEntry(id);
    }
    resetEntry(id) {
      this.#store.updateResume(id, 0);
    }
    /** Subscribe to store changes (see ResumeStore#onChange). */
    onChange(cb) {
      return this.#store.onChange(cb);
    }
    destroy() {
      this.#scope.abort();
      this.#intersectionObserver?.disconnect();
      this.#intersectionObserver = null;
      if (this.#entry && !this.#destroyed) {
        this.#saveProgress(this.#shell?.currentTime || NaN);
      }
      this.#destroyed = true;
      this.#store.destroy();
    }
  };

  // src/shell/subtitles/forgevtt.js
  var SRT_TIMECODE_RE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/g;
  var SRT_BLOCK_RE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->/;
  var METADATA_BLOCK_RE = /^(NOTE|STYLE|REGION)(?:[ \t]|$)/;
  var ENTITY_MAP = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&nbsp;": " ",
    "&lrm;": "‎",
    "&rlm;": "‏"
  };
  var CUE_TEXT_RE = /<\/?[a-zA-Z][^>]*>|&(?:amp|lt|gt|nbsp|lrm|rlm);|&#(?:x[0-9a-fA-F]+|\d+);/g;
  var BOM_RE = /^\uFEFF/;
  var CRLF_RE = /\r\n?/g;
  function normalizeText(raw) {
    return raw.normalize("NFC").replace(BOM_RE, "").replace(CRLF_RE, "\n");
  }
  function srtToVtt(raw) {
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
        out.push(line.replace(SRT_TIMECODE_RE, (_m, h, m, s, ms) => `${h.padStart(2, "0")}:${m}:${s}.${ms.padStart(3, "0")}`));
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
    return `WEBVTT

${out.join("\n").trim()}
`;
  }
  function ensureVttHeader(raw) {
    const text = normalizeText(raw);
    if (/^WEBVTT\b/.test(text)) {
      return text;
    }
    return `WEBVTT

${text.trimStart()}`;
  }
  var ZERO = 48;
  var NINE = 57;
  var COLON = 58;
  var DOT = 46;
  var COMMA = 44;
  var SPACES_RE = /^\s+$/;
  function isDigitCode(c) {
    return c >= ZERO && c <= NINE;
  }
  function timecodeToSeconds(timecode) {
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
    const field = (_max) => {
      let val = 0;
      let count = 0;
      while (i < f && isDigitCode(timecode.charCodeAt(i))) {
        val = val * 10 + (timecode.charCodeAt(i) - ZERO);
        i++;
        count++;
      }
      return { val, count };
    };
    if (colons === 2) {
      const h = field(Number.MAX_SAFE_INTEGER);
      if (h.count === 0 || i >= f || timecode.charCodeAt(i) !== COLON) {
        return null;
      }
      i++;
      const m2 = field(2);
      if (m2.count < 1 || m2.count > 2 || i >= f || timecode.charCodeAt(i) !== COLON) {
        return null;
      }
      i++;
      const s2 = field(2);
      if (s2.count !== 2 || i < f) {
        return null;
      }
      let ms2 = 0;
      for (let k = f + 1; k < n; k++) {
        ms2 = ms2 * 10 + (timecode.charCodeAt(k) - ZERO);
      }
      return h.val * 3600 + m2.val * 60 + s2.val + ms2 / 1e3;
    }
    const m = field(2);
    if (m.count < 1 || m.count > 2 || i >= f || timecode.charCodeAt(i) !== COLON) {
      return null;
    }
    i++;
    const s = field(2);
    if (s.count !== 2 || i < f) {
      return null;
    }
    let ms = 0;
    for (let k = f + 1; k < n; k++) {
      ms = ms * 10 + (timecode.charCodeAt(k) - ZERO);
    }
    return m.val * 60 + s.val + ms / 1e3;
  }
  function decodeNumericEntity(entity) {
    const isHex = entity[2] === "x" || entity[2] === "X";
    const code = parseInt(entity.slice(isHex ? 3 : 2, -1), isHex ? 16 : 10);
    if (!(code >= 1 && code <= 1114111) || code >= 55296 && code <= 57343) {
      return "�";
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
  var DEFAULT_CUE_SETTINGS = Object.freeze({ line: 85, position: 50, align: void 0 });
  function parseCueSettings(settings) {
    const rest = settings.trim();
    if (!rest) {
      return DEFAULT_CUE_SETTINGS;
    }
    const parsed = { line: 85, position: 50, align: void 0 };
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
  function parseTimingLine(line) {
    const arrow = line.indexOf("-->");
    if (arrow < 0) {
      return null;
    }
    const before = line.slice(0, arrow);
    const left = before.trimEnd();
    if (left === before || !SPACES_RE.test(before.slice(left.length))) {
      return null;
    }
    const start = timecodeToSeconds(left);
    if (start == null) {
      return null;
    }
    const after = line.slice(arrow + 3);
    let k = 0;
    while (k < after.length && (after.charCodeAt(k) === 32 || after.charCodeAt(k) === 9)) {
      k++;
    }
    if (k === 0) {
      return null;
    }
    let m = k;
    while (m < after.length && after.charCodeAt(m) !== 32 && after.charCodeAt(m) !== 9) {
      m++;
    }
    const run = after.slice(k, m);
    let sep = -1;
    for (let q = 0; q < run.length; q++) {
      const c = run.charCodeAt(q);
      if (c === DOT || c === COMMA) {
        sep = q;
        break;
      }
    }
    if (sep < 0) {
      return null;
    }
    let digits = 0;
    while (digits < 3 && sep + 1 + digits < run.length && isDigitCode(run.charCodeAt(sep + 1 + digits))) {
      digits++;
    }
    if (digits === 0) {
      return null;
    }
    const end = timecodeToSeconds(run.slice(0, sep + 1 + digits));
    if (end == null) {
      return null;
    }
    return {
      start,
      end,
      settings: parseCueSettings(run.slice(sep + 1 + digits) + after.slice(m))
    };
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
  var YIELD_BUDGET_MS = 50;
  async function parseSubtitlesAsync(text, offset = 0) {
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
  function sortCues(cues) {
    cues.sort((a, b) => a.start - b.start);
    return cues;
  }
  function offsetCues(cues, offset = 0) {
    if (offset === 0) {
      return cues;
    }
    const shifted = [];
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      const end = cue.end + offset;
      if (end <= 0) {
        continue;
      }
      const start = cue.start + offset;
      shifted.push({
        start: start < 0 ? 0 : start,
        end,
        text: cue.text,
        line: cue.line,
        position: cue.position,
        align: cue.align
      });
    }
    return shifted;
  }

  // src/shell/subtitles/vtt-worker-loader.js
  var BUILTIN_WORKER_SOURCE = true ? '(()=>{var M=/^(NOTE|STYLE|REGION)(?:[ \\t]|$)/,O={"&amp;":"&","&lt;":"<","&gt;":">","&nbsp;":" ","&lrm;":"‎","&rlm;":"‏"},y=/<\\/?[a-zA-Z][^>]*>|&(?:amp|lt|gt|nbsp|lrm|rlm);|&#(?:x[0-9a-fA-F]+|\\d+);/g,N=/^\\uFEFF/,R=/\\r\\n?/g;function F(e){return e.normalize("NFC").replace(N,"").replace(R,`\n`)}var m=48,w=57,E=58,b=46,S=44,v=/^\\s+$/;function C(e){return e>=m&&e<=w}function x(e){let r=e.length,n=-1,i=0;for(let s=0;s<r;s++){let l=e.charCodeAt(s);if(l===b||l===S){if(n!==-1)return null;n=s}else if(l===E){if(n!==-1)return null;i++}else if(!C(l))return null}if(n===-1||i<1||i>2)return null;let c=r-n-1;if(c<1||c>3)return null;let t=0,o=s=>{let l=0,d=0;for(;t<n&&C(e.charCodeAt(t));)l=l*10+(e.charCodeAt(t)-m),t++,d++;return{val:l,count:d}};if(i===2){let s=o(Number.MAX_SAFE_INTEGER);if(s.count===0||t>=n||e.charCodeAt(t)!==E)return null;t++;let l=o(2);if(l.count<1||l.count>2||t>=n||e.charCodeAt(t)!==E)return null;t++;let d=o(2);if(d.count!==2||t<n)return null;let p=0;for(let g=n+1;g<r;g++)p=p*10+(e.charCodeAt(g)-m);return s.val*3600+l.val*60+d.val+p/1e3}let u=o(2);if(u.count<1||u.count>2||t>=n||e.charCodeAt(t)!==E)return null;t++;let f=o(2);if(f.count!==2||t<n)return null;let a=0;for(let s=n+1;s<r;s++)a=a*10+(e.charCodeAt(s)-m);return u.val*60+f.val+a/1e3}function B(e){let r=e[2]==="x"||e[2]==="X",n=parseInt(e.slice(r?3:2,-1),r?16:10);return!(n>=1&&n<=1114111)||n>=55296&&n<=57343?"�":String.fromCodePoint(n)}function D(e){return e.replace(y,r=>r.charCodeAt(0)===38?r.charCodeAt(1)===35?B(r):O[r]:"")}var L=Object.freeze({line:85,position:50,align:void 0});function $(e){let r=e.trim();if(!r)return L;let n={line:85,position:50,align:void 0};for(let i of r.split(/\\s+/)){if(!i)continue;let c=i.indexOf(":");if(c<=0)continue;let t=i.slice(0,c),o=i.slice(c+1);t==="line"?o.endsWith("%")&&(n.line=Number(o.slice(0,-1))):t==="position"?n.position=Number(o.endsWith("%")?o.slice(0,-1):o):t==="align"&&(n.align=o)}return n}function I(e){let r=e.indexOf("-->");if(r<0)return null;let n=e.slice(0,r),i=n.trimEnd();if(i===n||!v.test(n.slice(i.length)))return null;let c=x(i);if(c==null)return null;let t=e.slice(r+3),o=0;for(;o<t.length&&(t.charCodeAt(o)===32||t.charCodeAt(o)===9);)o++;if(o===0)return null;let u=o;for(;u<t.length&&t.charCodeAt(u)!==32&&t.charCodeAt(u)!==9;)u++;let f=t.slice(o,u),a=-1;for(let d=0;d<f.length;d++){let p=f.charCodeAt(d);if(p===b||p===S){a=d;break}}if(a<0)return null;let s=0;for(;s<3&&a+1+s<f.length&&C(f.charCodeAt(a+1+s));)s++;if(s===0)return null;let l=x(f.slice(0,a+1+s));return l==null?null:{start:c,end:l,settings:$(f.slice(a+1+s)+t.slice(u))}}function _(e,r=0){let n=F(e),i=n.length,c=[],t=null,o=!1,u=!1,f=null,a=()=>{if(t&&t.end>t.start){let s=t.end+r;if(s>0){let l=D(f.join(`\n`).trim());l&&c.push({start:Math.max(t.start+r,0),end:s,text:l,line:t.settings.line,position:t.settings.position,align:t.settings.align})}}t=null,o=!1,u=!1,f=null};for(let s=0;s<=i;){let l=n.indexOf(`\n`,s),d=l===-1?i:l,p=n.slice(s,d);s=l===-1?i+1:l+1;let g=!0;for(let h=0;h<p.length;h++){let A=p.charCodeAt(h);if(A!==32&&A!==9){g=!1;break}}if(g){o&&a();continue}if(!o&&(o=!0,M.test(p))){u=!0;continue}if(!u)if(t)f.push(p);else{let h=I(p);h&&(t=h,f=[])}}return o&&a(),W(c)}function W(e){return e.sort((r,n)=>r.start-n.start),e}var P=150,T=0,k=0;typeof PerformanceObserver<"u"&&PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame")&&new PerformanceObserver(e=>{for(let r of e.getEntries()){if(r.duration<P)continue;let i=(r.scripts??[]).reduce((c,t)=>c+(t.forcedStyleAndLayoutDuration??0),0);r.duration>T&&(T=r.duration,k=i)}}).observe({type:"long-animation-frame",buffered:!1});self.onmessage=e=>{let{id:r,text:n}=e.data??{};if(!(typeof r!="number"||typeof n!="string")){try{let i=_(n,0);self.postMessage({pfWorker:1,id:r,cues:i})}catch(i){self.postMessage({pfWorker:1,id:r,error:String(i&&i.message||i)})}T>0&&self.postMessage({pfWorker:1,id:r,type:"perf",durationMs:Math.round(T),forcedMs:Math.round(k*10)/10})}};})();\n' : null;
  function workerSource() {
    if (BUILTIN_WORKER_SOURCE !== null) {
      return BUILTIN_WORKER_SOURCE;
    }
    return typeof globalThis.__VTT_WORKER_SOURCE__ === "string" ? globalThis.__VTT_WORKER_SOURCE__ : null;
  }
  var WORKER_MIN_CHARS = 1 << 19;
  var WORKER_TIMEOUT_MS = 6e4;
  var workerBusy = false;
  var requestSeq = 0;
  function workerCapable() {
    return workerSource() !== null && typeof globalThis.Worker === "function" && typeof globalThis.Blob === "function" && typeof globalThis.URL?.createObjectURL === "function" && typeof globalThis.URL?.revokeObjectURL === "function";
  }
  function reportWorkerJank(data) {
    if (logger.enabled) {
      logger.warn(
        "perf",
        `worker LoAF ${data.durationMs}ms (forced style+layout ${data.forcedMs}ms)`
      );
    }
  }
  function runInWorker(text) {
    const requestId = ++requestSeq;
    const objectUrl = globalThis.URL.createObjectURL(
      new globalThis.Blob([workerSource()], { type: "text/javascript" })
    );
    let worker;
    try {
      worker = new globalThis.Worker(objectUrl, { name: "playerforge-vtt" });
    } catch (err) {
      globalThis.URL.revokeObjectURL(objectUrl);
      throw err;
    }
    workerBusy = true;
    return new Promise((resolve) => {
      let settled = false;
      let watchTimer = 0;
      const cleanup = () => {
        if (settled) {
          return;
        }
        settled = true;
        workerBusy = false;
        clearTimeout(watchTimer);
        worker.terminate();
        globalThis.URL.revokeObjectURL(objectUrl);
      };
      const fallback = () => {
        cleanup();
        parseSubtitlesAsync(text).then(resolve);
      };
      watchTimer = setTimeout(fallback, WORKER_TIMEOUT_MS);
      worker.onerror = () => fallback();
      worker.onmessage = (event) => {
        const data = event.data ?? {};
        if (data.pfWorker !== 1 || data.id !== requestId) {
          return;
        }
        if (data.type === "perf") {
          reportWorkerJank(data);
          return;
        }
        if (data.error) {
          fallback();
          return;
        }
        const cues = data.cues;
        setTimeout(cleanup, 0);
        resolve(cues);
      };
      worker.postMessage({ id: requestId, text });
    });
  }
  async function parseSubtitlesAsync2(text, offset = 0, throughWorker = false) {
    const eligible = offset === 0 && workerCapable() && !workerBusy && (throughWorker || text.length >= WORKER_MIN_CHARS);
    if (!eligible) {
      return parseSubtitlesAsync(text, offset);
    }
    try {
      return await runInWorker(text);
    } catch (err) {
      logger.warn("subtitles", "Worker parse failed, falling back in-band", err);
      return parseSubtitlesAsync(text, offset);
    }
  }

  // src/shell/subtitles/forge-track.js
  var STACK_OVERLAP_EM = 1.6;
  var MAX_SLOTS = 8;
  var TRACK_LABEL = "PlayerForge Subtitles";
  var ForgeTrack = class {
    #cueLayer;
    #cueLayerStyle;
    #track;
    #slots = [];
    /** DOM lifecycle manager: cue slot elements auto-removed on destroy. */
    #dom = new DOMManager();
    /** Fixed, shape-stable scratch per slot (pooled, never reallocated on
     *  render); #lastActive mirrors which slots currently hold a live cue so a
     *  `null` entry never needs to be stored. Same discipline as the forge's
     *  pooled scrub payload: mutate in place, read immediately. */
    #lastRender = [];
    #lastActive = [];
    /** Records the bound cuechange so destroy can unregister it. */
    #onCueChange = null;
    #destroyed = false;
    constructor(video, cueLayer) {
      this.#cueLayer = cueLayer;
      this.#cueLayerStyle = cueLayer?.style;
      for (let i = 0; i < MAX_SLOTS; i++) {
        this.#lastRender[i] = { text: null, top: null, left: null, x: null, prevLine: NaN, prevPosition: NaN, prevI: -1 };
        this.#lastActive[i] = false;
      }
      if (cueLayer) {
        for (let i = 0; i < MAX_SLOTS; i++) {
          this.#slots[i] = this.#dom.createElement("div", { class: "pf-cue", role: "caption" }, cueLayer);
        }
      }
      const owned = Array.from(video?.textTracks ?? []).find(
        (track) => track.kind === "subtitles" && track.label === TRACK_LABEL
      );
      this.#track = owned ?? video?.addTextTrack?.("subtitles", TRACK_LABEL, "en");
      if (!this.#track) {
        throw new Error("This element cannot host a subtitle track");
      }
      this.#track.mode = "hidden";
      this.#onCueChange = () => {
        this.#render();
      };
      this.#track.addEventListener("cuechange", this.#onCueChange);
    }
    /** Replace all cues on the track. Accepts plain cue objects from forgevtt. */
    load(cues) {
      if (this.#destroyed) {
        return;
      }
      const track = this.#track;
      while (track.cues.length > 0) {
        track.removeCue(track.cues[0]);
      }
      for (const cue of cues) {
        const vtt = new VTTCue(cue.start, cue.end, cue.text);
        vtt.line = cue.line;
        vtt.position = cue.position;
        if (cue.align) {
          vtt.align = cue.align;
        }
        track.addCue(vtt);
      }
    }
    #render() {
      if (this.#destroyed || !this.#cueLayer) {
        return;
      }
      const active = this.#track.activeCues;
      const count = Math.min(active.length, MAX_SLOTS);
      for (let i = 0; i < count; i++) {
        const slot = this.#slots[i];
        if (!slot) {
          continue;
        }
        const cue = active[i];
        const line = cue.line;
        const position = cue.position;
        const align = cue.align || "center";
        const prev = this.#lastRender[i];
        const lineChanged = line !== prev.prevLine || i !== prev.prevI;
        const positionChanged = position !== prev.prevPosition;
        if (lineChanged) {
          const top = `calc(${line}% - ${i * STACK_OVERLAP_EM}em)`;
          if (prev.top !== top) {
            slot.style.setProperty("--pf-cue-top", top);
          }
          prev.top = top;
          prev.prevLine = line;
          prev.prevI = i;
        }
        if (positionChanged) {
          const left = `${position}%`;
          if (prev.left !== left) {
            slot.style.setProperty("--pf-cue-left", left);
          }
          prev.left = left;
          prev.prevPosition = position;
        }
        const x = align === "start" ? "0" : align === "end" ? "-100%" : "-50%";
        if (prev.x !== x) {
          slot.style.setProperty("--pf-cue-x", x);
        }
        if (prev.text !== cue.text) {
          slot.textContent = cue.text;
        }
        if (slot.hidden) {
          slot.hidden = false;
        }
        prev.text = cue.text;
        prev.x = x;
        this.#lastActive[i] = true;
      }
      for (let i = count; i < this.#slots.length; i++) {
        const slot = this.#slots[i];
        if (!slot.hidden) {
          slot.hidden = true;
          this.#lastActive[i] = false;
        }
      }
    }
    clear() {
      if (this.#destroyed || !this.#lastActive.some(Boolean)) {
        return;
      }
      for (let i = 0; i < this.#slots.length; i++) {
        const slot = this.#slots[i];
        if (!slot.hidden) {
          slot.hidden = true;
          this.#lastActive[i] = false;
        }
      }
    }
    setVar(prop, value) {
      this.#cueLayerStyle?.setProperty(prop, value);
    }
    destroy() {
      if (this.#destroyed) {
        return;
      }
      this.#destroyed = true;
      this.#track.removeEventListener?.("cuechange", this.#onCueChange);
      this.#track.mode = "disabled";
      while (this.#track.cues.length > 0) {
        this.#track.removeCue(this.#track.cues[0]);
      }
      this.#dom.destroy();
      this.#slots = [];
      this.#lastActive = [];
    }
  };

  // src/shell/chrome/animate.js
  function flashElement(el2, { duration = FLASH_MS } = {}) {
    if (!el2 || typeof el2.animate !== "function") {
      return;
    }
    for (const anim of el2.getAnimations?.() ?? []) {
      if (anim.playState === "finished") {
        anim.cancel();
        continue;
      }
      const keyframes = anim.effect && typeof anim.effect.getKeyframes === "function" ? anim.effect.getKeyframes() : [];
      if (keyframes.some((kf) => "backgroundColor" in kf)) {
        anim.cancel();
      }
    }
    el2.animate(
      [
        { backgroundColor: "transparent" },
        { backgroundColor: "var(--pf-accent)" },
        { backgroundColor: "transparent" }
      ],
      { duration, easing: FLASH_EASING }
    );
  }

  // src/shell/chrome/elements.js
  function el(tag, attrs = {}, parent = null) {
    const node = (parent?.ownerDocument ?? document).createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "style" && typeof value === "object") {
        Object.assign(node.style, value);
      } else {
        node.setAttribute(key, value);
      }
    }
    parent?.appendChild(node);
    return node;
  }
  function button({ class: cls = "", title = "", "aria-label": ariaLabel = "", icon = null, ...rest }, parent = null) {
    const node = el("button", {
      type: "button",
      ...cls ? { class: cls } : {},
      ...title ? { title } : {},
      ...ariaLabel ? { "aria-label": ariaLabel } : {},
      ...rest
    }, parent);
    if (icon) {
      node.appendChild(icon);
    }
    return node;
  }

  // src/shell/subtitles/section.js
  var SUBTITLE_FILE_ACCEPT = ".srt,.vtt";
  var SUBTITLE_EXT_RE = /\.(srt|vtt)$/i;
  var SETTING_KEYS = {
    size: "subtitles.style.size",
    color: "subtitles.style.color",
    shadow: "subtitles.style.shadow",
    line: "subtitles.position.line",
    horizontal: "subtitles.position.horizontal",
    syncOffset: "subtitles.sync.offset"
  };
  var SubtitlesSection = class {
    #shell;
    #forgeTrack = null;
    #trackMeta = null;
    /** Cues parsed at zero offset; the sync stepper re-offsets this base. */
    #baseCues = null;
    #cueLayer = null;
    #syncOffset = 0;
    #fileInput = null;
    #hintEl = null;
    #loadButton = null;
    #removeButton = null;
    #urlButton = null;
    #styleControls = null;
    #positionControls = null;
    #resetBtn = null;
    /** Debounced sync-offset apply; cancelled on destroy so no trailing write lands. */
    #scheduleSyncOffset = null;
    #scope = new AbortController();
    #destroyed = false;
    constructor(shell) {
      this.#shell = shell;
      this.#syncOffset = Number(getConfigValue(SETTING_KEYS.syncOffset, 0)) || 0;
      this.#cueLayer = shell.shellDom?.cueLayer || null;
      this.#fileInput = this.#createFileInput(shell);
      this.#buildPanelUi(shell);
      this.#startListening();
      logger.log("subtitles", `Ready (${shell.sdk.name})`);
    }
    destroy() {
      if (this.#destroyed) {
        return;
      }
      this.#destroyed = true;
      this.#scheduleSyncOffset?.cancel();
      this.#scheduleSyncOffset = null;
      this.#scope.abort();
      this.#forgeTrack?.destroy();
      this.#forgeTrack = null;
      this.#fileInput?.remove();
      this.#fileInput = null;
      this.#hintEl = null;
      this.#loadButton = null;
      this.#removeButton = null;
      this.#urlButton = null;
      this.#styleControls = null;
      this.#positionControls = null;
      this.#resetBtn = null;
      this.#trackMeta = null;
      this.#cueLayer = null;
    }
    #startListening() {
      const { signal } = this.#scope;
      const video = this.#shell.video;
      video?.addEventListener("ended", () => this.#forgeTrack?.clear(), { signal, passive: true });
    }
    #buildPanelUi(shell) {
      const panel = shell.panel;
      const panelBody = panel?.body;
      if (!panelBody) {
        return;
      }
      const sectionRoot = panel.addSection("Subtitles", "captions");
      if (!sectionRoot) {
        return;
      }
      const dragCounter = { count: 0 };
      const hasFiles = (event) => event.dataTransfer?.types?.includes("Files") ?? false;
      const isSubtitleFile = (file) => SUBTITLE_EXT_RE.test(file?.name || "");
      const { signal } = this.#scope;
      sectionRoot.addEventListener("dragenter", (event) => {
        if (hasFiles(event)) {
          event.preventDefault();
          dragCounter.count++;
          sectionRoot.classList.add("pf-drop-active");
        }
      }, { signal });
      sectionRoot.addEventListener("dragover", (event) => {
        if (hasFiles(event)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
      }, { signal });
      sectionRoot.addEventListener("dragleave", () => {
        dragCounter.count--;
        if (dragCounter.count <= 0) {
          dragCounter.count = 0;
          sectionRoot.classList.remove("pf-drop-active");
        }
      }, { signal });
      sectionRoot.addEventListener("drop", (event) => {
        event.preventDefault();
        dragCounter.count = 0;
        sectionRoot.classList.remove("pf-drop-active");
        const files = [...event.dataTransfer?.files || []].filter(isSubtitleFile);
        if (!files.length) {
          this.#toastInfo("captions", "Drop a .srt or .vtt file", "subtitles");
          return;
        }
        for (const file of files) {
          this.load(file);
        }
      }, { signal });
      const loadSection = panel.el("div", { class: "pf-panel-section" }, sectionRoot);
      const loadRow = panel.el("div", { class: "pf-panel-load-row" }, loadSection);
      const actions = panel.el("div", { class: "pf-panel-actions" }, loadRow);
      this.#loadButton = panel.addControl(actions, {
        type: "button",
        icon: "upload",
        title: "Load subtitles (.srt / .vtt)",
        ariaLabel: "Load subtitles",
        onClick: () => this.#fileInput?.click()
      });
      this.#urlButton = panel.addControl(actions, {
        type: "button",
        icon: "link",
        title: "Load subtitles from URL",
        ariaLabel: "Load subtitles from URL",
        ghost: true,
        onClick: () => this.#promptForUrl()
      });
      this.#removeButton = panel.addControl(actions, {
        type: "button",
        icon: "trash",
        title: "Remove subtitles",
        ariaLabel: "Remove subtitles",
        ghost: true,
        onClick: () => this.#removeTrack()
      });
      this.#hintEl = panel.addHint(loadRow, "Upload your file");
      const styleSection = panel.el("div", { class: "pf-panel-section" }, sectionRoot);
      const styleHead = panel.el("div", { class: "pf-panel-section-head" }, styleSection);
      panel.addLabel(styleHead, "Style & Position");
      const styleGrid = panel.el("div", { class: "pf-panel-grid pf-panel-grid-compact" }, styleSection);
      const applyCueSize = (v) => this.#setCueVar("--pf-cue-font-size", `${v}em`);
      const sizeStepper = panel.addControl(styleGrid, {
        type: "stepper",
        label: "Size",
        min: 0.6,
        max: 3,
        step: 0.1,
        value: getConfigValue(SETTING_KEYS.size, 1.2),
        format: fmtEm,
        onChange: (v) => {
          setConfigValue(SETTING_KEYS.size, v);
          applyCueSize(v);
        }
      });
      applyCueSize(sizeStepper.getValue());
      const colorField = panel.addControl(styleGrid, {
        type: "color",
        label: "Color",
        value: getConfigValue(SETTING_KEYS.color, "#ffffff"),
        onChange: (hex) => {
          setConfigValue(SETTING_KEYS.color, hex);
          this.#setCueVar("--pf-cue-color", hex);
        }
      });
      this.#setCueVar("--pf-cue-color", colorField.getValue());
      const applyCueShadow = (strength) => this.#setCueVar("--pf-cue-text-shadow", strength ? `1px 1px ${Math.round(strength / 6)}px rgba(0, 0, 0, ${(0.4 + strength / 100 * 0.6).toFixed(2)})` : "none");
      const shadowStepper = panel.addControl(styleGrid, {
        type: "stepper",
        label: "Shadow",
        min: 0,
        max: 100,
        step: 5,
        value: getConfigValue(SETTING_KEYS.shadow, 40),
        format: (v) => v ? `${v}%` : "Off",
        onChange: (v) => {
          setConfigValue(SETTING_KEYS.shadow, v);
          applyCueShadow(v);
        }
      });
      applyCueShadow(shadowStepper.getValue());
      this.#scheduleSyncOffset = debounce((offset) => {
        if (this.#trackMeta) {
          this.#forgeTrack?.load(offsetCues(this.#baseCues, offset));
        }
        setConfigValue(SETTING_KEYS.syncOffset, offset);
      }, TUNING.subtitles.syncDebounceMs);
      const syncStepper = panel.addControl(styleGrid, {
        type: "stepper",
        label: "Sync",
        min: -20,
        max: 20,
        step: 0.25,
        value: this.#syncOffset,
        format: (v) => v === 0 ? "0s" : `${v > 0 ? "+" : ""}${v}s`,
        onChange: (offset) => {
          this.#syncOffset = offset;
          this.#scheduleSyncOffset(offset);
        }
      });
      const verticalStepper = panel.addControl(styleGrid, {
        type: "stepper",
        label: "V",
        min: 0,
        max: 100,
        step: 5,
        value: getConfigValue(SETTING_KEYS.line, 85),
        format: fmtPercent,
        onChange: (v) => {
          setConfigValue(SETTING_KEYS.line, v);
        }
      });
      const horizontalStepper = panel.addControl(styleGrid, {
        type: "stepper",
        label: "H",
        min: 0,
        max: 100,
        step: 5,
        value: getConfigValue(SETTING_KEYS.horizontal, 50),
        format: fmtPercent,
        onChange: (v) => {
          setConfigValue(SETTING_KEYS.horizontal, v);
        }
      });
      this.#styleControls = { size: sizeStepper, color: colorField, shadow: shadowStepper, sync: syncStepper };
      this.#positionControls = { vertical: verticalStepper, horizontal: horizontalStepper };
      this.#resetBtn = panel.addControl(styleHead, {
        type: "button",
        icon: "reload",
        title: "Reset all",
        ariaLabel: "Reset all",
        ghost: true,
        onClick: () => {
          sizeStepper.setValue(1.2);
          colorField.setValue("#ffffff");
          shadowStepper.setValue(40);
          syncStepper.setValue(0);
          verticalStepper.setValue(85);
          horizontalStepper.setValue(50);
          flashElement(this.#resetBtn);
          this.#toastFlash("reload", "Subtitle Style Reset", "subtitles");
        }
      });
      this.#refreshHint();
    }
    #setCueVar(prop, value) {
      this.#forgeTrack?.setVar(prop, value);
    }
    #toastFlash(icon, text, group2) {
      this.#shell?.toastFlash(icon, text, group2);
    }
    #toastInfo(icon, text, group2) {
      this.#shell?.toastInfo(icon, text, group2);
    }
    #createFileInput(shell) {
      const input = el("input", {
        type: "file",
        accept: SUBTITLE_FILE_ACCEPT,
        style: { display: "none" }
      }, shell.container);
      input.addEventListener("change", () => {
        const file = input.files?.[0];
        if (file) {
          this.load(file);
        }
        input.value = "";
      }, { signal: this.#scope.signal });
      return input;
    }
    async load(file) {
      if (this.#destroyed) {
        return;
      }
      try {
        const rawText = await file.text();
        await this.#ingest(file.name, rawText);
      } catch (err) {
        this.#handleLoadError("load", file.name, err);
      }
    }
    /** Fetch a subtitle file from the web through the manager's xhr. */
    async loadFromUrl(rawUrl) {
      if (this.#destroyed) {
        return;
      }
      const url = String(rawUrl || "").trim();
      if (!url) {
        return;
      }
      let response;
      try {
        response = await gmRequestText(url);
      } catch (err) {
        this.#handleLoadError("fetch", url, err);
        return;
      }
      try {
        await this.#ingest(this.#nameFromUrl(response.finalUrl || url), response.responseText);
      } catch (err) {
        this.#handleLoadError("parse", url, err);
      }
    }
    #handleLoadError(verb, target, err) {
      logger.error("subtitles", `Failed to ${verb} ${target}:`, err);
      this.#toastInfo("captions", `Failed to ${verb} subtitles`, "subtitles");
    }
    #promptForUrl() {
      const url = window.prompt("Subtitle URL (.srt / .vtt)");
      if (url) {
        this.loadFromUrl(url);
      }
    }
    /** Last path segment as a display name, defaulted to .vtt when unknown. */
    #nameFromUrl(url) {
      if (!URL.canParse(url)) {
        return "subtitles.vtt";
      }
      const last = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
      if (!last) {
        return "subtitles.vtt";
      }
      return SUBTITLE_EXT_RE.test(last) ? last : `${last}.vtt`;
    }
    async #ingest(name, rawText) {
      if (this.#destroyed) {
        return;
      }
      const normalizedText = /\.srt$/i.test(name) ? srtToVtt(rawText) : ensureVttHeader(rawText);
      const cues = await parseSubtitlesAsync2(normalizedText, 0);
      if (this.#destroyed) {
        return;
      }
      if (!cues.length) {
        this.#toastInfo("captions", "No cues found", "subtitles");
        return;
      }
      if (!this.#forgeTrack) {
        this.#forgeTrack = new ForgeTrack(this.#shell.video, this.#cueLayer);
      }
      this.#trackMeta = { name };
      this.#baseCues = cues;
      this.#forgeTrack.load(offsetCues(cues, this.#syncOffset));
      this.#refreshHint();
      this.#toastInfo("captions", name, "subtitles");
      logger.log("subtitles", `Loaded ${name}`);
    }
    #refreshHint() {
      if (this.#hintEl) {
        this.#hintEl.textContent = this.#trackMeta ? this.#trackMeta.name : "Upload your file";
      }
      const hasTrack = !!this.#trackMeta;
      if (this.#loadButton) {
        this.#loadButton.disabled = hasTrack;
      }
      if (this.#urlButton) {
        this.#urlButton.disabled = hasTrack;
      }
      if (this.#removeButton) {
        this.#removeButton.disabled = !hasTrack;
      }
      if (this.#styleControls) {
        const disabled = !hasTrack;
        this.#styleControls.size.setDisabled(disabled);
        this.#styleControls.color.input.disabled = disabled;
        this.#styleControls.shadow.setDisabled(disabled);
        this.#styleControls.sync.setDisabled(disabled);
      }
      if (this.#positionControls) {
        this.#positionControls.vertical.setDisabled(!hasTrack);
        this.#positionControls.horizontal.setDisabled(!hasTrack);
      }
      if (this.#resetBtn) {
        this.#resetBtn.disabled = !hasTrack;
      }
    }
    #removeTrack() {
      this.#forgeTrack?.destroy();
      this.#forgeTrack = null;
      this.#trackMeta = null;
      this.#baseCues = null;
      this.#refreshHint();
    }
  };

  // src/shared/clamp.js
  var clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

  // src/shell/filter.js
  var CONFIG_PREFIX = "filter";
  var FILTER_KEYS = ["brightness", "contrast", "saturate", "hue", "grayscale", "sepia", "invert"];
  var EXTRA_KEYS = ["temperature", "tint"];
  var ALL_KEYS = [...FILTER_KEYS, ...EXTRA_KEYS];
  var PRESETS = {
    Default: { brightness: 100, contrast: 100, saturate: 100, hue: 0, grayscale: 0, sepia: 0, invert: 0, temperature: 0, tint: 0 },
    Cinematic: { brightness: 105, contrast: 115, saturate: 85, hue: 0, grayscale: 0, sepia: 15, invert: 0, temperature: 10, tint: 2 },
    Vibrant: { brightness: 105, contrast: 110, saturate: 140, hue: 0, grayscale: 0, sepia: 0, invert: 0, temperature: 5, tint: 0 },
    "B&W": { brightness: 100, contrast: 110, saturate: 0, hue: 0, grayscale: 100, sepia: 0, invert: 0, temperature: 0, tint: 0 },
    Sepia: { brightness: 100, contrast: 100, saturate: 60, hue: 0, grayscale: 0, sepia: 80, invert: 0, temperature: 15, tint: 0 },
    Night: { brightness: 90, contrast: 120, saturate: 90, hue: 0, grayscale: 0, sepia: 0, invert: 0, temperature: -20, tint: -5 },
    Vintage: { brightness: 102, contrast: 95, saturate: 80, hue: 0, grayscale: 15, sepia: 25, invert: 0, temperature: 12, tint: 5 }
  };
  var DEFAULTS = PRESETS.Default;
  function matchPreset(values) {
    for (const [name, preset] of Object.entries(PRESETS)) {
      if (ALL_KEYS.every((k) => values[k] === preset[k])) {
        return name;
      }
    }
    return "Custom";
  }
  function buildFilterString(values) {
    const parts = [];
    const tempHue = (Number(values.temperature) || 0) * 0.3;
    const tempSat = Math.abs(Number(values.temperature) || 0) * 0.15;
    const tintHue = (Number(values.tint) || 0) * 0.2;
    const totalHue = (Number(values.hue) || 0) + tempHue + tintHue;
    const totalSat = (values.saturate || DEFAULTS.saturate) + tempSat;
    if (values.brightness !== DEFAULTS.brightness) {
      parts.push(`brightness(${values.brightness}%)`);
    }
    if (values.contrast !== DEFAULTS.contrast) {
      parts.push(`contrast(${values.contrast}%)`);
    }
    if (totalSat !== DEFAULTS.saturate) {
      parts.push(`saturate(${clamp(totalSat, 0, 200)}%)`);
    }
    if (totalHue !== 0) {
      parts.push(`hue-rotate(${totalHue}deg)`);
    }
    if (values.grayscale !== DEFAULTS.grayscale) {
      parts.push(`grayscale(${values.grayscale}%)`);
    }
    if (values.sepia !== DEFAULTS.sepia) {
      parts.push(`sepia(${values.sepia}%)`);
    }
    if (values.invert !== DEFAULTS.invert) {
      parts.push(`invert(${values.invert}%)`);
    }
    return parts.join(" ") || "none";
  }
  var VideoFilter = class {
    #video;
    #shell;
    #values = { ...DEFAULTS };
    #presetSelect = null;
    #resetBtn = null;
    #steppers = {};
    #destroyed = false;
    /** Trailing persist: preview applies instantly, storage lands once the drag
     *  settles (a slider drag otherwise fires a full config write + cross-tab
     *  live-reload echo per step). Flushed on destroy. */
    #schedulePersist = debounce(() => this.#writePersist(), TUNING.filter.persistDebounceMs);
    constructor(shell, panel) {
      this.#video = shell.video;
      this.#shell = shell;
      this.#buildSection(panel);
      this.#loadFromConfig();
      this.#apply();
    }
    #buildSection(panel) {
      const sectionRoot = panel.addSection("Color", "color");
      if (!sectionRoot) {
        return;
      }
      const head = panel.el("div", { class: "pf-panel-section-head" }, sectionRoot);
      const presetOptions = Object.keys(PRESETS).concat(["Custom"]);
      this.#presetSelect = panel.addControl(head, {
        type: "select",
        options: presetOptions,
        value: "Default",
        onChange: (name) => this.#onPresetChange(name)
      });
      this.#presetSelect.style.marginLeft = "auto";
      this.#resetBtn = panel.addControl(head, {
        type: "button",
        icon: "reload",
        title: "Reset all",
        ariaLabel: "Reset all",
        ghost: true,
        onClick: () => this.reset()
      });
      const grid = panel.el("div", { class: "pf-panel-grid pf-panel-grid-compact" }, sectionRoot);
      const formatMap = {
        brightness: fmtPercent,
        contrast: fmtPercent,
        saturate: fmtPercent,
        hue: (v) => `${v}°`,
        grayscale: fmtPercent,
        sepia: fmtPercent,
        invert: fmtPercent,
        temperature: (v) => `${v > 0 ? "+" : ""}${v}`,
        tint: (v) => `${v > 0 ? "+" : ""}${v}`
      };
      const rangeMap = {
        brightness: [0, 200, 5],
        contrast: [0, 200, 5],
        saturate: [0, 200, 5],
        hue: [0, 360, 5],
        grayscale: [0, 100, 5],
        sepia: [0, 100, 5],
        invert: [0, 100, 5],
        temperature: [-100, 100, 5],
        tint: [-100, 100, 5]
      };
      const labelMap = {
        brightness: "Brightness",
        contrast: "Contrast",
        saturate: "Saturate",
        hue: "Hue",
        grayscale: "Grayscale",
        sepia: "Sepia",
        invert: "Invert",
        temperature: "Temp",
        tint: "Tint"
      };
      for (const key of ALL_KEYS) {
        const [min, max, step] = rangeMap[key];
        const stepper = panel.addControl(grid, {
          type: "stepper",
          label: labelMap[key],
          min,
          max,
          step,
          value: DEFAULTS[key],
          head: true,
          format: formatMap[key],
          deferTextInput: true,
          onChange: (v) => this.#onStepperChange(key, v)
        });
        this.#steppers[key] = stepper;
      }
    }
    #loadFromConfig() {
      for (const key of ALL_KEYS) {
        const def = DEFAULTS[key];
        const raw = getConfigValue(`${CONFIG_PREFIX}.${key}`, def);
        this.#values[key] = typeof def === "number" ? Number(raw) || def : raw ?? def;
      }
      for (const key of ALL_KEYS) {
        this.#steppers[key]?.setValue(this.#values[key]);
      }
      this.#syncPresetMenu();
    }
    #apply() {
      if (this.#destroyed || !this.#video) {
        return;
      }
      this.#video.style.filter = buildFilterString(this.#values);
    }
    #syncPresetMenu() {
      if (this.#presetSelect) {
        this.#presetSelect.value = matchPreset(this.#values);
      }
    }
    #onStepperChange(key, value) {
      this.#values[key] = value;
      this.#apply();
      this.#syncPresetMenu();
      this.#persist();
    }
    #onPresetChange(name) {
      const preset = PRESETS[name];
      if (!preset) {
        return;
      }
      for (const key of ALL_KEYS) {
        this.#values[key] = preset[key];
        this.#steppers[key]?.setValue(preset[key]);
      }
      this.#apply();
      this.#persist();
      this.#shell?.toastFlash("color", `Preset: ${name}`, "filter");
    }
    #persist() {
      this.#schedulePersist();
    }
    #writePersist() {
      const fields = {};
      for (const key of ALL_KEYS) {
        fields[`${CONFIG_PREFIX}.${key}`] = this.#values[key];
      }
      setConfigFields(fields);
    }
    reset() {
      for (const key of ALL_KEYS) {
        this.#values[key] = DEFAULTS[key];
        this.#steppers[key]?.setValue(DEFAULTS[key]);
      }
      this.#apply();
      this.#persist();
      this.#syncPresetMenu();
      if (this.#resetBtn) {
        flashElement(this.#resetBtn);
      }
      this.#shell?.toastFlash("reload", "Color Reset", "filter");
    }
    destroy() {
      if (this.#destroyed) {
        return;
      }
      this.#destroyed = true;
      this.#schedulePersist.flush();
      if (this.#video) {
        this.#video.style.filter = "";
      }
    }
  };

  // src/shell/chrome/icons.js
  var svgIcon = (path, viewBox = "24 24") => `<svg class="pf-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBox}" aria-hidden="true" focusable="false" fill="currentColor"><path d="${path}"/></svg>`;
  var ICONS = {
    "volume-1": svgIcon("M3 9h4l5-5v16l-5-5H3V9zm18 3a9.003 9.003 0 0 1-7 8.777V18.71a7.003 7.003 0 0 0 0-13.42V3.223c4.008.91 7 4.494 7 8.777zm-4 0a5.001 5.001 0 0 1-3 4.584V7.416c1.766.772 3 2.534 3 4.584z"),
    "volume-2": svgIcon("M5 9v6h4l5 5V4L9 9H5zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"),
    "volume-3": svgIcon("M3 9h4l5-5v16l-5-5H3V9zm9 2a4 4 0 0 1 0 6"),
    muted: svgIcon("M3.5 2A1 1 0 0 0 3 3.719l20 20a1 1 0 1 0 1.406-1.407L17 14.907V3.312c0-1.265-1.105-1.582-1.969-.718L9.812 7.719L4.407 2.312A1 1 0 0 0 3.594 2A1 1 0 0 0 3.5 2zM5 9.063c-.551 0-1 .448-1 1v6c0 .55.449 1 1 1h3.438L15 23.468c1 1 2 .488 2-.875V20.03L6.031 9.063H5z"),
    play: svgIcon("M133 440a35.37 35.37 0 0 1-17.5-4.67c-12-6.8-19.46-20-19.46-34.33V111c0-14.37 7.46-27.53 19.46-34.33a35.13 35.13 0 0 1 35.77.45l247.85 148.36a36 36 0 0 1 0 61l-247.89 148.4A35.5 35.5 0 0 1 133 440Z", "512 512"),
    pause: svgIcon("M208 432h-48a16 16 0 0 1-16-16V96a16 16 0 0 1 16-16h48a16 16 0 0 1 16 16v320a16 16 0 0 1-16 16Zm144 0h-48a16 16 0 0 1-16-16V96a16 16 0 0 1 16-16h48a16 16 0 0 1 16 16v320a16 16 0 0 1-16 16Z", "512 512"),
    "right-arrows": svgIcon("m5.58 16.89l5.77-4.07c.56-.4.56-1.24 0-1.63L5.58 7.11C4.91 6.65 4 7.12 4 7.93v8.14c0 .81.91 1.28 1.58.82zM13 7.93v8.14c0 .81.91 1.28 1.58.82l5.77-4.07c.56-.4.56-1.24 0-1.63l-5.77-4.07c-.67-.47-1.58 0-1.58.81z"),
    "left-arrows": svgIcon("M11 16.07V7.93c0-.81-.91-1.28-1.58-.82l-5.77 4.07c-.56.4-.56 1.24 0 1.63l5.77 4.07c.67.47 1.58 0 1.58-.81zm1.66-3.25l5.77 4.07c.66.47 1.58-.01 1.58-.82V7.93c0-.81-.91-1.28-1.58-.82l-5.77 4.07a1 1 0 0 0 0 1.64z"),
    "down-arrow": svgIcon("M152 0q-21 0-21 21v297l-94-77q-7-6-16-5t-14 7q-6 7-5 16t7 14l143 111l141-111q15-15 2-30q-16-14-30-2l-92 77V21q0-21-21-21z", "304 480"),
    resume: svgIcon("M22.5 12c0-5.799-4.701-10.5-10.5-10.5c-1.798 0-3.493.453-4.975 1.251A10.55 10.55 0 0 0 3.5 5.834V2.5h-2v7h7v-2H4.787a8.545 8.545 0 0 1 3.187-2.988A8.458 8.458 0 0 1 12 3.5a8.5 8.5 0 1 1-8.454 9.396l-.104-.995l-1.989.209l.104.994C2.11 18.384 6.573 22.5 12 22.5c5.799 0 10.5-4.701 10.5-10.5ZM11 6v6.414l3.5 3.5l1.414-1.414L13 11.586V6h-2Z"),
    fullscreen: svgIcon("M43 235v64h64v42H0V235h43zM0 149V43h107v42H43v64H0zm256 150v-64h43v106H192v-42h64zM192 43h107v106h-43V85h-64V43z", "300 280"),
    "exit-fullscreen": svgIcon("m192 64l-.001 85.333H192V192l-.001-.001l.001.001h-42.667v-.001L64 192v-42.667h85.333V64zm0 256v42.667l-.001-.001L192 448h-42.667v-85.334H64V320zM362.667 64l-.001 85.333H448V192l-85.334-.001V192H320V64zM448 320v42.667l-85.334-.001V448H320V320z", "512 512"),
    "picture-in-picture": svgIcon("M19 7h-8v6h8V7zm2 4H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2h18a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2zm-2-6H3v6h16V5zm-2 12h-6v4h6v-4zm8 2a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v4z"),
    "fill-aspect": svgIcon("M17 15h-2q-.425 0-.713.288T14 16q0 .425.288.713T15 17h3q.425 0 .713-.288T19 16v-3q0-.425-.288-.713T18 12q-.425 0-.713.288T17 13v2ZM7 9h2q.425 0 .713-.288T10 8q0-.425-.288-.713T9 7H6q-.425 0-.713.288T5 8v3q0 .425.288.713T6 12q.425 0 .713-.288T7 11V9ZM4 20q-.825 0-1.413-.588T2 18V6q0-.825.588-1.413T4 4h16q.825 0 1.413.588T22 6v12q0 .825-.588 1.413T20 20H4Zm0-2h16V6H4v12Zm0 0V6v12Z"),
    captions: svgIcon("M21.3 1.3q1.1 0 1.9 0.8T24 4v16q0 1.1-0.8 1.9T21.3 22.7H2.7q-1.1 0-1.9-0.8T0 20V4q0-1.1 0.8-1.9T2.7 1.3h18.6zM10.7 10.7v-1.4q0-0.5-0.4-0.9T9.3 8H5.3q-0.5 0-0.9 0.4T4 9.3v5.4q0 0.5 0.4 0.9T5.3 16H9.3q0.6 0 1-0.4T10.7 14.6v-1.4H8.6v0.7H6v-4h2.6v0.7h2.1zm9.3 0v-1.4q0-0.5-0.4-0.9T18.7 8h-4q-0.6 0-1 0.4T13.3 9.3v5.4q0 0.5 0.4 0.9T14.7 16H18.7q0.5 0 0.9-0.4T20 14.6v-1.4h-2.1v0.7h-2.7v-4h2.7v0.7h2.1z"),
    color: svgIcon("M3.839 5.858c2.94-3.916 9.03-5.055 13.364-2.36c4.28 2.66 5.854 7.777 4.1 12.577c-1.655 4.533-6.016 6.328-9.159 4.048c-1.177-.854-1.634-1.925-1.854-3.664l-.106-.987l-.045-.398c-.123-.934-.311-1.352-.705-1.572c-.535-.298-.892-.305-1.595-.033l-.351.146l-.179.078c-1.014.44-1.688.595-2.541.416l-.2-.047l-.164-.047c-2.789-.864-3.202-4.647-.565-8.157Zm12.928 4.722a1.25 1.25 0 1 0 2.415-.647a1.25 1.25 0 0 0-2.415.647Zm.495 3.488a1.25 1.25 0 1 0 2.414-.647a1.25 1.25 0 0 0-2.414.647Zm-2.474-6.491a1.25 1.25 0 1 0 2.415-.647a1.25 1.25 0 0 0-2.415.647Zm-.028 8.998a1.25 1.25 0 1 0 2.415-.647a1.25 1.25 0 0 0-2.415.647Zm-3.497-9.97a1.25 1.25 0 1 0 2.415-.646a1.25 1.25 0 0 0-2.415.646Z"),
    reload: svgIcon("M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"),
    settings: svgIcon("M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54A.48.48 0 0 0 14.1 2h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.9 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.63-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z"),
    trash: svgIcon("M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"),
    upload: svgIcon("M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"),
    copy: svgIcon("M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"),
    download: svgIcon("M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"),
    link: svgIcon("M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"),
    "chevron-up": svgIcon("M12 7.6l6.3 6.3-1.06 1.06L12 9.72l-5.24 5.24L5.7 13.9z"),
    "chevron-down": svgIcon("M12 16.4L5.7 10.1l1.06-1.06L12 14.28l5.24-5.24 1.06 1.06z"),
    lock: svgIcon("M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 0 1 6 0v3H9z")
  };
  var ALIASES = {
    vol: "volume-1",
    "vol-up": "volume-1",
    "vol-down": "volume-2",
    "vol-mute": "muted",
    mute: "muted",
    unmute: "volume-1",
    playing: "pause",
    paused: "play",
    fwd: "right-arrows",
    forward: "right-arrows",
    back: "left-arrows",
    rewind: "left-arrows",
    fs: "fullscreen",
    "fs-enter": "fullscreen",
    "fs-exit": "exit-fullscreen",
    "fs-exiting": "down-arrow",
    "fs-block": "lock",
    pip: "picture-in-picture",
    cc: "captions",
    restart: "reload",
    gear: "settings",
    delete: "trash",
    remove: "trash",
    load: "upload",
    up: "chevron-up",
    down: "chevron-down",
    inc: "chevron-up",
    dec: "chevron-down"
  };
  function canonicalName(name) {
    return ALIASES[name] ?? (Object.hasOwn(ICONS, name) ? name : null);
  }
  var cache2 = /* @__PURE__ */ new Map();
  function entryFor(canonical, doc) {
    let entry = cache2.get(canonical);
    if (!entry || entry.doc !== doc) {
      const markup = ICONS[canonical];
      let el2 = null;
      const Parser = doc.defaultView?.DOMParser;
      try {
        if (Parser) {
          const parsed = new Parser().parseFromString(markup, "image/svg+xml").documentElement;
          if (parsed) {
            el2 = doc.importNode(parsed, true);
          }
        }
      } catch {
      }
      entry = { markup, el: el2, doc };
      cache2.set(canonical, entry);
    }
    return entry;
  }
  function createIconElement(name, doc = document) {
    const canonical = canonicalName(name);
    if (!canonical) {
      return null;
    }
    return entryFor(canonical, doc).el.cloneNode(true);
  }

  // src/shell/chrome/panel.js
  var HOLD_DELAY_MS = 400;
  var HOLD_REPEAT_MS = 75;
  var TAB_NAV_KEYS = /* @__PURE__ */ new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);
  var COMPACT_MEDIA_QUERY = "(max-width: 480px) and (pointer: coarse)";
  function decimalsOf(step) {
    const str = String(step);
    const dot = str.indexOf(".");
    return dot === -1 ? 0 : str.length - dot - 1;
  }
  function roundTo(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
  }
  function createStepper({
    min = 0,
    max = 100,
    step = 1,
    value,
    label,
    onChange,
    deferTextInput = false,
    signal
  } = {}) {
    const lo = Number(min);
    const hi = Number(max);
    const by = Math.abs(Number(step)) || 1;
    const decimals = Math.max(decimalsOf(by), 0);
    let committed = roundTo(clamp(Number(value ?? min), lo, hi), decimals);
    const root = document.createElement("span");
    root.className = "pf-stepper";
    const input = document.createElement("input");
    input.className = "pf-stepper-input";
    input.type = "text";
    input.setAttribute("inputmode", "decimal");
    input.setAttribute("role", "spinbutton");
    input.setAttribute("aria-valuemin", String(lo));
    input.setAttribute("aria-valuemax", String(hi));
    if (label) {
      input.setAttribute("aria-label", label);
    }
    const arrows = document.createElement("span");
    arrows.className = "pf-stepper-arrows";
    const makeButton = (name, dir, title) => {
      const button2 = document.createElement("button");
      button2.type = "button";
      button2.className = "pf-stepper-btn";
      button2.tabIndex = -1;
      button2.appendChild(createIconElement(name));
      button2.title = title;
      let delayTimer = null;
      let repeatTimer = null;
      const stopRepeat = () => {
        clearTimeout(delayTimer);
        clearInterval(repeatTimer);
        delayTimer = null;
        repeatTimer = null;
      };
      signal?.addEventListener("abort", stopRepeat, { once: true });
      button2.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        if (input.disabled) {
          return;
        }
        nudge(dir);
        delayTimer = setTimeout(() => {
          repeatTimer = setInterval(() => nudge(dir), HOLD_REPEAT_MS);
        }, HOLD_DELAY_MS);
        const release = () => {
          stopRepeat();
          window.removeEventListener("pointerup", release, { passive: true });
          window.removeEventListener("pointercancel", release, { passive: true });
        };
        window.addEventListener("pointerup", release, { passive: true, signal });
        window.addEventListener("pointercancel", release, { passive: true, signal });
      });
      return button2;
    };
    const upButton = makeButton("chevron-up", 1, "Increase");
    const downButton = makeButton("chevron-down", -1, "Decrease");
    arrows.appendChild(upButton);
    arrows.appendChild(downButton);
    const format = (v) => String(roundTo(v, decimals));
    const syncAria = () => {
      input.setAttribute("aria-valuenow", String(committed));
    };
    const showCommitted = () => {
      input.value = format(committed);
    };
    const commit = (rawText) => {
      const parsed = Number.parseFloat(rawText);
      if (!Number.isFinite(parsed)) {
        showCommitted();
        return committed;
      }
      const next = roundTo(clamp(parsed, lo, hi), decimals);
      showCommitted();
      if (next !== committed) {
        committed = next;
        syncAria();
        onChange?.(committed);
      }
      return committed;
    };
    function nudge(dir) {
      commit(format(committed + dir * by));
    }
    input.addEventListener("input", () => {
      if (deferTextInput) {
        return;
      }
      const text = input.value.trim();
      if (!text) {
        return;
      }
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) {
        return;
      }
      const next = roundTo(clamp(parsed, lo, hi), decimals);
      if (next !== committed) {
        committed = next;
        syncAria();
        onChange?.(committed);
      }
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowUp") {
        event.preventDefault();
        nudge(1);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        nudge(-1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        commit(input.value);
        input.blur();
      } else if (event.key === "Escape") {
        event.preventDefault();
        showCommitted();
        input.blur();
      }
    });
    input.addEventListener("blur", () => commit(input.value));
    root.appendChild(input);
    root.appendChild(arrows);
    showCommitted();
    syncAria();
    return {
      root,
      input,
      getValue: () => committed,
      setValue(next) {
        const nextValue = roundTo(clamp(Number(next), lo, hi), decimals);
        if (nextValue === committed) {
          showCommitted();
          return committed;
        }
        committed = nextValue;
        showCommitted();
        syncAria();
        onChange?.(committed);
        return committed;
      },
      setDisabled(disabled) {
        input.disabled = disabled;
        upButton.disabled = disabled;
        downButton.disabled = disabled;
        root.classList.toggle("pf-stepper-disabled", disabled);
      }
    };
  }
  var SettingsPanel = class {
    #hudLayer;
    #shellHost;
    #root = null;
    #body = null;
    #tabList = null;
    #closeButton = null;
    #sections = /* @__PURE__ */ new Map();
    #activeSection = null;
    #sectionCounter = 0;
    /** All panel subscriptions die with this signal. */
    #scope = new AbortController();
    /** Live only while the panel is open: Esc + outside-click dismissal. */
    #dismissScope = null;
    #backdrop = null;
    #destroyed = false;
    #sectionBuilder = null;
    constructor(shell) {
      this.#hudLayer = shell.shellDom?.hudLayer;
      this.#shellHost = shell.shellHost;
      if (!this.#hudLayer || !this.#shellHost) {
        logger.error("panel", "Missing shell DOM - panel not available");
        return;
      }
      this.#buildDom();
      this.#wireEvents();
      logger.log("panel", "Panel ready");
    }
    /**
     * Compact mode: explicit setting wins; otherwise auto-detect touch + narrow
     * viewport (< 480px). A matchMedia change listener in #wireEvents re-applies
     * the class live when the viewport crosses the breakpoint; the setting
     * override still wins for the explicit (undirected) path.
     */
    #isCompactMode() {
      const explicit = getSetting("ui.compact");
      if (explicit === true || explicit === false) return explicit;
      return matchMedia(COMPACT_MEDIA_QUERY).matches;
    }
    get element() {
      return this.#root;
    }
    get body() {
      return this.#body;
    }
    get isOpen() {
      return !!this.#root && this.#root.classList.contains("pf-open");
    }
    /** Register a lazy builder that populates sections on first open. */
    setSectionBuilder(fn) {
      this.#sectionBuilder = fn;
    }
    async open() {
      if (!this.#root || this.#destroyed || this.isOpen) {
        return;
      }
      if (this.#sectionBuilder) {
        const build = this.#sectionBuilder;
        this.#sectionBuilder = null;
        await build();
      }
      if (!this.#body.childElementCount) {
        return;
      }
      this.#armDismissal();
      this.#runWithViewTransition("pf-panel-open", () => {
        this.#root.classList.toggle("pf-compact", this.#isCompactMode());
        this.#root.classList.add("pf-open");
        const activeTab = this.#root.querySelector(".pf-panel-tab-active") || this.#closeButton;
        if (activeTab && deepestActiveElement(this.#shellHost) !== activeTab) {
          activeTab.focus();
        }
      });
    }
    close() {
      if (this.#root && !this.#destroyed && this.isOpen) {
        this.#runWithViewTransition("pf-panel-close", () => {
          this.#root.classList.remove("pf-open");
          if (this.#shellHost && this.#root.contains(deepestActiveElement(this.#shellHost))) {
            this.#shellHost.focus();
          }
        });
        this.#teardownDismissal();
      }
    }
    toggle() {
      if (this.isOpen) {
        this.close();
      } else {
        this.open();
      }
    }
    /**
     * Esc + outside-click dismissal exists only while the panel is open. Arming
     * it per open() keeps two document listeners out of the page's hot path for
     * shells whose panel is never (or rarely) opened; close()/destroy() abort
     * the per-open scope, so they die with the open state.
     */
    #armDismissal() {
      if (this.#dismissScope || this.#destroyed) {
        return;
      }
      this.#dismissScope = new AbortController();
      const { signal } = this.#dismissScope;
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          this.close();
        }
      }, { signal });
      document.addEventListener("pointerdown", (event) => {
        if (event.composedPath().includes(this.#shellHost)) {
          return;
        }
        this.close();
      }, { signal, capture: true });
    }
    #teardownDismissal() {
      this.#dismissScope?.abort();
      this.#dismissScope = null;
    }
    async openSection(title) {
      if (!this.#root || this.#destroyed) {
        return false;
      }
      if (this.#sectionBuilder) {
        const build = this.#sectionBuilder;
        this.#sectionBuilder = null;
        await build();
      }
      for (const [section, tab] of this.#sections) {
        if (section.dataset.title === title) {
          this.#activateSection(section, tab);
          await this.open();
          return true;
        }
      }
      return false;
    }
    /** Add a section; returns the section root (or null when unusable). */
    addSection(title, icon) {
      if (!this.#root || this.#destroyed) {
        return null;
      }
      const sectionId = `pf-panel-section-${++this.#sectionCounter}`;
      const section = document.createElement("div");
      section.className = "pf-panel-section";
      section.id = sectionId;
      section.hidden = true;
      section.setAttribute("role", "tabpanel");
      section.setAttribute("aria-labelledby", `pf-panel-tab-${this.#sectionCounter}`);
      this.#body.appendChild(section);
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "pf-panel-tab";
      tab.id = `pf-panel-tab-${this.#sectionCounter}`;
      tab.dataset.title = title;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", "false");
      tab.setAttribute("aria-controls", sectionId);
      if (icon) {
        const iconEl = createIconElement(icon);
        if (iconEl) {
          tab.appendChild(iconEl);
        }
      }
      const label = document.createElement("span");
      label.className = "pf-tab-label";
      label.textContent = title;
      tab.appendChild(label);
      tab.addEventListener("click", () => this.#activateSection(section, tab), { signal: this.#scope.signal });
      this.#tabList.appendChild(tab);
      this.#sections.set(section, tab);
      if (!this.#activeSection) {
        this.#activateSection(section, tab);
      }
      return section;
    }
    /** Generic escape hatch: create + attribute + append in one call. */
    el(tag, attrs = {}, parent = this.#body) {
      return el(tag, attrs, parent);
    }
    addLabel(parent, text) {
      const node = this.el("span", { class: "pf-panel-label" }, parent);
      node.textContent = text;
      return node;
    }
    addHint(parent, text = "") {
      const node = this.el("div", { class: "pf-panel-hint" }, parent);
      node.textContent = text;
      return node;
    }
    /**
     * Unified declarative control builder - the routing core behind the
     * single-purpose add* wrappers. `type` selects the widget; every other
     * option is one key in one superset object, so callers pass exactly the
     * fields their control reads (unused keys are ignored).
     *
     *   Common        label, onChange, disabled
     *   button:       icon, title, ariaLabel, ghost
     *   checkbox:     checked
     *   color:        value (hex)
     *   select:       options ([value] or [value,label]), value
     *   stepper:      min, max, step, value, format, deferTextInput, head, class
     *
     * Returns the same per-widget handle the matching add* wrapper returns:
     * button -> <button>, checkbox -> <input>, select -> <select>,
     * color   -> { input, getValue, setValue },
     * stepper -> { root, input, getValue, setValue, setDisabled }.
     */
    addControl(parent, { type, ...opts } = {}) {
      switch (type) {
        case "button":
          return this.addButton(parent, opts);
        case "checkbox":
          return this.addCheckbox(parent, opts);
        case "color":
          return this.addColor(parent, opts);
        case "select":
          return this.addSelect(parent, opts);
        case "stepper":
          return this.addStepper(parent, opts);
        default:
          logger.warn("panel", `addControl: unknown type "${type}"`);
          return null;
      }
    }
    addButton(parent, { icon, title, ariaLabel, ghost, onClick, disabled } = {}) {
      const button2 = this.el("button", {
        class: ghost ? "pf-btn pf-btn-ghost pf-btn-icon" : "pf-btn pf-btn-icon",
        type: "button"
      }, parent);
      if (icon) {
        const iconEl = createIconElement(icon);
        if (iconEl) {
          button2.appendChild(iconEl);
        }
      }
      if (title) {
        button2.title = title;
      }
      if (ariaLabel) {
        button2.setAttribute("aria-label", ariaLabel);
      }
      if (disabled) {
        button2.disabled = true;
      }
      button2.addEventListener("click", onClick);
      return button2;
    }
    /**
     * Labeled numeric stepper with a live formatted value display.
     * Renders a grid cell by default; pass `class` for custom containers
     * or `head: true` for the stacked label-over-stepper layout.
     */
    addStepper(parent, {
      label,
      min = 0,
      max = 100,
      step = 1,
      value,
      _format = String,
      onChange,
      deferTextInput = false,
      class: className,
      head,
      disabled = false
    } = {}) {
      const cell = this.el("div", { class: className || "pf-panel-cell" }, parent);
      const stepper = createStepper({
        min,
        max,
        step,
        value,
        label,
        deferTextInput,
        onChange,
        signal: this.#scope.signal
      });
      if (head) {
        const cellHead = this.el("div", { class: "pf-panel-cell-head" }, cell);
        this.addLabel(cellHead, label);
        cell.appendChild(stepper.root);
      } else {
        this.addLabel(cell, label);
        cell.appendChild(stepper.root);
      }
      if (disabled) {
        stepper.setDisabled(true);
      }
      return stepper;
    }
    addCheckbox(parent, { checked = false, onChange, disabled = false } = {}) {
      const attrs = { type: "checkbox" };
      if (disabled) attrs.disabled = "";
      const input = this.el("input", attrs, parent);
      input.checked = checked;
      input.addEventListener("change", () => onChange?.(input.checked));
      return input;
    }
    addColor(parent, { label, value = "#ffffff", onChange, disabled = false } = {}) {
      const cell = this.el("div", { class: "pf-panel-cell" }, parent);
      this.addLabel(cell, label);
      const attrs = { type: "color", value };
      if (disabled) attrs.disabled = "";
      const input = this.el("input", attrs, cell);
      const apply = (v) => {
        onChange?.(v);
      };
      input.addEventListener("input", () => apply(input.value));
      return {
        input,
        getValue: () => input.value,
        setValue(next) {
          if (input.value !== next) {
            input.value = next;
            apply(next);
          }
        }
      };
    }
    addSelect(parent, { options = [], value, onChange, disabled = false } = {}) {
      const attrs = { class: "pf-select" };
      if (disabled) attrs.disabled = "";
      const select = this.el("select", attrs, parent);
      for (const entry of options) {
        const [optValue, optLabel] = Array.isArray(entry) ? entry : [entry, entry];
        const option = document.createElement("option");
        option.value = optValue;
        option.textContent = optLabel;
        select.appendChild(option);
      }
      select.value = value;
      select.addEventListener("change", () => onChange?.(select.value));
      return select;
    }
    destroy() {
      if (!this.#destroyed) {
        this.#destroyed = true;
        this.#teardownDismissal();
        this.#scope.abort();
        this.#root?.remove();
        this.#root = null;
        this.#backdrop?.remove();
        this.#backdrop = null;
        this.#body = null;
        this.#tabList = null;
        this.#sections.clear();
        this.#activeSection = null;
      }
    }
    #buildDom() {
      const backdrop = document.createElement("div");
      backdrop.className = "pf-panel-backdrop";
      backdrop.setAttribute("aria-hidden", "true");
      backdrop.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
        this.close();
      }, { signal: this.#scope.signal });
      this.#hudLayer.appendChild(backdrop);
      this.#backdrop = backdrop;
      const root = document.createElement("div");
      root.className = "pf-panel";
      root.setAttribute("role", "dialog");
      root.setAttribute("aria-modal", "false");
      root.setAttribute("aria-label", "PlayerForge controls");
      if (this.#isCompactMode()) {
        root.classList.add("pf-compact");
      }
      const header = document.createElement("div");
      header.className = "pf-panel-header";
      const tabList = document.createElement("div");
      tabList.className = "pf-panel-tabs";
      tabList.setAttribute("role", "tablist");
      tabList.setAttribute("aria-label", "PlayerForge sections");
      const closeButton = document.createElement("button");
      closeButton.className = "pf-panel-close";
      closeButton.type = "button";
      closeButton.title = "Close";
      closeButton.setAttribute("aria-label", "Close panel");
      closeButton.textContent = "✕";
      header.appendChild(tabList);
      header.appendChild(closeButton);
      this.#tabList = tabList;
      const body = document.createElement("div");
      body.className = "pf-panel-body";
      root.appendChild(header);
      root.appendChild(body);
      this.#hudLayer.appendChild(root);
      this.#root = root;
      this.#body = body;
      this.#closeButton = closeButton;
      closeButton.addEventListener("click", () => this.close(), { signal: this.#scope.signal });
    }
    #wireEvents() {
      const { signal } = this.#scope;
      matchMedia(COMPACT_MEDIA_QUERY).addEventListener("change", () => {
        if (this.isOpen) {
          this.#root.classList.toggle("pf-compact", this.#isCompactMode());
        }
      }, { signal });
      this.#shellHost.addEventListener(GESTURE_EVENTS.panel, (event) => {
        event.stopPropagation();
        this.toggle();
      }, { signal });
      this.#shellHost.addEventListener(GESTURE_EVENTS.swipe, (event) => {
        if (event.detail?.direction === "up") {
          this.toggle();
        }
      }, { signal });
      for (const type of ["pointerdown", "pointerup", "click", "touchstart", "touchend"]) {
        this.#root.addEventListener(type, (event) => {
          event.stopPropagation();
        }, { signal });
      }
      subscribeFullscreen(() => this.close(), this.#scope.signal);
      this.#tabList.addEventListener("keydown", (event) => {
        if (!TAB_NAV_KEYS.has(event.key)) {
          return;
        }
        const tabNodes = this.#tabList.querySelectorAll(".pf-panel-tab");
        if (!tabNodes.length) {
          return;
        }
        let currentIndex = -1;
        const active = deepestActiveElement(this.#shellHost);
        for (let i = 0; i < tabNodes.length; i++) {
          if (tabNodes[i] === active) {
            currentIndex = i;
            break;
          }
        }
        if (currentIndex === -1) {
          return;
        }
        event.preventDefault();
        let nextIndex = currentIndex;
        if (event.key === "ArrowLeft") {
          nextIndex = (currentIndex - 1 + tabNodes.length) % tabNodes.length;
        } else if (event.key === "ArrowRight") {
          nextIndex = (currentIndex + 1) % tabNodes.length;
        } else if (event.key === "Home") {
          nextIndex = 0;
        } else if (event.key === "End") {
          nextIndex = tabNodes.length - 1;
        }
        const nextTab = tabNodes[nextIndex];
        let targetSection = null;
        for (const [section, tab] of this.#sections) {
          if (tab === nextTab) {
            targetSection = section;
            break;
          }
        }
        nextTab.focus();
        if (targetSection) {
          this.#activateSection(targetSection, nextTab);
        }
      }, { signal });
    }
    #activateSection(targetSection, _targetTab) {
      const prev = this.#activeSection;
      if (prev === targetSection) {
        return;
      }
      if (prev) {
        const prevTab = this.#sections.get(prev);
        if (prevTab) {
          prev.hidden = true;
          prevTab.classList.remove("pf-panel-tab-active");
          prevTab.setAttribute("aria-selected", "false");
        }
      }
      targetSection.hidden = false;
      const targetTab = this.#sections.get(targetSection);
      if (targetTab) {
        targetTab.classList.add("pf-panel-tab-active");
        targetTab.setAttribute("aria-selected", "true");
      }
      this.#activeSection = targetSection;
    }
    #runWithViewTransition(type, update) {
      if (typeof document.startViewTransition === "function") {
        document.startViewTransition({ types: [type], update });
      } else {
        update();
      }
    }
  };

  // src/shared/dom-pool.js
  var DomPool = class {
    /** Factory: creates a fresh element (not attached to any parent). */
    #factory;
    /** Reset: clears recycled element state (textContent, classes, styles). */
    #reset;
    /** Available elements ready for reuse. */
    #available;
    /**
     * @param {{ factory: () => HTMLElement, reset: (el: HTMLElement) => HTMLElement, initial?: number }}
     */
    constructor({ factory, reset, initial = 0 }) {
      this.#factory = factory;
      this.#reset = reset;
      this.#available = [];
      for (let i = 0; i < initial; i++) {
        this.#available.push(factory());
      }
    }
    /** Get a pooled element (reset) or create a new one. */
    acquire() {
      return this.#available.length > 0 ? this.#reset(this.#available.pop()) : this.#factory();
    }
    /** Return an element to the pool for reuse. Caller must detach first. */
    release(element) {
      this.#available.push(element);
    }
    /** Drop elements beyond `keep` count. Removes excess from DOM. */
    shrink(keep) {
      while (this.#available.length > keep) {
        this.#available.pop().remove();
      }
    }
    /** Remove all pooled elements from DOM and empty the pool. */
    destroy() {
      for (const el2 of this.#available) {
        el2.remove();
      }
      this.#available.length = 0;
    }
    /** Number of elements currently available for reuse. */
    get idle() {
      return this.#available.length;
    }
  };

  // src/shell/chrome/history.js
  function formatDomain(domain) {
    if (!domain) return "";
    return domain.charAt(0).toUpperCase() + domain.slice(1);
  }
  function addHistorySection(panel, shell) {
    const sectionRoot = panel.addSection("History", "resume");
    if (!sectionRoot) {
      return;
    }
    const list = panel.el("div", { class: "pf-history-list" }, sectionRoot);
    const hint = panel.el("div", { class: "pf-panel-hint" }, sectionRoot);
    hint.textContent = "No watch history yet";
    const activeCards = [];
    const cardPool = new DomPool({
      factory: () => {
        const card = panel.el("div", { class: "pf-history-card" });
        const info = panel.el("div", { class: "pf-history-info" }, card);
        panel.el("div", { class: "pf-history-title" }, info);
        panel.el("div", { class: "pf-history-meta" }, info);
        const actions = panel.el("div", { class: "pf-history-actions" }, card);
        button({
          class: "pf-btn pf-btn-icon pf-btn-ghost",
          title: "Reset",
          "aria-label": "Reset resume position",
          "data-action": "reset",
          icon: createIconElement("reload")
        }, actions);
        button({
          class: "pf-btn pf-btn-icon pf-btn-ghost",
          title: "Remove",
          "aria-label": "Remove from history",
          "data-action": "remove",
          icon: createIconElement("trash")
        }, actions);
        return card;
      },
      reset: (card) => {
        card.dataset.entryId = "";
        const info = card.querySelector(".pf-history-info");
        info.querySelector(".pf-history-title").textContent = "";
        info.querySelector(".pf-history-meta").textContent = "";
        return card;
      }
    });
    list.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-action]");
      const card = event.target.closest(".pf-history-card");
      if (!btn || !card) {
        return;
      }
      if (btn.dataset.action === "reset") {
        shell.resume?.resetEntry(card.dataset.entryId);
        flashElement(btn);
        shell.toastInfo("reload", "Resume Entry Reset", "history");
      } else if (btn.dataset.action === "remove") {
        shell.resume?.removeEntry(card.dataset.entryId);
        shell.toastInfo("trash", "Resume Entry Removed", "history");
      }
    });
    function render() {
      const entries = shell.resume?.getEntries() || [];
      while (activeCards.length > entries.length) {
        const card = activeCards.pop();
        card.remove();
        cardPool.release(card);
      }
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        let card = activeCards[i];
        if (!card) {
          card = cardPool.acquire();
          activeCards.push(card);
          list.appendChild(card);
        }
        renderCard(entry, card);
      }
      hint.hidden = entries.length > 0;
      if (cardPool.idle > entries.length * 2) {
        cardPool.shrink(entries.length);
      }
    }
    function renderCard(entry, card) {
      card.dataset.entryId = entry.id;
      const info = card.querySelector(".pf-history-info");
      const title = info.querySelector(".pf-history-title");
      title.textContent = entry.title || formatDomain(entry.domain);
      const meta = info.querySelector(".pf-history-meta");
      const parts = [formatDomain(entry.domain)];
      if (entry.duration > 0) {
        parts.push(formatTime(entry.duration));
      }
      meta.textContent = parts.join(" · ");
    }
    render();
    shell.resume?.onChange?.((structural) => {
      if (structural) {
        render();
      }
    });
    return { render };
  }

  // src/shell/chrome/toast.js
  var ToastManager = class {
    #pool;
    #toast;
    #icon;
    #text;
    #actions;
    /** DOM lifecycle manager: pool and timer cleanup on destroy. */
    #dom = new DOMManager();
    /** Cancel handle for the pending auto-hide, null when none is scheduled. */
    #cancelAutoHide = null;
    /** Stable auto-hide callback, cached so show() never re-creates a closure. */
    #autoHide = () => {
      this.#cancelAutoHide = null;
      this.#toast.classList.remove("pf-visible");
    };
    #activeGroup = null;
    constructor(hudLayer) {
      const doc = hudLayer.ownerDocument;
      this.#pool = new DomPool({
        initial: 1,
        factory: () => {
          const toast = doc.createElement("pf-toast");
          const icon = doc.createElement("span");
          icon.className = "pf-toast-icon";
          const text = doc.createElement("span");
          text.className = "pf-toast-text";
          const actions = doc.createElement("span");
          actions.className = "pf-toast-actions";
          toast.appendChild(icon);
          toast.appendChild(text);
          toast.appendChild(actions);
          toast.style.pointerEvents = "none";
          hudLayer.appendChild(toast);
          return toast;
        },
        reset: (toast) => {
          toast.style.pointerEvents = "none";
          toast.style.color = "";
          return toast;
        }
      });
      this.#toast = this.#pool.acquire();
      this.#icon = this.#toast.querySelector(".pf-toast-icon");
      this.#text = this.#toast.querySelector(".pf-toast-text");
      this.#actions = this.#toast.querySelector(".pf-toast-actions");
    }
    show({ icon, text, duration = 0, color, group: group2, actions } = {}) {
      this.#activeGroup = group2 ?? null;
      this.#icon.textContent = "";
      const iconEl = icon ? createIconElement(icon, this.#icon.ownerDocument) : null;
      if (iconEl) {
        this.#icon.appendChild(iconEl);
      }
      this.#icon.style.display = iconEl ? "" : "none";
      this.#text.textContent = text || "";
      this.#text.style.display = text ? "" : "none";
      if (actions && actions.length) {
        this.#actions.textContent = "";
        const doc = this.#actions.ownerDocument;
        for (const action of actions) {
          const buttonEl = button({
            title: action.title ?? action.label ?? "",
            icon: action.icon ? createIconElement(action.icon, doc) : null
          }, this.#actions);
          if (!action.icon) {
            buttonEl.textContent = action.label;
          }
          buttonEl.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            flashElement(buttonEl);
            action.onClick?.();
          });
        }
        this.#actions.style.display = "";
        this.#toast.style.pointerEvents = "auto";
      } else {
        this.#actions.textContent = "";
        this.#actions.style.display = "none";
        this.#toast.style.pointerEvents = "";
      }
      this.#toast.style.color = color || "";
      this.#toast.classList.add("pf-visible");
      this.#cancelAutoHide?.();
      this.#cancelAutoHide = duration > 0 ? delay(this.#autoHide, duration) : null;
    }
    hide(group2) {
      if (group2 === void 0 || group2 === this.#activeGroup) {
        this.#cancelAutoHide?.();
        this.#cancelAutoHide = null;
        this.#toast.classList.remove("pf-visible");
      }
    }
    destroy() {
      this.#dom.destroy();
      this.#cancelAutoHide?.();
      this.#cancelAutoHide = null;
      this.#pool.destroy();
    }
  };

  // src/shell/media.js
  var VOLUME_STEP = 0.1;
  function createMediaControls({ video }) {
    const isReady = () => video.readyState >= 1;
    const canSeek = () => isReady() || Number.isFinite(video.duration) && video.duration > 0;
    const clampTarget = (time) => {
      if (!Number.isFinite(time)) {
        return 0;
      }
      return Number.isFinite(video.duration) && video.duration > 0 ? clamp(time, 0, video.duration) : Math.max(0, time);
    };
    return {
      async play() {
        if (!isReady()) {
          return;
        }
        try {
          await video.play();
        } catch (err) {
          if (err.name !== "AbortError" && err.name !== "NotAllowedError") {
            throw err;
          }
        }
      },
      pause() {
        if (!isReady()) {
          return;
        }
        video.pause();
      },
      togglePlay() {
        if (!isReady()) {
          return;
        }
        if (video.paused) {
          return this.play();
        }
        this.pause();
      },
      stop() {
        if (!isReady()) {
          return;
        }
        video.pause();
        video.currentTime = 0;
      },
      /** Seek to an absolute position, clamped to the playable range. */
      seekTo(time) {
        if (!canSeek()) {
          return;
        }
        video.currentTime = clampTarget(time);
      },
      /** Silent seek alias for scrub drags - same clamp, no command chatter. */
      scrubTo(time) {
        this.seekTo(time);
      },
      /**
       * Latched scrub seek for an in-progress drag session. Readiness was
       * already verified and `duration` captured when the stroke latched, so
       * this skips the per-move isReady() gate and re-reading video.duration
       * (native getter) - the single most frequent user-facing path.
       */
      scrubToLatched(time, duration) {
        video.currentTime = Number.isFinite(duration) && duration > 0 ? clamp(time, 0, duration) : Math.max(0, time);
      },
      skip(delta) {
        if (!isReady()) {
          return;
        }
        this.seekTo(video.currentTime + delta);
      },
      nudgeVolume(direction) {
        if (!isReady()) {
          return;
        }
        const step = direction === "up" ? VOLUME_STEP : -VOLUME_STEP;
        video.volume = clamp(video.volume + step, 0, 1);
      },
      setVolume(value) {
        if (!isReady()) {
          return;
        }
        video.volume = clamp(value, 0, 1);
      },
      toggleMute() {
        if (!isReady()) {
          return;
        }
        video.muted = !video.muted;
      },
      /** Native PiP availability: the browser's own always-on-top surface. */
      pictureInPictureSupported() {
        return typeof video.requestPictureInPicture === "function" && typeof document.pictureInPictureEnabled === "boolean" && document.pictureInPictureEnabled;
      },
      /**
       * Toggle the native picture-in-picture window. Entering needs a user
       * gesture (hotkeys/panel qualify); the PiP window owns its own controls.
       * Returns whether PiP is active afterwards. Rejects that are ordinary
       * browser policy (AbortError/NotAllowedError) surface as `false`; real
       * failures throw for the caller to present.
       */
      async togglePictureInPicture() {
        if (!isReady() || !this.pictureInPictureSupported()) {
          return false;
        }
        try {
          if (document.pictureInPictureElement === video) {
            await document.exitPictureInPicture();
          } else {
            await video.requestPictureInPicture();
          }
        } catch (err) {
          if (err.name !== "AbortError" && err.name !== "NotAllowedError") {
            throw err;
          }
        }
        return document.pictureInPictureElement === video;
      },
      /** Hold-to-fast-forward pair; `speed` is restored verbatim on release. */
      beginBoost(speed) {
        if (!isReady()) {
          return;
        }
        video.playbackRate = speed;
      },
      endBoost(speed) {
        if (!isReady()) {
          return;
        }
        video.playbackRate = speed;
      }
    };
  }
  var MEDIA_SESSION_SYNC_EVENTS = /* @__PURE__ */ new Set([
    "play",
    "pause",
    "playing",
    "ended",
    "seeked",
    "durationchange",
    "ratechange",
    "volumechange",
    "loadedmetadata",
    "timeupdate"
  ]);
  var SESSION_ACTIONS = ["play", "pause", "stop", "seekbackward", "seekforward", "seekto"];
  var CLEAR_ACTIONS = [...SESSION_ACTIONS, "previoustrack", "nexttrack"];
  var sessionOwner = null;
  function buildSessionMetadata(video) {
    const artwork = video.poster && URL.canParse(video.poster, location.href) ? [{ src: new URL(video.poster, location.href).href }] : [];
    const title = document.title?.trim();
    if (!title && !artwork.length) {
      return null;
    }
    return new MediaMetadata({
      title: title || void 0,
      artist: location.hostname || void 0,
      artwork
    });
  }
  function claimMediaSession({ controls, video, signal, session = navigator.mediaSession }) {
    if (!session) {
      return null;
    }
    sessionOwner?.destroy();
    const bridge = new MediaSessionBridge(session, controls, video);
    sessionOwner = bridge;
    bridge.attach(signal);
    return bridge;
  }
  var MediaSessionBridge = class {
    #session;
    #controls;
    #video;
    #destroyed = false;
    /**
     * Pre-detected once at construction: setPositionState is absent on some
     * host surfaces, and sync() rides the ~4 Hz media clock - a hoisted boolean
     * keeps the hot path free of per-tick try/catch.
     */
    #canSetPositionState = false;
    constructor(session, controls, video) {
      this.#session = session;
      this.#controls = controls;
      this.#video = video;
      this.#canSetPositionState = typeof session?.setPositionState === "function";
    }
    /** Wire handlers, metadata refresh, and signal teardown. Called once by claim. */
    attach(signal) {
      const session = this.#session;
      const controls = this.#controls;
      const video = this.#video;
      session.setActionHandler("play", () => controls.play());
      session.setActionHandler("pause", () => controls.pause());
      session.setActionHandler("stop", () => controls.stop());
      session.setActionHandler("seekbackward", (details) => controls.skip(-(details?.seekOffset || 10)));
      session.setActionHandler("seekforward", (details) => controls.skip(details?.seekOffset || 10));
      session.setActionHandler("seekto", (details) => {
        if (details?.seekTime != null) {
          if (details.fastSeek) {
            video.fastSeek(details.seekTime);
          } else {
            controls.seekTo(details.seekTime);
          }
        }
      });
      session.playbackState = this.#video.paused ? "paused" : "playing";
      this.sync();
      this.#video.addEventListener("loadedmetadata", () => this.#refreshMetadata(), { signal });
      this.#refreshMetadata();
      signal.addEventListener("abort", () => this.destroy(), { once: true });
      logger.log("media", "MediaSession claimed - handlers registered");
    }
    /** Reused scratch for setPositionState - the API copies the values, so a
     *  mutable object reused across sync() calls avoids a per-event allocation
     *  on the ~4 Hz media clock (same rationale as the forge's pooled event). */
    #positionState = { duration: 0, playbackRate: 0, position: 0 };
    /** playbackState plus guarded position state; safe to call per event batch. */
    sync() {
      if (this.#destroyed) {
        return;
      }
      const session = this.#session;
      session.playbackState = this.#video.paused ? "paused" : "playing";
      const { duration, playbackRate, currentTime } = this.#video;
      if (this.#canSetPositionState && Number.isFinite(duration) && duration > 0) {
        const state = this.#positionState;
        state.duration = duration;
        state.playbackRate = playbackRate;
        state.position = currentTime < duration ? currentTime : duration;
        session.setPositionState(state);
      }
    }
    destroy() {
      if (this.#destroyed) {
        return;
      }
      this.#destroyed = true;
      if (sessionOwner === this) {
        sessionOwner = null;
      }
      for (const action of CLEAR_ACTIONS) {
        try {
          this.#session.setActionHandler(action, null);
        } catch {
        }
      }
      this.#session.playbackState = "none";
      this.#session.metadata = null;
      logger.log("media", "MediaSession released");
    }
    #refreshMetadata() {
      if (this.#destroyed) {
        return;
      }
      try {
        this.#session.metadata = buildSessionMetadata(this.#video);
      } catch {
      }
    }
  };

  // src/shell/chrome/styles.css
  var styles_default = `.pf-shell{--pf-fg:#fff;--pf-bg:#000;--pf-accent:#4a9eff;--pf-hud-glass:color-mix(in srgb,var(--pf-bg)82%,transparent);--pf-surface:rgba(0,0,0,0.8);--pf-surface-soft:rgba(255,255,255,0.04);--pf-surface-mid:rgba(255,255,255,0.09);--pf-surface-strong:rgba(255,255,255,0.16);--pf-border:rgba(255,255,255,0.14);--pf-border-soft:rgba(255,255,255,0.1);--pf-border-control:rgba(255,255,255,0.18);--pf-border-input:rgba(255,255,255,0.2);--pf-text-dim:rgba(255,255,255,0.6);--pf-text-mid:rgba(255,255,255,0.7);--pf-text-soft:rgba(255,255,255,0.65);--pf-radius-pill:999px;--pf-radius-lg:12px;--pf-radius-md:8px;--pf-radius-sm:6px;--pf-radius-xs:7px;--pf-font-xs:11px;--pf-font-sm:12px;--pf-font-md:13px;--pf-font-lg:14px;--pf-ease-duration:0.18s;--pf-ease-curve:cubic-bezier(0.22,1,0.36,1);--pf-ease-bounce:0.25s cubic-bezier(0.34,1.56,0.64,1);--pf-ease-out:0.2s cubic-bezier(0.4,0,1,1);--pf-blur-sm:blur(12px)saturate(1.3);--pf-blur-lg:blur(16px)saturate(1.4);--pf-space-xs:4px;--pf-space-sm:6px;--pf-space-md:8px;--pf-space-lg:10px;--pf-panel-bg:var(--pf-hud-glass);--pf-toast-bg:var(--pf-hud-glass);--pf-z-hud:2;--pf-z-toast:3;--pf-z-panel:4;position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483647;outline:none;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:var(--pf-font-lg);color:var(--pf-fg);box-sizing:border-box;*,*::before,*::after{box-sizing:border-box;}}.pf-shell[data-pf-cpu-tier="low"]{--pf-hud-glass:var(--pf-surface);--pf-blur-sm:none;--pf-blur-lg:none;--pf-panel-bg:var(--pf-surface);--pf-toast-bg:var(--pf-surface);}[data-pf-shell]:fullscreen{position:fixed !important;inset:0 !important;width:100% !important;height:100% !important;}@property --pf-cue-top{syntax:"<length-percentage>";inherits:false;initial-value:85%;}@property --pf-cue-left{syntax:"<length-percentage>";inherits:false;initial-value:50%;}@property --pf-cue-x{syntax:"<length-percentage>";inherits:false;initial-value:-50%;}@layer pf-hud{@scope(.pf-hud-layer){:scope{position:absolute;inset:0;pointer-events:none;z-index:var(--pf-z-hud);contain:layout style;> *{pointer-events:auto;}> .pf-cue-layer{pointer-events:none;}}@property --pf-media-paused{syntax:"<number>";inherits:true;initial-value:0;}@property --pf-media-muted{syntax:"<number>";inherits:true;initial-value:0;}:scope > .pf-panel-backdrop{position:absolute;inset:0;z-index:var(--pf-z-hud);pointer-events:none;}:scope:has(.pf-panel.pf-open)> .pf-panel-backdrop{pointer-events:auto;}.pf-cue-layer{--pf-cue-color:#fff;--pf-cue-font-family:inherit;--pf-cue-font-size:1.2em;--pf-cue-font-weight:500;--pf-cue-line-height:1.4;--pf-cue-text-shadow:1px 1px 3px rgba(0,0,0,0.9);--pf-cue-top:85%;--pf-cue-left:50%;--pf-cue-x:-50%;position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:var(--pf-z-hud);contain:layout paint;}.pf-cue{position:absolute;top:var(--pf-cue-top,85%);left:var(--pf-cue-left,50%);transform:translateX(var(--pf-cue-x,-50%));max-width:80%;color:var(--pf-cue-color,#fff);font-family:var(--pf-cue-font-family,inherit);font-size:var(--pf-cue-font-size,1.2em);font-weight:var(--pf-cue-font-weight,500);line-height:var(--pf-cue-line-height,1.4);text-shadow:var(--pf-cue-text-shadow,1px 1px 3px rgba(0,0,0,0.9));white-space:pre-wrap;text-align:center;pointer-events:none;&[hidden]{display:none !important;}}pf-toast{--pf-toast-bg:var(--pf-surface);--pf-toast-color:var(--pf-fg);--pf-toast-radius:var(--pf-radius-pill);display:inline-flex;align-items:center;gap:var(--pf-space-sm);position:absolute;top:12px;left:50%;z-index:var(--pf-z-toast);will-change:opacity,translate;translate:-50%;background:var(--pf-toast-bg);backdrop-filter:var(--pf-blur-sm);color:var(--pf-toast-color);padding:6px 16px;border-radius:var(--pf-toast-radius);font-size:var(--pf-font-lg);font-weight:500;line-height:1;max-width:min(92%,440px);white-space:nowrap;overflow:hidden;pointer-events:none;opacity:0;transform:translateY(-4px);transition:opacity var(--pf-ease-duration)var(--pf-ease-curve),transform var(--pf-ease-duration)var(--pf-ease-curve);&.pf-visible{opacity:calc(1 - 0.3 * var(--pf-media-paused,0));transform:translateY(0);}.pf-toast-icon{display:inline-flex;align-items:center;justify-content:center;width:1.1em;height:1.1em;flex-shrink:0;fill:currentColor;}.pf-toast-text{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;}.pf-toast-actions{display:inline-flex;align-items:center;gap:var(--pf-space-xs);margin-left:var(--pf-space-xs);button{border:none;border-radius:var(--pf-radius-pill);background:var(--pf-surface-strong);color:inherit;font-size:var(--pf-font-sm);font-weight:600;line-height:1;padding:6px 10px;cursor:pointer;&:hover{background:rgba(255,255,255,0.28);}&:has(svg){display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;}svg{display:block;width:14px;height:14px;fill:currentColor;}}}}.pf-panel{container-type:inline-size;container-name:pf-panel;contain:layout style;position:absolute;z-index:var(--pf-z-panel);padding:0;display:none;left:0;right:0;top:0;bottom:0;margin:auto;width:min(380px,calc(100% - 24px));height:fit-content;max-height:calc(100% - 24px);overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--pf-text-mid)transparent;background:var(--pf-panel-bg);backdrop-filter:var(--pf-blur-lg);color:var(--pf-fg);border-radius:var(--pf-radius-lg);font-size:var(--pf-font-md);line-height:1.4;opacity:0;translate:0 12px;scale:0.98;transition:opacity var(--pf-ease-duration)var(--pf-ease-curve),translate var(--pf-ease-duration)var(--pf-ease-curve),scale var(--pf-ease-duration)var(--pf-ease-curve),display var(--pf-ease-duration)allow-discrete;&.pf-open{display:block;opacity:1;translate:0 0;scale:1;will-change:opacity,translate,scale;view-transition-name:pf-panel;pointer-events:auto;}.pf-panel-header{display:flex;align-items:center;gap:var(--pf-space-md);padding:var(--pf-space-md);border-bottom:1px solid var(--pf-border-soft);}.pf-panel-tabs{flex:1;min-width:0;display:flex;justify-content:space-evenly;padding:3px;border:1px solid var(--pf-border-soft);border-radius:var(--pf-space-lg);background:var(--pf-surface-mid);.pf-panel-tab{flex:0 1 auto;min-width:0;display:inline-flex;align-items:center;justify-content:center;gap:3px;padding:6px 7px;border:none;border-radius:var(--pf-radius-xs);background:transparent;color:var(--pf-text-mid);font-size:var(--pf-font-xs);white-space:nowrap;cursor:pointer;outline:none;svg{width:13px;height:13px;flex:none;fill:currentColor;}&:hover{background:transparent;color:var(--pf-fg);}}}.pf-panel-close{flex:none;border:none;background:transparent;color:var(--pf-text-mid);font-size:15px;line-height:1;cursor:pointer;padding:5px 8px;border-radius:var(--pf-radius-xs);&:hover{background:var(--pf-border);color:var(--pf-fg);}&:focus-visible{outline:2px solid var(--pf-accent);outline-offset:-2px;}}.pf-panel-body{padding:var(--pf-space-sm)var(--pf-space-md)var(--pf-space-lg);}.pf-panel-section{margin-bottom:var(--pf-space-sm);&[hidden]{display:none;}&:last-child{margin-bottom:0;}&.pf-drop-active{outline:2px dashed var(--pf-accent);outline-offset:-4px;border-radius:var(--pf-radius-md);background:rgba(74,158,255,0.06);}}.pf-panel-section-head{display:flex;align-items:center;justify-content:space-between;gap:var(--pf-space-md);margin-bottom:var(--pf-space-xs);.pf-panel-label{margin-bottom:0;}}.pf-panel-label{display:block;font-size:var(--pf-font-xs);text-transform:uppercase;letter-spacing:0.04em;color:var(--pf-text-soft);margin-bottom:var(--pf-space-xs);}.pf-panel-hint{font-size:var(--pf-font-sm);color:var(--pf-text-dim);margin:var(--pf-space-sm)0;}.pf-panel-load-row{display:flex;align-items:center;gap:8px;.pf-panel-actions{flex:none;margin-bottom:0;}.pf-panel-hint{flex:1;min-width:0;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}}.pf-panel-actions{display:flex;align-items:stretch;gap:6px;margin-bottom:6px;.pf-btn{width:auto;flex:1 1 0;margin-bottom:0;display:inline-flex;align-items:center;justify-content:center;gap:6px;}.pf-btn svg{width:16px;height:16px;}}.pf-panel-actions .pf-btn.pf-btn-icon,.pf-panel-section-head .pf-btn.pf-btn-icon,.pf-history-actions .pf-btn.pf-btn-icon{flex:none;width:28px;height:28px;padding:0;margin-bottom:0;display:inline-flex;align-items:center;justify-content:center;}.pf-panel-actions .pf-btn.pf-btn-icon svg,.pf-panel-section-head .pf-btn.pf-btn-icon svg,.pf-history-actions .pf-btn.pf-btn-icon svg{width:16px;height:16px;}.pf-panel-grid{display:grid;grid-template-columns:minmax(0,1fr)minmax(0,1fr);gap:var(--pf-space-xs)var(--pf-space-md);margin-bottom:var(--pf-space-xs);}.pf-panel-cell{display:flex;flex-direction:column;gap:2px;min-width:0;}.pf-panel-cell-head{display:flex;align-items:baseline;justify-content:space-between;gap:6px;.pf-panel-label{margin-bottom:0;font-size:var(--pf-font-xs);text-transform:uppercase;letter-spacing:0.04em;color:var(--pf-text-soft);}.pf-panel-value{min-width:0;font-size:var(--pf-font-xs);}}.pf-panel-grid-compact{gap:4px 8px;.pf-panel-cell{flex-direction:row;align-items:center;gap:6px;.pf-panel-label{flex:none;width:48px;min-width:0;margin-bottom:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}.pf-panel-value{flex:none;min-width:30px;font-size:var(--pf-font-xs);}&:has(> input[type="color"]){justify-content:space-between;}}}.pf-panel-grid-compact .pf-panel-cell .pf-stepper{flex:1;width:auto;}input[type="color"]{width:28px;height:22px;padding:0;border:1px solid var(--pf-border-input);border-radius:var(--pf-radius-sm);background:transparent;cursor:pointer;}input[type="checkbox"]{appearance:none;flex:none;width:34px;height:20px;margin:0;padding:0;border:1px solid var(--pf-border-control);border-radius:var(--pf-radius-pill);background:var(--pf-surface-strong);position:relative;cursor:pointer;transition:background var(--pf-ease-duration)var(--pf-ease-curve),border-color var(--pf-ease-duration)var(--pf-ease-curve);&::before{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--pf-fg);transition:translate var(--pf-ease-bounce);}&:checked{background:var(--pf-accent);border-color:var(--pf-accent);&::before{translate:14px 0;}}&:focus-visible{outline:2px solid var(--pf-accent);outline-offset:2px;}}select.pf-select{flex:1;padding:4px 6px;border:1px solid var(--pf-border-input);border-radius:var(--pf-radius-sm);background:var(--pf-surface-soft);color:var(--pf-fg);font-size:var(--pf-font-md);&:disabled{opacity:0.4;cursor:not-allowed;}}.pf-panel-cell .pf-stepper,.pf-panel-cell select.pf-select{flex:none;width:100%;}.pf-panel-cell input[type="color"]{width:100%;height:22px;padding:0;border:1px solid var(--pf-border-input);border-radius:var(--pf-radius-sm);background:transparent;cursor:pointer;}}.pf-btn{display:block;width:100%;padding:6px 10px;margin-bottom:6px;border:none;border-radius:var(--pf-radius-md);background:var(--pf-accent);color:var(--pf-fg);font-size:var(--pf-font-md);font-weight:500;cursor:pointer;&:focus-visible{outline:2px solid var(--pf-accent);outline-offset:2px;}&:disabled,&:disabled:hover{opacity:0.35;cursor:not-allowed;background:var(--pf-accent);}}.pf-icon{display:inline-block;width:1em;height:1em;flex:0 0 auto;vertical-align:middle;}.pf-btn-ghost{background:var(--pf-surface-mid);color:inherit;&:hover{background:var(--pf-surface-strong);}&:disabled,&:disabled:hover{background:var(--pf-surface-mid);}}.pf-stepper{display:flex;align-items:stretch;width:100%;min-width:0;height:26px;border:1px solid var(--pf-border);border-radius:var(--pf-radius-md);background:var(--pf-surface-soft);overflow:hidden;transition:border-color 0.12s ease;&:focus-within{border-color:var(--pf-accent);}.pf-stepper-input{flex:1;min-width:0;width:100%;padding:0 8px;border:none;outline:none;background:transparent;color:var(--pf-fg);font-size:var(--pf-font-sm);font-variant-numeric:tabular-nums;}.pf-stepper-arrows{display:flex;flex-direction:column;flex:none;width:18px;border-left:1px solid var(--pf-border-soft);}.pf-stepper-btn{display:flex;align-items:center;justify-content:center;flex:1;padding:0;border:none;background:transparent;color:var(--pf-text-dim);cursor:pointer;touch-action:none;svg{width:11px;height:11px;fill:currentColor;}&:hover{color:var(--pf-fg);background:var(--pf-surface-mid);}&:first-child{border-bottom:1px solid var(--pf-border-soft);}}}.pf-panel-tabs .pf-panel-tab.pf-panel-tab-active{background:transparent;color:var(--pf-accent);font-weight:600;}.pf-stepper-disabled{opacity:0.45;pointer-events:none;}.pf-settings-toggle{display:flex;align-items:center;gap:6px;min-width:0;padding:6px 8px;border:1px solid var(--pf-border-soft);border-radius:var(--pf-radius-sm);background:var(--pf-surface-soft);cursor:pointer;user-select:none;font-size:var(--pf-font-sm);line-height:1.3;&:hover{background:var(--pf-surface-mid);}input{margin:0;flex:none;}span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}}.pf-options-cell{display:flex;flex-direction:row;align-items:center;justify-content:flex-start;gap:10px;grid-column:1 / -1;.pf-panel-label{min-width:0;margin-bottom:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}}.pf-options-row{display:flex;gap:6px;flex-shrink:0;}.pf-options-btn{padding:5px 10px;font-size:var(--pf-font-md);font-weight:600;text-align:center;background:var(--pf-surface-mid);color:inherit;border-radius:var(--pf-radius-sm);&:hover{background:var(--pf-surface-strong);}}.pf-options-active{background:var(--pf-accent)!important;color:#fff;}.pf-history-list{display:flex;flex-direction:column;gap:4px;max-height:168px;overflow-y:auto;overflow-x:clip;scrollbar-width:thin;scrollbar-color:var(--pf-text-mid)transparent;content-visibility:auto;contain-intrinsic-size:auto 168px;}.pf-history-card{display:flex;align-items:center;gap:6px;padding:6px 8px;border:1px solid var(--pf-border-soft);border-radius:var(--pf-radius-sm);background:var(--pf-surface-soft);&:hover{background:var(--pf-surface-mid);}}.pf-history-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;}.pf-history-title{font-size:var(--pf-font-sm);line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}.pf-history-meta{font-size:var(--pf-font-xs);opacity:0.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}.pf-history-actions{display:flex;gap:2px;flex-shrink:0;}@container pf-panel(max-width:330px){.pf-panel-header{padding:var(--pf-space-sm);gap:var(--pf-space-sm);}.pf-panel-body{padding:var(--pf-space-sm);}.pf-panel-grid{grid-template-columns:minmax(0,1fr);}.pf-history-card{padding:5px var(--pf-space-sm);gap:var(--pf-space-sm);}.pf-history-title{font-size:var(--pf-font-xs);}.pf-history-meta{font-size:10px;}.pf-history-list{max-height:152px;}}@media(pointer:coarse){.pf-options-btn{padding:7px 14px;font-size:var(--pf-font-lg);}.pf-options-row{gap:var(--pf-space-md);}.pf-panel-body{padding:10px 12px 12px;}.pf-panel-close{padding:6px 10px;font-size:18px;}.pf-panel-tab{padding:9px 10px;font-size:var(--pf-font-sm);}.pf-btn{padding:11px 12px;font-size:var(--pf-font-lg);}.pf-panel .pf-stepper{height:32px;}.pf-panel input[type="color"]{height:28px;}.pf-panel input[type="checkbox"]{width:40px;height:24px;}.pf-panel input[type="checkbox"]::before{width:18px;height:18px;}.pf-panel input[type="checkbox"]:checked::before{translate:18px 0;}.pf-settings-toggle{padding:9px 10px;font-size:var(--pf-font-md);}.pf-panel select.pf-select{padding:9px 8px;font-size:var(--pf-font-lg);}.pf-panel-actions .pf-btn.pf-btn-icon,.pf-panel-section-head .pf-btn.pf-btn-icon,.pf-history-actions .pf-btn.pf-btn-icon{width:36px;height:36px;}.pf-panel-actions .pf-btn.pf-btn-icon svg,.pf-panel-section-head .pf-btn.pf-btn-icon svg,.pf-history-actions .pf-btn.pf-btn-icon svg{width:18px;height:18px;}.pf-history-card{padding:8px 10px;gap:8px;}.pf-history-title{font-size:var(--pf-font-md);}.pf-history-meta{font-size:var(--pf-font-sm);}.pf-history-list{max-height:184px;}}@media(max-width:520px){.pf-panel{width:auto;max-height:calc(100% - 16px);top:var(--pf-space-md);right:var(--pf-space-md);left:var(--pf-space-md);bottom:auto;margin:0;}}@media(max-width:520px)and(pointer:coarse){.pf-panel{top:auto;bottom:var(--pf-space-md);left:var(--pf-space-md);right:var(--pf-space-md);max-height:62vh;margin:0;padding-bottom:env(safe-area-max-inset-bottom,0px);border-radius:16px 16px 0 0;border-left:none;border-right:none;border-bottom:none;}.pf-history-list{max-height:220px;}}@media(orientation:landscape)and(pointer:coarse)and(max-height:480px){.pf-panel{top:0;right:0;bottom:0;left:0;margin:auto;width:min(340px,45vw);max-height:70vh;border-radius:var(--pf-radius-lg);}.pf-tab-label{display:none;}.pf-panel-tab{padding:8px 10px;}.pf-history-card{padding:6px 8px;gap:6px;}.pf-history-title{font-size:var(--pf-font-xs);}.pf-history-meta{font-size:10px;}.pf-history-list{max-height:144px;}.pf-panel-actions .pf-btn.pf-btn-icon,.pf-panel-section-head .pf-btn.pf-btn-icon,.pf-history-actions .pf-btn.pf-btn-icon{width:32px;height:32px;}.pf-panel-actions .pf-btn.pf-btn-icon svg,.pf-panel-section-head .pf-btn.pf-btn-icon svg,.pf-history-actions .pf-btn.pf-btn-icon svg{width:16px;height:16px;}}@media(max-width:520px){.pf-options-cell{gap:6px;}.pf-options-row{flex-shrink:0;}}.pf-panel.pf-compact{width:min(300px,calc(100% - 16px));font-size:var(--pf-font-sm);.pf-panel-header{padding:var(--pf-space-sm);gap:var(--pf-space-sm);}.pf-panel-body{padding:var(--pf-space-xs)var(--pf-space-sm)var(--pf-space-md);}.pf-panel-grid{grid-template-columns:minmax(0,1fr);gap:var(--pf-space-xs);}.pf-panel-tab{padding:5px 6px;font-size:var(--pf-font-xs);}.pf-panel-tab svg{width:12px;height:12px;}.pf-panel-close{padding:4px 6px;font-size:14px;}.pf-btn{padding:8px 10px;font-size:var(--pf-font-sm);}.pf-settings-toggle{padding:6px 8px;font-size:var(--pf-font-sm);}.pf-history-card{padding:5px 8px;gap:6px;}.pf-history-title{font-size:var(--pf-font-xs);}.pf-history-meta{font-size:10px;}.pf-history-list{max-height:152px;}.pf-stepper{height:28px;}}.pf-panel.pf-compact{@media(pointer:coarse){.pf-panel-tab{padding:7px 8px;}.pf-btn{padding:9px 10px;}.pf-settings-toggle{padding:7px 8px;}.pf-stepper{height:30px;}}}.pf-panel.pf-compact{@media(max-width:520px)and(pointer:coarse){width:auto;top:auto;bottom:var(--pf-space-sm);left:var(--pf-space-sm);right:var(--pf-space-sm);max-height:56vh;border-radius:14px 14px 0 0;border-left:none;border-right:none;border-bottom:none;padding-bottom:env(safe-area-max-inset-bottom,0px);}}@starting-style{.pf-panel.pf-open{opacity:0;translate:0 12px;scale:0.98;}}}::view-transition-old(pf-panel){animation:pf-panel-fade-out var(--pf-ease-out);}::view-transition-new(pf-panel){animation:pf-panel-fade-in var(--pf-ease-bounce);}@keyframes pf-panel-fade-out{from{opacity:1;transform:scale(1);}to{opacity:0;transform:scale(0.96);}}@keyframes pf-panel-fade-in{from{opacity:0;transform:scale(0.96);}to{opacity:1;transform:scale(1);}}}`;

  // src/shell/chrome/inject.js
  var sharedSheet = null;
  var adopted = false;
  var styleLoad = null;
  function adopt() {
    if (adopted) {
      return;
    }
    adopted = true;
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sharedSheet];
  }
  function warmStyles() {
    if (sharedSheet) {
      return sharedSheet;
    }
    sharedSheet = new CSSStyleSheet();
    sharedSheet.replaceSync(styles_default);
    adopt();
    styleLoad = (async () => {
      let css = null;
      try {
        css = await gmGetResourceText("pfStyle");
      } catch (err) {
        logger.error("inject", "Failed to load @resource stylesheet:", err);
      }
      if (css && css.trim().length > 0) {
        try {
          sharedSheet.replaceSync(css);
        } catch (err) {
          logger.error("inject", "Rejected malformed @resource stylesheet:", err);
        }
      }
      return sharedSheet;
    })();
    return sharedSheet;
  }
  function mapCpuTier(tier) {
    return tier === 1 ? "low" : tier === 3 || tier === 4 ? "high" : "medium";
  }
  function detectCpuTier() {
    try {
      return mapCpuTier(navigator.cpuPerformance);
    } catch {
      return "medium";
    }
  }
  function injectShell(container) {
    if (!container) {
      logger.error("inject", "injectShell: no container");
      return null;
    }
    const host = el("div", { class: "pf-shell", tabindex: "-1" }, container);
    const tier = detectCpuTier();
    if (tier !== "medium") {
      host.setAttribute("data-pf-cpu-tier", tier);
    }
    const shadow = host.attachShadow({ mode: "open" });
    if (sharedSheet) {
      shadow.adoptedStyleSheets = [sharedSheet];
    }
    const hudLayer = el("div", { class: "pf-hud-layer" }, shadow);
    const cueLayer = el("div", { class: "pf-cue-layer", "aria-hidden": "true" }, hudLayer);
    logger.log("inject", `Shell DOM built inside ${container.tagName}#${container.id || container.className}`);
    return {
      host,
      shadow,
      hudLayer,
      cueLayer
    };
  }
  function watchShellHost(container, host) {
    let scheduled = false;
    let detachWatch = null;
    const reconcile = () => {
      scheduled = false;
      if (!container.isConnected) {
        armReconnectWatch();
        return;
      }
      dropReconnectWatch();
      if (host.parentElement !== container) {
        container.appendChild(host);
        logger.log("inject", "Shell host re-attached by watchdog");
      }
    };
    const schedule = () => {
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(reconcile);
      }
    };
    const armReconnectWatch = () => {
      if (!detachWatch) {
        detachWatch = onDomMutations(schedule);
      }
    };
    const dropReconnectWatch = () => {
      detachWatch?.();
      detachWatch = null;
    };
    const observer3 = new MutationObserver((records) => {
      for (const { removedNodes } of records) {
        for (const node of removedNodes) {
          if (node === host) {
            schedule();
            return;
          }
        }
      }
    });
    observer3.observe(container, { childList: true });
    return () => {
      observer3.disconnect();
      dropReconnectWatch();
    };
  }

  // src/shell/chrome/viewport.js
  function ensureViewportFitCover(doc = document) {
    const head = doc.head || doc.getElementsByTagName("head")[0] || doc.documentElement;
    const meta = head.querySelector?.('meta[name="viewport"]');
    if (meta) {
      const content = meta.getAttribute("content") || "";
      if (/viewport-fit\s*=/i.test(content)) {
        const merged = content.replace(/viewport-fit\s*=\s*[^;,\s]+/i, "viewport-fit=cover");
        if (merged !== content) {
          meta.setAttribute("content", merged);
        }
      } else {
        meta.setAttribute("content", `${content.replace(/\s*,\s*$/, "")},viewport-fit=cover`);
      }
      return !!head;
    }
    const created = doc.createElement("meta");
    created.setAttribute("name", "viewport");
    created.setAttribute("content", "width=device-width, initial-scale=1, viewport-fit=cover");
    (head || doc.documentElement).appendChild(created);
    return !!head;
  }

  // src/shell/shell.js
  var Shell = class {
    id;
    video;
    container;
    sdk;
    #shellDom = null;
    #inputs = null;
    #resume = null;
    #subtitles = null;
    #filter = null;
    #panel;
    #toasts = null;
    /** Active wake-lock session's abort controller; the browser owns release. */
    #wakeLockAbort = null;
    #onDestroy;
    #destroyed = false;
    /** DOM lifecycle manager: listeners, observers, elements, rollbacks. */
    #dom = new DOMManager();
    /** Sub-component scope: signal passed to InputForge, MediaSession, etc. */
    #scope = new AbortController();
    /** Command plane: all playback control routes through these primitives. */
    #media;
    /** OS media-key facet, null without MediaSession support. */
    #mediaSession = null;
    constructor({ video, container, sdk, onDestroy }) {
      this.video = video;
      this.container = container;
      this.sdk = sdk;
      this.#onDestroy = onDestroy;
      this.#media = createMediaControls({ video });
      this.ready = this.#boot();
    }
    /** Resolves when the shell DOM and HUD are live. Styles load is awaited. */
    async #boot() {
      await this.#injectDom();
      if (!this.#shellDom) {
        throw new Error(`Shell "${this.sdk.name}": failed to inject shell DOM`);
      }
      await scheduler.yield();
      this.#panel = new SettingsPanel(this);
      this.#toasts = new ToastManager(this.#shellDom.hudLayer);
      this.#inputs = new InputForge(this.video, this.container, this.shellHost);
      attachInputActions(this, this.shellHost, this.#inputs.signal);
      this.#resume = new ResumeTracker(this);
      this.#panel.setSectionBuilder(async () => {
        this.#subtitles = new SubtitlesSection(this);
        await scheduler?.yield?.();
        this.#filter = new VideoFilter(this, this.#panel);
        await scheduler?.yield?.();
        addHistorySection(this.#panel, this);
        await scheduler?.yield?.();
        addSettingsSection(this.#panel);
      });
      this.#setupFocusManagement();
      this.#suppressContextMenu();
      this.#forwardMediaEvents();
      this.#mediaSession = claimMediaSession({
        controls: this.#media,
        video: this.video,
        signal: this.#scope.signal
      });
      this.#watchFullscreen();
      this.#watchWakeLock();
      this.#watchOrientation();
      this.#markManaged();
      logger.log("shell", `Shell "${this.sdk.name}" constructed`);
    }
    /** Read-only state views; all writes route through `shell.media`. */
    get volume() {
      return this.video.volume;
    }
    get currentTime() {
      return this.video.currentTime;
    }
    get duration() {
      return Number(this.video.duration) || NaN;
    }
    get playbackRate() {
      return this.video.playbackRate;
    }
    get muted() {
      return this.video.muted;
    }
    get paused() {
      return this.video.paused;
    }
    /**
     * Sole fullscreen condition, read straight off the shared `fs` gate
     * (shadow.js) - built on the native fullscreen event by initFullscreenGate().
     * The shell lives inside the SDK's frame, so an SDK fullscreen IS a document
     * fullscreen; `fs` is the single boolean that gates fs features codebase-wide.
     */
    get fullscreen() {
      return fs;
    }
    /**
     * Unified contextual reference box, per the PlayerForge geometry rule: in
     * inline mode the reference is the shell's own container (the SDK container).
     * Fullscreen reference box used for fill-mode cover scaling and scrub
     * normalization. With the edge-to-edge bypass (see viewport.js) the
     * fullscreen iframe draws behind the cutout edge-to-edge, so the SDK's
     * rendered box IS the physical screen - `screen.width/height`. No env-based
     * safe-rect narrowing is needed (or possible: env(safe-area-inset-*) does
     * not resolve inside iframes, Chromium #467970444) - the bypass already puts
     * the frame at the screen. Returns { width, height }.
     */
    get referenceBox() {
      if (fs) {
        return { width: screen.width, height: screen.height };
      }
      return { width: this.container.clientWidth, height: this.container.clientHeight };
    }
    get shellDom() {
      return this.#shellDom;
    }
    get shellHost() {
      return this.#shellDom?.host;
    }
    get panel() {
      return this.#panel;
    }
    get resume() {
      return this.#resume;
    }
    /** The DOMManager — for sub-components that need lifecycle-tracked artifacts. */
    get dom() {
      return this.#dom;
    }
    #suppressContextMenu() {
      this.#dom.listen(this.container, "contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
      }, { capture: true });
    }
    /** Keep focus on the shell host when pointer interactions happen inside it. */
    #setupFocusManagement() {
      const host = this.shellHost;
      if (!host) {
        return;
      }
      host.focus();
      this.#dom.listen(this.container, "pointerdown", (event) => {
        if (this.#destroyed) {
          return;
        }
        if (document.activeElement === host) {
          return;
        }
        if (!isInsideShell(host, event.composedPath()[0])) {
          queueMicrotask(() => this.#restoreFocusIfNeeded(host));
        }
      }, { capture: true, passive: true });
    }
    /** Re-focus the host after a pointerdown unless focus already moved inside. */
    #restoreFocusIfNeeded(host) {
      if (!this.#destroyed && deepestActiveElement(host) !== host) {
        host.focus();
      }
    }
    toast(payload) {
      this.#toasts?.show(payload);
    }
    /** Completion feedback (800ms). */
    toastFlash(icon, text, group2) {
      this.#toasts?.show({ icon, text, duration: TUNING.toast.flashMs, group: group2 });
    }
    /** Status message (2500ms). */
    toastInfo(icon, text, group2) {
      this.#toasts?.show({ icon, text, duration: TUNING.toast.infoMs, group: group2 });
    }
    /** Onboarding hint (5000ms). */
    toastHint(icon, text, group2) {
      this.#toasts?.show({ icon, text, duration: TUNING.toast.hintMs, group: group2 });
    }
    /** Action toast with buttons (4000ms). */
    toastAction(icon, text, group2, actions) {
      this.#toasts?.show({ icon, text, duration: TUNING.toast.actionMs, group: group2, actions });
    }
    hideToast(group2) {
      this.#toasts?.hide(group2);
    }
    /** The command plane, for interaction layers that issue media commands. */
    get media() {
      return this.#media;
    }
    async #injectDom() {
      warmStyles();
      if (getSetting("fullscreen.edgeToEdge") !== false) {
        ensureViewportFitCover();
      }
      this.#shellDom = injectShell(this.container);
      if (!this.#shellDom) {
        logger.error("shell", "Failed to inject shell DOM");
        return;
      }
      this.#dom.onCleanup(() => this.#shellDom?.host.remove());
      this.#dom.markAttribute(this.#shellDom.host, SHELL_MARKER, "");
      const style = getComputedStyle(this.container);
      if (style.position === "static") {
        this.#dom.markStyle(this.container, "position", "relative");
      }
      const dropWatch = watchShellHost(this.container, this.#shellDom.host);
      this.#dom.onCleanup(dropWatch);
    }
    #forwardMediaEvents() {
      const video = this.video;
      const host = this.#shellDom?.host;
      const handler = () => {
        this.#mediaSession?.sync();
      };
      for (const name of MEDIA_SESSION_SYNC_EVENTS) {
        this.#dom.listen(video, name, handler, { passive: true });
      }
      if (host) {
        const sync = () => {
          host.style.setProperty("--pf-media-paused", video.paused ? "1" : "0");
          host.style.setProperty("--pf-media-muted", video.muted ? "1" : "0");
        };
        sync();
        for (const evt of ["play", "pause", "volumechange"]) {
          this.#dom.listen(video, evt, sync, { passive: true });
        }
      }
    }
    /** Surface a hint + re-provision when a fullscreen entry is rejected. */
    #watchFullscreen() {
      this.#dom.listen(document, "fullscreenerror", () => {
        if (this.#destroyed || fs) {
          return;
        }
        this.toastInfo("fs-block", "Fullscreen blocked by embed", "fs-block");
        if (window.top !== window) {
          requestFullscreenProvision();
        }
      });
    }
    /** Keep screen awake while video is playing; release on pause/ended/hidden. */
    #watchWakeLock() {
      const video = this.video;
      const release = () => {
        this.#wakeLockAbort?.abort();
        this.#wakeLockAbort = null;
      };
      const acquire = () => {
        if (this.#destroyed || video.paused || video.ended) {
          return;
        }
        this.#wakeLockAbort?.abort();
        const ac = new AbortController();
        this.#wakeLockAbort = ac;
        navigator.wakeLock.request("screen", { signal: ac.signal }).catch(() => {
          if (this.#wakeLockAbort === ac) {
            this.#wakeLockAbort = null;
          }
        });
      };
      this.#dom.listen(video, "play", acquire, { passive: true });
      this.#dom.listen(video, "pause", release, { passive: true });
      this.#dom.listen(video, "ended", release, { passive: true });
      this.#dom.listen(document, "visibilitychange", () => {
        if (document.visibilityState === "visible" && !video.paused && !video.ended) {
          acquire();
        }
      });
    }
    /** Lock to landscape on fullscreen entry (Android); unlock on exit. */
    #watchOrientation() {
      const unsub = subscribeFullscreen(async (active) => {
        if (this.#destroyed) {
          return;
        }
        try {
          if (active && screen.orientation?.lock) {
            await screen.orientation.lock("landscape");
          } else if (!active && screen.orientation?.unlock) {
            screen.orientation.unlock();
          }
        } catch {
        }
      }, this.#scope.signal);
      this.#dom.onCleanup(unsub);
    }
    exitFullscreen() {
      if (fs) {
        document.exitFullscreen()?.catch(() => {
        });
      }
    }
    #markManaged() {
      this.#dom.markAttribute(this.video, SHELL_MARKER, "");
      this.#dom.markAttribute(this.container, SHELL_MARKER, "");
    }
    destroy() {
      if (!this.#destroyed) {
        this.#destroyed = true;
        logger.log("shell", `Destroying shell "${this.sdk.name}"`);
        this.#resume?.destroy();
        this.#resume = null;
        this.#subtitles?.destroy();
        this.#subtitles = null;
        this.#filter?.destroy();
        this.#filter = null;
        this.#wakeLockAbort?.abort();
        this.#wakeLockAbort = null;
        this.#inputs?.destroy();
        this.#inputs = null;
        this.#panel?.destroy();
        this.#panel = null;
        this.#toasts?.destroy();
        this.#toasts = null;
        this.#scope.abort();
        this.#dom.destroy();
        this.#shellDom = null;
        this.#onDestroy?.(this);
      }
    }
  };

  // src/shell/register.js
  function registerShell(kernel) {
    kernel.registerShellProvider({
      create({ video, container, sdk, onDestroy }) {
        return new Shell({ video, container, sdk, onDestroy });
      }
    });
  }

  // src/kernel/menus.js
  function installMenuCommands() {
    let debugId = null;
    const refreshDebug = () => {
      if (debugId != null) {
        gmUnregisterMenu(debugId);
      }
      const enabled3 = getConfigValue(DEBUG_LOGS_KEY, false);
      debugId = gmRegisterMenu(
        `🐛 Debug Logs:${enabled3 ? "On" : "Off"}`,
        () => {
          const next = !getConfigValue(DEBUG_LOGS_KEY, false);
          setConfigValue(DEBUG_LOGS_KEY, next);
          if (next) {
            logger.enable();
          } else {
            logger.disable();
          }
          refreshDebug();
        },
        { autoClose: true }
      );
    };
    refreshDebug();
    return () => {
      if (debugId != null) {
        gmUnregisterMenu(debugId);
        debugId = null;
      }
    };
  }

  // src/kernel/probe.js
  function installVideoProbe({ minWidth, minHeight, onCandidate }) {
    let done = false;
    let escalated = false;
    let offMutations = null;
    let stopEvents = null;
    const detach = () => {
      stopEvents?.();
      stopEvents = null;
      offMutations?.();
      offMutations = null;
    };
    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      detach();
      logger.log("probe", "Video candidate found - booting kernel");
      onCandidate();
    };
    const escalate = () => {
      if (escalated) {
        return;
      }
      escalated = true;
      offMutations = onDomMutations((mutations) => {
        if (done) {
          return;
        }
        for (const video of videosFromMutations(mutations)) {
          consider(video);
        }
      });
    };
    const consider = (video) => {
      if (done) {
        return;
      }
      if (meetsMinSize(video, minWidth, minHeight)) {
        finish();
        return;
      }
      escalate();
    };
    stopEvents = watchMediaEvents(consider);
    const checkStatic = () => {
      if (done) {
        return;
      }
      const present = document.querySelectorAll("video");
      for (const video of present) {
        consider(video);
      }
      if (!done && present.length) {
        escalate();
      }
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", checkStatic, { once: true });
    } else {
      checkStatic();
    }
    return () => {
      if (!done) {
        done = true;
        detach();
      }
    };
  }

  // src/kernel/guard.js
  var AD_URL_PATTERN = new RegExp([
    "doubleclick\\.net",
    "googlesyndication\\.com",
    "googleadservices\\.com",
    "adnxs\\.com",
    "adservice\\.google",
    "taboola\\.com",
    "outbrain\\.com",
    "recaptcha",
    "hcaptcha\\.com",
    "googletagmanager\\.com",
    "facebook\\.net/tr"
  ].join("|"), "i");
  function shouldSkipUrl() {
    try {
      const href = location.href;
      if (href === "about:blank" || href.startsWith("data:")) {
        return true;
      }
      if (AD_URL_PATTERN.test(href)) {
        return true;
      }
      if (window.top !== window && window.top?.location?.href) {
        if (AD_URL_PATTERN.test(window.top.location.href)) {
          return true;
        }
      }
    } catch {
    }
    return false;
  }

  // src/entry.js
  function bootstrap() {
    "use strict";
    if (shouldSkipUrl()) {
      return;
    }
    initFullscreenGate();
    if (window.top === window) {
      installMenuCommands();
    }
    const boot = () => {
      if (window.PlayerForge) {
        logger.warn("entry", "Kernel already initialized");
        return;
      }
      const kernel = new Kernel();
      registerShell(kernel);
      kernel.init();
      const legacyFirstRun = getConfigValue("firstRun", void 0);
      let welcomePending = getConfigValue(KEYS.firstRun, legacyFirstRun !== false);
      if (legacyFirstRun !== void 0) {
        deleteConfigField("firstRun");
      }
      kernel.onShellCreated((shell) => {
        logger.log("entry", `Shell ready: ${shell.sdk.name}`);
        if (window.top !== window) {
          requestFullscreenProvision();
        }
        if (!welcomePending) {
          return;
        }
        welcomePending = false;
        setConfigValue(KEYS.firstRun, false);
        const coarsePointer = matchMedia("(pointer: coarse)").matches;
        const cancelHint = () => {
          clearTimeout(hintTimer);
          document.removeEventListener("pointerdown", cancelHint, true);
          document.removeEventListener("keydown", cancelHint, true);
          document.removeEventListener("wheel", cancelHint, true);
        };
        const hintTimer = setTimeout(() => {
          cancelHint();
          if (shell && shell.container?.isConnected && !shell.panel?.isOpen) {
            shell.toastHint(
              "captions",
              coarsePointer ? "Swipe down to exit fullscreen" : "Press S for settings · Swipe down to exit fullscreen"
            );
          }
        }, 1200);
        document.addEventListener("pointerdown", cancelHint, { capture: true, once: true });
        document.addEventListener("keydown", cancelHint, { capture: true, once: true });
        document.addEventListener("wheel", cancelHint, { capture: true, passive: true, once: true });
      });
      const debugMode = location.hash.includes("pf-debug");
      Object.defineProperty(window, "PlayerForge", {
        value: Object.freeze(debugMode ? { kernel, version: GM_info.script.version } : { version: GM_info.script.version }),
        writable: false,
        configurable: false
      });
      logger.log(
        "entry",
        `Kernel booted (${window.top === window ? "top" : "frame"}) - ${GM_info.scriptHandler} ${GM_info.version}, script ${GM_info.script.version}`
      );
    };
    try {
      installContextBridge();
    } catch (error2) {
      logger.error("entry", "Frame bridge install failed", error2);
    }
    installVideoProbe({
      minWidth: MIN_VIDEO_WIDTH,
      minHeight: MIN_VIDEO_HEIGHT,
      onCandidate: boot
    });
  }
  bootstrap();
})();

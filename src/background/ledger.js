import { NET_HINT } from "../kernel/contract.js";

/**
 * The uBO-grade network floor: background webRequest observation with the
 * frame topology Firefox attaches to every request (frameId, tabId) and NO
 * DOM access anywhere - the background never touches a document.
 *
 * What it watches: response headers of media/xhr requests in every frame,
 * and it answers a video/audio content-type with one hint message to the
 * frame the request rode - "media-shaped traffic flowed through here". The
 * vocabulary and the decision boundary live in contract.js: the hint NEVER
 * decides an adoption. The content kernel replays the boot its discovery
 * probe would have run; this plane only accelerates detection on slow
 * network paths (the request can land long before the <video> element
 * fires its first media event) and costs nothing when it is wrong.
 *
 * No clock, no timers: the zero-timer pipeline holds here too. The ledger
 * is event-invalidated - a main_frame request clears the tab's entries (a
 * new document maps the whole topology), a sub_frame request clears that
 * frame's own entry (an iframe navigation re-arms its hint), and
 * tabs.onRemoved drops the tab outright. Between navigations a repeated
 * hint for the same (tab, frame) is suppressed by the seen-set, so a long
 * stream's media requests never re-wake the kernel for nothing.
 */
export class NetHintLedger {
  /** tabId -> Set(frameId): the (tab, frame) pairs this session's media
   *  traffic already hinted. Smallest state that can do the job. */
  #hinted = new Map();

  install() {
    // Invalidation rides the two request types that MEAN navigation, so
    // hint freshness is event-driven all the way down.
    browser.webRequest.onBeforeRequest.addListener((details) => {
      if (details.tabId === -1) {
        // Non-tab traffic (this page's own requests, devtools) owns no
        // content script to hint.
        return;
      }
      if (details.type === "main_frame") {
        this.#hinted.delete(details.tabId);
      } else if (details.type === "sub_frame") {
        this.#hinted.get(details.tabId)?.delete(details.frameId);
      }
    }, { urls: ["<all_urls>"] });

    // media / xhr: the <video> element's own src loads + the MSE/xhr
    // streaming routes both land in this set; a document/html content-type
    // (the page itself, sub_frame documents) is not media traffic.
    browser.webRequest.onHeadersReceived.addListener(
      (details) => this.#onHeaders(details),
      { urls: ["<all_urls>"], types: ["media", "xhr"] },
      ["responseHeaders"]
    );

    browser.tabs.onRemoved.addListener((tabId) => {
      this.#hinted.delete(tabId);
    });
  }

  #onHeaders(details) {
    if (details.tabId === -1) {
      return;
    }
    const contentType = (details.responseHeaders ?? []).find(
      (header) => header.name.toLowerCase() === "content-type"
    )?.value;
    // The header prefix is the whole media judgment: video/* and audio/*
    // payloads are media-shaped traffic by the server's own claim. No
    // inference beyond that - a wishlist of mime patterns is where the
    // false-hint rate would go unbounded.
    if (!contentType || !/^(video|audio)\//.test(contentType)) {
      return;
    }
    let frames = this.#hinted.get(details.tabId);
    if (!frames) {
      frames = new Set();
      this.#hinted.set(details.tabId, frames);
    }
    if (frames.has(details.frameId)) {
      return;
    }
    frames.add(details.frameId);
    // Frame-targeted: the request's frameId is where the element (or the
    // MSE consumer) lives, so that frame's kernel instance is the one that
    // gains from an earlier seed walk. A missing proxy (the frame never
    // armed its scripts - about:blank descendants, an unload race) rejects
    // harmlessly here and never matters to detection: the seed walk + media
    // tap were already the whole story.
    browser.tabs.sendMessage(
      details.tabId,
      { type: NET_HINT, url: details.url },
      { frameId: details.frameId }
    ).catch(() => {});
  }
}

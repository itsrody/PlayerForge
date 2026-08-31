/**
 * Edge-to-edge fullscreen bypass for the SDK's iframe document.
 *
 * Chromium's Android DisplayCutoutController sets the window's
 * `layoutInDisplayCutoutMode` from the viewport-fit value of the ACTIVE
 * (fullscreen) frame - and when PlayerForge fullscreens a div, the active
 * frame is THIS iframe's document, not the top page. So the top page's
 * `viewport-fit=cover` meta alone is NOT enough: the iframe's own document
 * must also report `viewport-fit=cover`, otherwise Chrome applies the default
 * cutout mode and letterboxes the fullscreen iframe around the notch - the
 * exact "bars" PlayerForge is asked to remove.
 *
 * This injects / merges `viewport-fit=cover` into the SDK document's existing
 * viewport meta (or adds one) in the <head>, so the fullscreen frame reports
 * cover and Chrome draws it behind the display cutout. Idempotent; never
 * clobbers the other viewport keys (e.g. user-scalable, maximum-scale).
 */

/** Ensure the document's viewport meta includes viewport-fit=cover. */
export function ensureViewportFitCover(doc = document) {
  const head = doc.head || doc.getElementsByTagName("head")[0] || doc.documentElement;
  const meta = head.querySelector?.('meta[name="viewport"]');
  if (meta) {
    const content = meta.getAttribute("content") || "";
    if (/viewport-fit\s*=/i.test(content)) {
      // Override whatever fit the SDK/embed set: only "cover" opts IN to edge-
      // to-edge drawing under the cutout, so forcing it is precisely the point
      // (the user can disable the whole feature, not the fit keyword).
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

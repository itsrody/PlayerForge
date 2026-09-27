/**
 * Any match skips the document entirely (ad/track/captcha frames host no
 * players). Hostname-anchored on purpose: an ad domain may appear only in a
 * path or query on a legitimate video page (`/doubleclick-interview/`,
 * `?ref=taboola.com`), and substring-matching the whole href would silently
 * skip a real player. Suffix match covers subdomains; captcha widget frames
 * live on their own domains (hcaptcha.com, recaptcha.net), so dropping the
 * path-style `recaptcha` probe costs only a harmless script eval in the
 * occasional captcha iframe that hosts no video.
 */
const AD_HOST_SUFFIXES = [
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "adnxs.com",
  "taboola.com",
  "outbrain.com",
  "hcaptcha.com",
  "googletagmanager.com",
  "recaptcha.net",
  "facebook.net"
];
/** Prefix families: adservice.google and its subdomains. */
const AD_HOST_PREFIXES = ["adservice.google."];

function isAdHost(hostname) {
  for (const suffix of AD_HOST_SUFFIXES) {
    if (hostname === suffix || hostname.endsWith(`.${suffix}`)) {
      return true;
    }
  }
  for (const prefix of AD_HOST_PREFIXES) {
    if (hostname.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

export function shouldSkipUrl() {
  try {
    const href = location.href;
    if (href === "about:blank" || href.startsWith("data:")) {
      return true;
    }
    if (isAdHost(new URL(href).hostname)) {
      return true;
    }
    if (window.top !== window && window.top?.location?.href) {
      if (isAdHost(new URL(window.top.location.href).hostname)) {
        return true;
      }
    }
  } catch {}
  return false;
}

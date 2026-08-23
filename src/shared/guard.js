/** Any match skips the document entirely (ad/track/captcha frames host no players). */
const AD_URL_PATTERN = new RegExp([
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

export function shouldSkipUrl() {
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
  } catch {}
  return false;
}

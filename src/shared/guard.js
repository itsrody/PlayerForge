const AD_URL_PATTERNS = [
  /doubleclick\.net/i,
  /googlesyndication\.com/i,
  /googleadservices\.com/i,
  /adnxs\.com/i,
  /adservice\.google/i,
  /pagead2\.googlesyndication/i,
  /taboola\.com/i,
  /outbrain\.com/i,
  /recaptcha/i,
  /google\.com\/recaptcha/i,
  /hcaptcha\.com/i,
  /googletagmanager\.com/i,
  /facebook\.net\/tr/i
];

export function shouldSkipUrl() {
  try {
    const href = location.href;
    if (href === "about:blank" || href.startsWith("data:")) {
      return true;
    }
    for (const pattern of AD_URL_PATTERNS) {
      if (pattern.test(href)) {
        return true;
      }
    }
    if (window.top !== window && window.top?.location?.href) {
      for (const pattern of AD_URL_PATTERNS) {
        if (pattern.test(window.top.location.href)) {
          return true;
        }
      }
    }
  } catch {}
  return false;
}

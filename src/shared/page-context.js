export const NONCE_TTL_MS = 5000;
export const CTX_REQUEST_TIMEOUT_MS = 3000;

/**
 * Reduce a hostname to its registrable-domain key (best effort, no PSL).
 * IP addresses become dash-separated so they are safe as identifiers.
 */
export function getDomainKey(hostname) {
  if (!hostname) {
    return "";
  }
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname)) {
    return hostname.replace(/\./g, "-");
  }
  const parts = hostname.toLowerCase().replace(/^www\./, "").split(".");
  const multiPartTlds = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "mil"]);
  let idx = parts.length - 1;
  if (parts[idx] && parts[idx].length <= 3) {
    idx--;
  }
  if (parts[idx] && multiPartTlds.has(parts[idx])) {
    idx--;
  }
  return parts[Math.max(0, idx)] || "";
}

function boundedLevenshtein(a, b, max = Infinity) {
  const lenA = a.length;
  const lenB = b.length;
  if (Math.abs(lenA - lenB) > max) {
    return max + 1;
  }
  let prev = new Array(lenB + 1);
  for (let j = 0; j <= lenB; j++) {
    prev[j] = j;
  }
  let curr = new Array(lenB + 1);
  for (let i = 1; i <= lenA; i++) {
    curr[0] = i;
    let rowMin = i;
    const chA = a[i - 1];
    for (let j = 1; j <= lenB; j++) {
      const cost = chA === b[j - 1] ? 0 : 1;
      curr[j] = cost === 0 ? prev[j - 1] : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
      if (curr[j] < rowMin) {
        rowMin = curr[j];
      }
    }
    if (rowMin > max) {
      return max + 1;
    }
    [prev, curr] = [curr, prev];
  }
  return prev[lenB];
}

export function domainsMatch(a, b) {
  if (a === b) {
    return true;
  } else if (!a || !b) {
    return false;
  } else if (a.includes(b) || b.includes(a)) {
    return true;
  } else {
    return boundedLevenshtein(a, b, 2) <= 2;
  }
}

export function domainScore(a, b) {
  if (a === b) {
    return 3;
  } else if (!a || !b) {
    return 0;
  } else if (a.includes(b) || b.includes(a)) {
    return 2;
  } else {
    return Math.max(0, 3 - boundedLevenshtein(a, b, 3));
  }
}

/** Deterministic djb2-based id for a (path, duration) pair. */
export function hashEntry(path, duration) {
  const seed = `${path}::${Math.round(duration)}`;
  let hash = 5381;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) + hash + seed.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36).substring(0, 8);
}

/**
 * Set up the top-frame ↔ iframe message bridge used to resolve the page
 * context of embedded players. The top frame owns the answer; nested
 * iframes relay requests upwards and responses back down.
 */
export function setupContextBridge() {
  const domainKey = getDomainKey(location.hostname);

  if (window === window.top) {
    window.addEventListener("message", (event) => {
      const data = event.data;
      if (data && data.type === "pf:ctx-request") {
        event.source?.postMessage({
          type: "pf:ctx",
          nonce: data.nonce,
          domain: domainKey,
          path: location.pathname,
          title: document.title
        }, "*");
      }
    });
    return;
  }

  const pending = new Map();
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (data && typeof data === "object") {
      if (data.type === "pf:ctx-request") {
        pending.set(data.nonce, event.source);
        setTimeout(() => pending.delete(data.nonce), NONCE_TTL_MS);
        window.parent.postMessage(data, "*");
      } else if (data.type === "pf:ctx" && pending.has(data.nonce)) {
        const requester = pending.get(data.nonce);
        pending.delete(data.nonce);
        requester?.postMessage(data, "*");
      }
    }
  });
}

/** Resolve the current page context ({domain, path, title}) from the top frame. */
export async function getPageContext() {
  try {
    if (window.top === window) {
      const domainKey = getDomainKey(location.hostname);
      return {
        domain: domainKey,
        path: location.pathname,
        title: document.title
      };
    }
    const topLocation = window.top.location;
    if (topLocation) {
      const domainKey = getDomainKey(topLocation.hostname);
      return {
        domain: domainKey,
        path: topLocation.pathname,
        title: window.top.document.title
      };
    }
  } catch {
    return requestPageContextFromParent();
  }
  return null;
}

/** Ask the parent chain for page context via postMessage (cross-origin iframes). */
export function requestPageContextFromParent(timeoutMs = CTX_REQUEST_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    let nonce = null;
    let retryTimer = null;

    const onMessage = (event) => {
      const data = event.data;
      if (data && data.type === "pf:ctx" && data.nonce === nonce) {
        clearTimeout(retryTimer);
        window.removeEventListener("message", onMessage);
        resolve({
          domain: data.domain,
          path: data.path,
          title: data.title
        });
      }
    };

    window.addEventListener("message", onMessage);

    const sendRequest = () => {
      nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      window.parent.postMessage({ type: "pf:ctx-request", nonce }, "*");
    };
    const attempt = () => {
      if (Date.now() >= deadline) {
        window.removeEventListener("message", onMessage);
        resolve(null);
        return;
      }
      sendRequest();
      retryTimer = setTimeout(attempt, 1200);
    };
    attempt();
  });
}

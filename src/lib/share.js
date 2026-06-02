// ─────────────────────────────────────────────────────────────────────────────
// Shareable result cards — self-contained, no backend.
//
// The card payload is encoded INTO the URL (base64url of compact JSON), so a
// shared link needs no database, no public store, and no API. There is nothing
// to leak because there is nothing stored: the link carries only the handful of
// non-sensitive fields below, and nothing else from the user's memory or account
// ever travels. Opening the link renders a read-only card client-side.
//
// What travels (deliberately minimal):
//   d  = decision summary (one line)
//   b  = brittleness score (0–100)
//   v  = verdict text
//   f  = up to 3 failure headlines [{r: role, m: failure_mode}]
//   t  = created timestamp (ms)
// What NEVER travels: full analysis internals, the user's other decisions,
// memory/principles/calibration, account identity, post-mortems, notes.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_FIELD = 600; // hard cap per text field, keeps URLs sane and bounded

function clampStr(s, n = MAX_FIELD) {
  return (typeof s === "string" ? s : "").slice(0, n);
}

// base64url <-> string, Unicode-safe.
function toB64Url(str) {
  // encodeURIComponent → escape bytes → btoa, then URL-safe swaps.
  const b64 = btoa(unescape(encodeURIComponent(str)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64Url(b64url) {
  let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return decodeURIComponent(escape(atob(b64)));
}

// Build the compact, sanitized payload from a result/entry object.
export function buildSharePayload(result) {
  const anatomy = result?.anatomy || {};
  const failures = Array.isArray(result?.failures) ? result.failures : [];
  return {
    d: clampStr(anatomy.decision || result?.decision || result?.summary || "A decision"),
    b: Math.max(0, Math.min(100, Math.round(Number(result?.brittleness ?? 0)))),
    v: clampStr(result?.verdict || ""),
    f: failures.slice(0, 3).map(x => ({
      r: clampStr(x?.role || "", 40),
      m: clampStr(x?.failure_mode || "", 120)
    })),
    t: Number(result?.timestamp ? new Date(result.timestamp).getTime() : Date.now())
  };
}

export function encodeShare(result) {
  try {
    return toB64Url(JSON.stringify(buildSharePayload(result)));
  } catch {
    return "";
  }
}

// Decode a share token back into a payload. Returns null on anything malformed,
// and clamps/validates every field so a hand-tampered link can't inject junk
// into the render.
export function decodeShare(token) {
  if (!token || typeof token !== "string") return null;
  try {
    const obj = JSON.parse(fromB64Url(token));
    if (!obj || typeof obj !== "object") return null;
    return {
      d: clampStr(obj.d || "A decision"),
      b: Math.max(0, Math.min(100, Math.round(Number(obj.b)) || 0)),
      v: clampStr(obj.v || ""),
      f: Array.isArray(obj.f) ? obj.f.slice(0, 3).map(x => ({
        r: clampStr(x?.r || "", 40),
        m: clampStr(x?.m || "", 120)
      })) : [],
      t: Number.isFinite(Number(obj.t)) ? Number(obj.t) : null
    };
  } catch {
    return null;
  }
}

// Read a share token from the current URL (hash form: #share=<token>).
// Hash is used (not query) so it never hits the server and works on any static host.
export function readShareFromUrl() {
  try {
    const h = window.location.hash || "";
    const m = /[#&]share=([^&]+)/.exec(h);
    return m ? decodeShare(decodeURIComponent(m[1])) : null;
  } catch {
    return null;
  }
}

// Build a full shareable URL for a result.
export function buildShareUrl(result) {
  const token = encodeShare(result);
  if (!token) return "";
  try {
    const base = `${window.location.origin}${window.location.pathname}`;
    return `${base}#share=${encodeURIComponent(token)}`;
  } catch {
    return "";
  }
}

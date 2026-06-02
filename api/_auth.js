// ─────────────────────────────────────────────────────────────────────────────
// Shared server-side auth guard for the API routes.
//
// Purpose: stop unauthenticated requests from spending Anthropic budget. The
// client UI gates analysis behind sign-in, but a scripted request bypasses the
// UI — so the real cost protection has to live here, on the server.
//
// Behaviour:
//   • Supabase NOT configured on the server  →  guard is a NO-OP (returns ok).
//     This keeps local dev, tests, and pure-local deployments working. The
//     protection switches ON automatically once SUPABASE_URL + anon key are set,
//     which a public launch requires anyway (the gate needs an auth backend).
//   • Supabase configured + no/!invalid token →  { ok:false, status:401 }.
//   • Supabase configured + valid token       →  { ok:true, user }.
//
// Underscore-prefixed files in /api are not treated as routes by Vercel, so this
// is a safe shared helper. The Replit host (server/index.js) imports it too.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  "";
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  "";

export function authConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

// Compact disposable-domain set for server-side defense in depth. Mirrors the
// high-traffic entries from src/lib/email-defense.js (kept inline so this file
// stays dependency-free across the Vercel/Replit deploy boundary).
const DISPOSABLE = new Set([
  "mailinator.com","guerrillamail.com","guerrillamail.net","10minutemail.com",
  "tempmail.com","temp-mail.org","tempmailo.com","throwawaymail.com","throwaway.email",
  "getnada.com","nada.email","yopmail.com","trashmail.com","sharklasers.com","grr.la",
  "spam4.me","maildrop.cc","mailnesia.com","mohmal.com","fakeinbox.com","mailcatch.com",
  "tempr.email","discard.email","33mail.com","burnermail.io","temp-mail.io","tempail.com",
  "moakt.com","1secmail.com","1secmail.org","1secmail.net","dispostable.com","mintemail.com"
]);
function isDisposableDomain(email) {
  const at = String(email).toLowerCase().lastIndexOf("@");
  if (at === -1) return false;
  return DISPOSABLE.has(String(email).toLowerCase().slice(at + 1));
}

function bearer(req) {
  const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  return m ? m[1].trim() : null;
}

// Validate a Supabase access token by asking Supabase who it belongs to.
// One network call, no JWT library, no secret needed beyond the anon key.
export async function verifyToken(token, deps = {}) {
  const url = deps.url || SUPABASE_URL;
  const key = deps.key || SUPABASE_ANON_KEY;
  const doFetch = deps.fetch || fetch;
  if (!token) return { ok: false, status: 401, error: "Sign in to run an analysis." };
  try {
    const r = await doFetch(`${url}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: key }
    });
    if (!r.ok) return { ok: false, status: 401, error: "Your session has expired — sign in again." };
    const user = await r.json();
    if (!user || !user.id) return { ok: false, status: 401, error: "Your session has expired — sign in again." };
    // Defense in depth (anti-Smurf): reject accounts on disposable email
    // domains here too — the client blocks them at signup, but this catches
    // anyone who bypassed the UI and signed up directly via the Supabase SDK.
    if (user.email && isDisposableDomain(user.email)) {
      return { ok: false, status: 403, error: "This account uses a disposable email. Sign up with a permanent address." };
    }
    return { ok: true, user };
  } catch {
    // If the auth backend is unreachable, fail closed (protect the budget).
    return { ok: false, status: 503, error: "Could not verify your session. Try again in a moment." };
  }
}

// Convenience: guard a request. Returns { ok:true } to proceed, or a result you
// can turn into an HTTP response. No-op when auth isn't configured.
export async function requireAuth(req, deps = {}) {
  if (!authConfigured() && !deps.url) return { ok: true, user: null, unconfigured: true };
  return verifyToken(bearer(req), deps);
}

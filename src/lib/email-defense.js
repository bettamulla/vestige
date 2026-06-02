// ─────────────────────────────────────────────────────────────────────────────
// Email defenses (anti-Smurf Layers 1 + 1.5).
//
// Layer 1  — reject disposable / throwaway email domains at signup. Kills the
//            lazy majority of multi-accounting ("spin up a temp-mail address").
// Layer 1.5 — normalize emails so provider aliasing can't mint "new" accounts
//            from one inbox (Gmail ignores dots and +suffixes; many providers
//            treat +suffix as the same mailbox). Normalizing before storing
//            collapses you+1@, you+2@, y.o.u@ to a single identity.
//
// This is the FREE, in-code, privacy-clean layer. It does not stop a determined
// abuser (that needs fingerprinting/phone — see README), but it raises the cost
// of casual Smurfing above what a free analysis is worth. Used by both the
// client (instant feedback) and the server (real enforcement) so it can't be
// bypassed by calling the API directly.
// ─────────────────────────────────────────────────────────────────────────────

// A pragmatic blocklist of common disposable/temp-mail domains. Not exhaustive —
// exhaustive is impossible — but covers the high-traffic throwaway services.
export const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.net", "guerrillamail.org",
  "10minutemail.com", "10minutemail.net", "tempmail.com", "temp-mail.org",
  "tempmailo.com", "throwawaymail.com", "throwaway.email", "getnada.com",
  "nada.email", "dispostable.com", "yopmail.com", "yopmail.net", "yopmail.fr",
  "trashmail.com", "trashmail.net", "sharklasers.com", "grr.la", "guerrillamailblock.com",
  "spam4.me", "maildrop.cc", "mailnesia.com", "mintemail.com", "mohmal.com",
  "fakeinbox.com", "tempinbox.com", "emailondeck.com", "mailcatch.com",
  "inboxbear.com", "tempr.email", "discard.email", "33mail.com", "anonbox.net",
  "burnermail.io", "temp-mail.io", "tempail.com", "moakt.com", "luxusmail.org",
  "mail-temp.com", "mailtemp.net", "fakemailgenerator.com", "harakirimail.com",
  "tmpmail.org", "tmpmail.net", "1secmail.com", "1secmail.org", "1secmail.net",
  "wegwerfmail.de", "einrot.com", "cuvox.de", "dayrep.com", "gustr.com",
  "jourrapide.com", "rhyta.com", "superrito.com", "teleworm.us", "armyspy.com"
]);

// Providers whose +suffix denotes the same inbox (so strip the suffix).
const PLUS_ALIAS_PROVIDERS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "fastmail.com", "protonmail.com", "proton.me", "icloud.com", "me.com"
]);

// Providers that also ignore dots in the local part (Gmail family).
const DOT_INSENSITIVE_PROVIDERS = new Set(["gmail.com", "googlemail.com"]);

// Basic shape check.
export function isValidEmailShape(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function emailDomain(email) {
  const at = String(email).toLowerCase().trim().lastIndexOf("@");
  return at === -1 ? "" : String(email).toLowerCase().trim().slice(at + 1);
}

export function isDisposableEmail(email) {
  return DISPOSABLE_DOMAINS.has(emailDomain(email));
}

// Canonical form used for identity/uniqueness. Lowercases, strips +suffix on
// providers that ignore it, and removes dots on Gmail. googlemail → gmail.
export function normalizeEmail(email) {
  if (!isValidEmailShape(email)) return String(email || "").toLowerCase().trim();
  let [local, domain] = String(email).toLowerCase().trim().split("@");
  if (domain === "googlemail.com") domain = "gmail.com";
  if (PLUS_ALIAS_PROVIDERS.has(domain)) local = local.split("+")[0];
  if (DOT_INSENSITIVE_PROVIDERS.has(domain)) local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

// One call the signup path uses. Returns { ok } or { ok:false, reason }.
export function checkSignupEmail(email) {
  if (!isValidEmailShape(email)) return { ok: false, reason: "Enter a valid email address." };
  if (isDisposableEmail(email)) return { ok: false, reason: "Please use a permanent email address — disposable inboxes aren't accepted." };
  return { ok: true, normalized: normalizeEmail(email) };
}

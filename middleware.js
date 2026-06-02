// ─────────────────────────────────────────────────────────────────────────────
// Vercel Edge Middleware — the API auth chokepoint for the Vercel deployment.
//
// On Replit, server/index.js guards every route in one place. On Vercel the
// routes run independently, so this middleware enforces the same rule: an
// unauthenticated request to a budget-spending /api route is rejected before it
// reaches the handler. Mirrors api/auth.js behaviour:
//   • Supabase not configured → pass through (dev/local).
//   • Configured + no/invalid token → 401.
//   • /api/healthz is always allowed (health checks must not require auth).
// ─────────────────────────────────────────────────────────────────────────────

export const config = {
  // Run on API routes AND page navigations, so maintenance mode can gate the
  // whole app (not just API calls). Static assets are excluded so the
  // maintenance page itself and its fonts/styles still load.
  matcher: ["/((?!_next|assets|favicon|.*\\.(?:js|css|svg|png|jpg|jpeg|webp|ico|woff|woff2|ttf)).*)"]
};

// Maintenance splash — shown to everyone when MAINTENANCE_MODE is on. Inline,
// self-contained HTML (no external deps) so it renders even mid-deploy. Matches
// the Vestige aesthetic: dark, serif headline, purple/cyan accent.
const MAINTENANCE_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Vestige — Back soon</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@300;400;500&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#08080d;color:#fff;font-family:'Inter',-apple-system,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;overflow:hidden;position:relative}
  .orb{position:absolute;border-radius:50%;filter:blur(60px);pointer-events:none}
  .orb1{top:-10%;right:-15%;width:340px;height:340px;background:radial-gradient(circle,rgba(124,92,191,.22),transparent 70%);animation:f 11s ease-in-out infinite alternate}
  .orb2{bottom:-12%;left:-18%;width:300px;height:300px;background:radial-gradient(circle,rgba(94,212,212,.15),transparent 70%);animation:f 13s ease-in-out infinite alternate-reverse}
  @keyframes f{to{transform:translateY(26px) scale(1.06)}}
  .wrap{position:relative;z-index:1;max-width:440px;text-align:center}
  .mark{display:inline-flex;align-items:center;gap:10px;margin-bottom:36px}
  .mark svg{filter:drop-shadow(0 0 14px rgba(124,92,191,.6));animation:p 4s ease-in-out infinite}
  @keyframes p{0%,100%{filter:drop-shadow(0 0 10px rgba(124,92,191,.45))}50%{filter:drop-shadow(0 0 20px rgba(124,92,191,.8))}}
  .mark span{font-family:'Instrument Serif',Georgia,serif;font-size:22px}
  .eyebrow{font-size:10px;letter-spacing:.25em;text-transform:uppercase;color:#5ED4D4;margin-bottom:18px}
  h1{font-family:'Instrument Serif',Georgia,serif;font-size:clamp(40px,11vw,58px);font-weight:400;line-height:1;letter-spacing:-.02em;margin-bottom:24px}
  h1 .g{background:linear-gradient(135deg,#9B7FD4,#5ED4D4);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;font-style:italic}
  p{font-size:15px;line-height:1.65;color:rgba(255,255,255,.55);font-weight:300;max-width:340px;margin:0 auto}
  .foot{margin-top:40px;font-size:10px;letter-spacing:.25em;text-transform:uppercase;color:#44445a}
</style></head>
<body>
  <div class="orb orb1"></div><div class="orb orb2"></div>
  <div class="wrap">
    <div class="mark">
      <svg width="24" height="24" viewBox="0 0 32 32" fill="none"><path d="M5 8 L16 26 L27 8" stroke="#9B7FD4" stroke-width="3.4" stroke-linecap="square"/><circle cx="16" cy="15.5" r="2.9" fill="#9B7FD4"/></svg>
      <span>Vestige</span>
    </div>
    <div class="eyebrow">Temporarily down</div>
    <h1>Sharpening the <span class="g">blade.</span></h1>
    <p>Vestige is being tuned. It'll be back shortly — come back soon and it'll be ready to tell you where your thinking breaks.</p>
    <div class="foot">Vestige · maintenance</div>
  </div>
</body></html>`;

export default async function middleware(req) {
  const url = new URL(req.url);

  // ── Maintenance mode ──────────────────────────────────────────────────────
  // Flip MAINTENANCE_MODE=on in Vercel env (then redeploy) to show the splash to
  // everyone; set it off (or remove) to go live. API requests get JSON 503 so no
  // route runs; page requests get the splash HTML.
  const maint = (process.env.MAINTENANCE_MODE || "").toLowerCase();
  if (maint === "on" || maint === "true" || maint === "1") {
    // Allow the health check through even in maintenance (uptime monitors).
    if (url.pathname !== "/api/healthz") {
      if (url.pathname.startsWith("/api/")) {
        return new Response(JSON.stringify({ error: "Vestige is in maintenance. Back shortly." }), {
          status: 503,
          headers: { "Content-Type": "application/json", "Retry-After": "3600" }
        });
      }
      return new Response(MAINTENANCE_HTML, {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8", "Retry-After": "3600", "Cache-Control": "no-store" }
      });
    }
  }

  // Health check must stay open.
  if (url.pathname === "/api/healthz") return;

  // Auth chokepoint only applies to API routes (page navigations pass through
  // once maintenance is off).
  if (!url.pathname.startsWith("/api/")) return;

  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || "";

  // Not configured → no-op (keeps pure-local / preview deployments working).
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return;

  const authz = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(authz);
  const token = m ? m[1].trim() : null;

  const deny = (status, error) =>
    new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } });

  if (!token) return deny(401, "Sign in to run an analysis.");

  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY }
    });
    if (!r.ok) return deny(401, "Your session has expired — sign in again.");
    const user = await r.json();
    if (!user || !user.id) return deny(401, "Your session has expired — sign in again.");
    // Anti-Smurf defense in depth: reject disposable-email accounts here too.
    if (user.email) {
      const at = String(user.email).toLowerCase().lastIndexOf("@");
      const domain = at === -1 ? "" : String(user.email).toLowerCase().slice(at + 1);
      const DISPOSABLE = new Set([
        "mailinator.com","guerrillamail.com","guerrillamail.net","10minutemail.com",
        "tempmail.com","temp-mail.org","tempmailo.com","throwawaymail.com","throwaway.email",
        "getnada.com","nada.email","yopmail.com","trashmail.com","sharklasers.com","grr.la",
        "spam4.me","maildrop.cc","mailnesia.com","mohmal.com","fakeinbox.com","mailcatch.com",
        "tempr.email","discard.email","33mail.com","burnermail.io","temp-mail.io","tempail.com",
        "moakt.com","1secmail.com","1secmail.org","1secmail.net","dispostable.com","mintemail.com"
      ]);
      if (DISPOSABLE.has(domain)) return deny(403, "This account uses a disposable email. Sign up with a permanent address.");
    }
    // Authenticated — let the request proceed to the route.
    return;
  } catch {
    return deny(503, "Could not verify your session. Try again in a moment.");
  }
}

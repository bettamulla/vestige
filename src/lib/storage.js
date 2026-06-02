// ─────────────────────────────────────────────────────────────────────────────
// Vestige storage layer
//
// localStorage-first with OPTIONAL Supabase cloud sync.
//
//   • No config  →  pure localStorage. App works instantly, no login, offline.
//   • Supabase configured + signed in  →  decisions mirror to the cloud and
//     sync across devices. localStorage stays as the fast path + offline cache.
//
// This keeps the original standalone behaviour intact and layers cloud sync on
// top only when the user opts in. Nothing here forces an account.
// ─────────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = "vestige-memory-v2";

const SUPABASE_URL = import.meta.env?.VITE_SUPABASE_URL || "";
const SUPABASE_ANON_KEY = import.meta.env?.VITE_SUPABASE_ANON_KEY || "";

export function isCloudConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

// Lazily created Supabase client (only if configured). Imported dynamically so
// the bundle has no hard dependency when running in pure-local mode.
let _client = null;
let _clientPromise = null;
async function getClient() {
  if (!isCloudConfigured()) return null;
  if (_client) return _client;
  if (!_clientPromise) {
    _clientPromise = import("@supabase/supabase-js").then(({ createClient }) => {
      _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true }
      });
      return _client;
    });
  }
  return _clientPromise;
}

// ── localStorage primitives (always available) ───────────────────────────────
export function localLoad() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    // Guard against corrupted storage holding a non-array: downstream code does
    // .map/.filter and would crash on anything else.
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
export function localSave(entries) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-50))); }
  catch {}
}

// ── Auth (only meaningful when cloud is configured) ───────────────────────────
export const auth = {
  async getUser() {
    const c = await getClient();
    if (!c) return null;
    const { data: { user } } = await c.auth.getUser();
    return user;
  },
  async signUp(email, password) {
    const c = await getClient();
    if (!c) throw new Error("Cloud sync is not configured");
    const { data, error } = await c.auth.signUp({ email, password });
    if (error) throw error;
    return data.user;
  },
  async signIn(email, password) {
    const c = await getClient();
    if (!c) throw new Error("Cloud sync is not configured");
    const { data, error } = await c.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.user;
  },
  async signOut() {
    const c = await getClient();
    if (!c) return;
    await c.auth.signOut();
  },
  // Magic-link (passwordless) sign-in: sends a one-time link/code to the email.
  async sendMagicLink(email) {
    const c = await getClient();
    if (!c) throw new Error("Cloud sync is not configured");
    const { error } = await c.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: typeof window !== "undefined" ? window.location.origin : undefined }
    });
    if (error) throw error;
    return true;
  },
  // Verify a 6-digit code (the fallback if the user types the code instead of
  // clicking the link).
  async verifyCode(email, token) {
    const c = await getClient();
    if (!c) throw new Error("Cloud sync is not configured");
    const { data, error } = await c.auth.verifyOtp({ email, token, type: "email" });
    if (error) throw error;
    return data.user;
  },
  // The current session's access token — sent to /api routes so the server can
  // verify the caller is authenticated before spending API budget.
  async getAccessToken() {
    const c = await getClient();
    if (!c) return null;
    const { data: { session } } = await c.auth.getSession();
    return session?.access_token || null;
  },
  async onChange(cb) {
    const c = await getClient();
    if (!c) return () => {};
    const { data: { subscription } } = c.auth.onAuthStateChange((_e, session) => cb(session?.user || null));
    return () => subscription?.unsubscribe?.();
  }
};

// ── Cloud data ops ────────────────────────────────────────────────────────────
// Each decision entry is stored whole as JSONB in `data`, preserving the exact
// shape the app uses. A couple of columns are duplicated out for indexing.
async function cloudLoad() {
  const c = await getClient();
  if (!c) return null;
  const user = await auth.getUser();
  if (!user) return null;
  const { data, error } = await c
    .from("decisions")
    .select("data")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data || []).map(r => r.data);
}

async function cloudUpsert(entries) {
  const c = await getClient();
  if (!c) return;
  const user = await auth.getUser();
  if (!user) return;
  const rows = entries.map(e => ({
    id: String(e.id),
    user_id: user.id,
    brittleness: e.brittleness ?? null,
    data: e
  }));
  const { error } = await c.from("decisions").upsert(rows, { onConflict: "id" });
  if (error) throw error;
}

async function cloudClear() {
  const c = await getClient();
  if (!c) return;
  const user = await auth.getUser();
  if (!user) return;
  const { error } = await c.from("decisions").delete().eq("user_id", user.id);
  if (error) throw error;
}

// ── Public API used by the app ────────────────────────────────────────────────
// Mode reflects what's actually active right now.
export async function getMode() {
  if (!isCloudConfigured()) return "local";
  const user = await auth.getUser();
  return user ? "cloud" : "local";
}

// Load: returns localStorage immediately via localLoad() elsewhere; this async
// variant pulls cloud data when signed in and reconciles with local.
export async function syncDown() {
  const mode = await getMode();
  if (mode !== "cloud") return null;
  const cloud = await cloudLoad();
  if (!cloud) return null;
  // Merge: cloud is source of truth, but keep any local-only entries not yet pushed.
  const local = localLoad();
  const byId = new Map();
  for (const e of cloud) byId.set(String(e.id), e);
  for (const e of local) if (!byId.has(String(e.id))) byId.set(String(e.id), e);
  const merged = [...byId.values()].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  localSave(merged);
  // Push any local-only entries up so cloud catches up.
  const cloudIds = new Set(cloud.map(e => String(e.id)));
  const localOnly = merged.filter(e => !cloudIds.has(String(e.id)));
  if (localOnly.length) { try { await cloudUpsert(localOnly); } catch {} }
  return merged;
}

// Save: write localStorage synchronously (caller does that), then mirror to cloud.
export async function syncUp(entries) {
  const mode = await getMode();
  if (mode !== "cloud") return;
  try { await cloudUpsert(entries); } catch {}
}

export async function clearAll() {
  localSave([]);
  const mode = await getMode();
  if (mode === "cloud") { try { await cloudClear(); } catch {} }
}

// ── Plan & usage (freemium volume cap) ────────────────────────────────────────
// localStorage-first, cloud-synced when signed in. The entitlement mechanic is
// real and enforced in the UI; for signed-in users plan + usage persist to the
// cloud so they survive a storage clear and follow across devices.
const PLAN_KEY  = "vestige-plan-v1";
const USAGE_KEY = "vestige-usage-v1";
export const FREE_MONTHLY_ANALYSES = 5;

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function getPlan() {
  try { return JSON.parse(localStorage.getItem(PLAN_KEY) || '{"plan":"free"}').plan || "free"; }
  catch { return "free"; }
}
export function setPlanLocal(plan) {
  try { localStorage.setItem(PLAN_KEY, JSON.stringify({ plan, since: new Date().toISOString() })); } catch {}
}

// Returns { month, analyses } with monthly rollover applied.
export function getUsage() {
  let u;
  try { u = JSON.parse(localStorage.getItem(USAGE_KEY) || "null"); } catch { u = null; }
  const month = currentMonth();
  if (!u || u.month !== month) { u = { month, analyses: 0 }; try { localStorage.setItem(USAGE_KEY, JSON.stringify(u)); } catch {} }
  return u;
}
function writeUsage(u) { try { localStorage.setItem(USAGE_KEY, JSON.stringify(u)); } catch {} }

// Increment this month's analysis count (call on a successful metered analysis).
export function incrementUsageLocal() {
  const u = getUsage();
  u.analyses += 1;
  writeUsage(u);
  return u;
}

// Cloud: a single row per user holding plan + this month's usage.
async function cloudReadPlanUsage() {
  const c = await getClient(); if (!c) return null;
  const user = await auth.getUser(); if (!user) return null;
  const { data, error } = await c.from("usage").select("plan, month, analyses").eq("user_id", user.id).maybeSingle();
  if (error || !data) return null;
  return data;
}
async function cloudWritePlanUsage(plan, usage) {
  const c = await getClient(); if (!c) return;
  const user = await auth.getUser(); if (!user) return;
  await c.from("usage").upsert({ user_id: user.id, plan, month: usage.month, analyses: usage.analyses }, { onConflict: "user_id" });
}

// On load: reconcile local with cloud (cloud authoritative for plan; usage takes
// the max so a cross-device clear can't reset the count downward within a month).
export async function syncPlanUsageDown() {
  const mode = await getMode();
  if (mode !== "cloud") return { plan: getPlan(), usage: getUsage() };
  const cloud = await cloudReadPlanUsage();
  const localUsage = getUsage();
  if (!cloud) {
    // First time: push local up.
    await cloudWritePlanUsage(getPlan(), localUsage);
    return { plan: getPlan(), usage: localUsage };
  }
  const plan = cloud.plan || "free";
  setPlanLocal(plan);
  const month = currentMonth();
  const analyses = cloud.month === month ? Math.max(cloud.analyses || 0, localUsage.month === month ? localUsage.analyses : 0) : 0;
  const usage = { month, analyses };
  writeUsage(usage);
  await cloudWritePlanUsage(plan, usage);
  return { plan, usage };
}

export async function incrementUsage() {
  const u = incrementUsageLocal();
  const mode = await getMode();
  if (mode === "cloud") { try { await cloudWritePlanUsage(getPlan(), u); } catch {} }
  return u;
}

export async function setPlan(plan) {
  setPlanLocal(plan);
  const mode = await getMode();
  if (mode === "cloud") { try { await cloudWritePlanUsage(plan, getUsage()); } catch {} }
}


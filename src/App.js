import { useState, useRef, useEffect } from "react";
import { syncUp, syncDown, clearAll as cloudClearAll, isCloudConfigured, getMode, auth as cloudAuth, getPlan, getUsage, incrementUsage, setPlan as setPlanStore, syncPlanUsageDown, FREE_MONTHLY_ANALYSES } from "./lib/storage";
import { checkSignupEmail } from "./lib/email-defense";
import { readShareFromUrl, buildShareUrl, encodeShare } from "./lib/share";

const PURPLE        = "#7C5CBF";
const PURPLE_BRIGHT = "#9B7FD4";
const PURPLE_DIM    = "#3d2260";
const CYAN          = "#5ED4D4";
const STORAGE_KEY   = "vestige-memory-v2";
const ONBOARDING_KEY = "vestige-seen-intro-v1";
const MAX_CHARS     = 1000;
const CHAT_MAX_CHARS = 1000; // follow-up chat message cap (with live counter)
const PRO_PRICE     = "£12/mo"; // single source of truth for the Pro price

// Module-level helper so any component can attach the auth token to /api calls.
// The server rejects unauthenticated requests to budget-spending routes, so
// every call to /api/* must carry the token when the user is signed in.
async function authedHeaders() {
  const h = { "Content-Type": "application/json" };
  try {
    const token = await cloudAuth.getAccessToken();
    if (token) h.Authorization = `Bearer ${token}`;
  } catch {}
  return h;
}

// Robust API caller. Wraps fetch so EVERY call handles the real failure modes a
// user hits: network drop, a non-JSON error page (platform 502 / gateway HTML),
// auth rejection, or a JSON body with an { error } field. Always throws an Error
// with a human-readable message — never a cryptic "Unexpected token <".
async function callApi(path, body) {
  let res;
  try {
    res = await fetch(path, { method: "POST", headers: await authedHeaders(), body: JSON.stringify(body) });
  } catch {
    throw new Error("Network error — check your connection and try again.");
  }
  // Read the body once, as text, so we can handle JSON and non-JSON uniformly.
  const raw = await res.text().catch(() => "");
  let data = null;
  if (raw) { try { data = JSON.parse(raw); } catch { data = null; } }

  if (!res.ok) {
    // Prefer a server-sent message; otherwise map the status to something useful.
    const msg = (data && data.error) ? data.error
      : res.status === 401 ? "Sign in to run an analysis."
      : res.status === 429 ? "You're going a little fast — wait a moment and retry."
      : res.status === 503 ? "The service is briefly unavailable. Try again shortly."
      : res.status >= 500 ? "The analysis service hit an error. Re-run it."
      : "Request failed. Try again.";
    throw new Error(msg);
  }
  if (data && data.error) throw new Error(data.error);
  if (data == null) throw new Error("The analysis came back unreadable. Re-run it.");
  return data;
}

// ── Score helpers ─────────────────────────────────────────────────────────────
function scoreColor(s) {
  if (s >= 75) return "#ef4444";
  if (s >= 50) return "#f97316";
  if (s >= 25) return PURPLE_BRIGHT;
  return "#22c55e";
}
function scoreLabel(s) {
  if (s >= 75) return "Critical";
  if (s >= 50) return "Elevated";
  if (s >= 25) return "Moderate";
  return "Stable";
}

// ── Memory intelligence ───────────────────────────────────────────────────────
// Scores each entry 0-100 by stakes + reversibility + brittleness
function importanceScore(entry) {

  const stakesMap  = { critical: 90, high: 70, medium: 40, low: 15 };
  const revMap     = { irreversible: 90, partial: 55, reversible: 20 };
  const stakes     = stakesMap[entry.stakes?.toLowerCase()] || 35;
  const rev        = revMap[entry.full?.anatomy?.reversibility?.toLowerCase()] || 40;
  const brit       = entry.brittleness || 50;
  return Math.min(100, Math.round(stakes * 0.3 + rev * 0.2 + brit * 0.5));
}

// ── Forgetting curve ──────────────────────────────────────────────────────────
// Memory works like memory. Importance is intrinsic and fixed; what decays is
// *recall strength*, following an Ebbinghaus curve R = e^(-elapsed / stability).
// Revisiting a decision reinforces it (stability grows), so the traces you
// actually engage with resist decay — exactly as in human memory.
const DAY_MS = 86400000;

// Backward-compat retention from a raw importance number (legacy callers).
function retentionClass(importance) {
  if (importance >= 65) return "full";
  if (importance >= 35) return "partial";
  return "compress";
}

// Intrinsic importance seeds the initial stability, in days (4–30).
function initialStability(importance) {
  return 4 + (Math.max(0, Math.min(100, importance)) / 100) * 26;
}

// Recall probability right now, 0..1.
function computeStrength(entry, now = Date.now()) {
  const importance   = entry.importance || importanceScore(entry);
  const stability    = entry.stability || initialStability(importance);
  const last         = new Date(entry.lastAccessed || entry.timestamp).getTime();
  const elapsedDays  = Math.max(0, (now - last) / DAY_MS);
  return Math.exp(-elapsedDays / stability);
}

// Retention class from strength. High-importance traces get a floor — the gist
// of a critical decision should never fully vanish.
function retentionFromStrength(strength, importance) {
  if (strength >= 0.6)  return "full";
  if (strength >= 0.28) return importance >= 80 ? "full" : "partial";
  return importance >= 80 ? "partial" : "compress";
}

// Reinforce a trace: revisiting strengthens it (spaced-repetition growth).
function reinforce(entry, now = Date.now()) {
  const importance = entry.importance || importanceScore(entry);
  const base       = entry.stability || initialStability(importance);
  const stability  = Math.min(720, base * 1.7 + 3);   // grows, capped at ~2yr
  return {
    ...entry,
    importance,
    stability,
    accessCount: (entry.accessCount || 0) + 1,
    lastAccessed: new Date(now).toISOString()
  };
}

// Distill a lasting lesson from a post-mortem. The episode may compress away,
// but this semantic residue survives.
function consolidateLesson(entry) {
  const pm = entry.postMortem;
  if (!pm) return entry.lesson || null;
  const outcome = {
    proceeded_good: "Proceeding paid off",
    proceeded_bad:  "Proceeding backfired",
    modified:       "Modifying first was right",
    abandoned:      "Walking away was right"
  }[pm.outcome] || "Resolved";
  const trig = pm.triggered ? "the flagged risk did hit" : "the flagged risk never hit";
  const arch = entry.archetype && entry.archetype !== "generic"
    ? entry.archetype.replace(/_/g, " ") + ": " : "";
  return `${arch}${outcome} — ${trig}.`;
}

// Apply the curve across all entries on load. Initialises legacy entries and
// compresses traces whose recall strength has fallen far enough.
function applyDecay(entries, now = Date.now()) {
  return entries.map(e => {
    const importance   = e.importance || importanceScore(e);
    const stability    = e.stability  || initialStability(importance);
    const lastAccessed = e.lastAccessed || e.timestamp;
    const strength     = computeStrength({ ...e, importance, stability, lastAccessed }, now);
    const retention    = retentionFromStrength(strength, importance);
    const lesson       = e.lesson || consolidateLesson(e);
    const base = { ...e, importance, stability, lastAccessed, accessCount: e.accessCount || 0, strength, retention, lesson };
    if (retention === "compress" && e.full) {
      const { full: _f, ...rest } = base;
      return { ...rest, summary: e.summary || `${e.decision} - Score: ${e.brittleness}` };
    }
    return base;
  });
}

// ── Active recall ─────────────────────────────────────────────────────────────
// When a new decision is analysed, surface related past traces and — crucially —
// what actually happened. Memory informing the present.
const RECALL_STOPWORDS = new Set("the a an to of in on for and or but with my our i we you it is are be will would should could to do don't into about over under more less most least than then this that these those if when how what why want need get got make made take taken give given".split(" "));
function tokenise(text) {
  return (text || "").toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2 && !RECALL_STOPWORDS.has(t));
}
function findRecall(memory, newEntry, max = 3, now = Date.now()) {
  const newTokens = new Set(tokenise(newEntry.decision));
  const newModes  = new Set((newEntry.full?.failures || []).map(f => (f.failure_mode || "").toLowerCase()));
  const scored = memory
    .filter(e => e.id !== newEntry.id && e.id !== newEntry.parentId)
    .map(e => {
      let score = 0;
      if (e.archetype && newEntry.archetype && e.archetype !== "generic" && e.archetype === newEntry.archetype) score += 40;
      const eTokens = tokenise(e.decision || e.summary);
      const overlap = eTokens.filter(t => newTokens.has(t)).length;
      score += Math.min(30, overlap * 8);
      const eModes = (e.full?.failures || []).map(f => (f.failure_mode || "").toLowerCase());
      if (eModes.some(m => newModes.has(m))) score += 12;
      if (e.postMortem) score += 15;
      if (e.postMortem?.triggered) score += 10;
      // Decay weighting: a vivid, reinforced memory pulls harder on the present
      // than one that has nearly faded. The forgetting curve shapes what informs
      // you, not just what you see. Scales relevance by 0.55–1.3×.
      const strength = e.strength ?? computeStrength(e, now);
      score = score * (0.55 + strength * 0.75);
      return { entry: e, score, strength };
    })
    .filter(x => x.score >= 30)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
  return scored.map(x => x.entry);
}

// ── Residue clustering ────────────────────────────────────────────────────────
// The thesis' deep end: across the survivors of forgetting, do the residues
// share a shape? This is signal that only exists in the gaps left by decay.
//
// HARD DISCIPLINE AGAINST FALSE PATTERNS:
//   • A cluster needs ≥3 members. Two points are a line, not a pattern.
//   • Clusters form on OBJECTIVE keys (shared archetype, shared failure mode,
//     shared outcome), never on vibes — so the maths can't hallucinate.
//   • If nothing clusters, return []. Silence is a valid, frequent answer.
// The optional Claude call only NAMES a cluster the maths already proved.
function detectResidueClusters(memory) {
  // Only decisions that have left a durable trace worth comparing.
  const pool = memory.filter(e => e.lesson || e.postMortem || e.retention !== "full");
  if (pool.length < 4) return []; // not enough survivors to compare honestly

  const clusters = [];

  // 1) Archetype recurrence among resolved decisions.
  const byArch = {};
  pool.forEach(e => {
    const a = e.archetype && e.archetype !== "generic" ? e.archetype : null;
    if (a) (byArch[a] ||= []).push(e);
  });
  for (const [arch, members] of Object.entries(byArch)) {
    if (members.length >= 3) {
      const bad = members.filter(m => m.postMortem && (m.postMortem.triggered || m.postMortem.outcome === "proceeded_bad")).length;
      clusters.push({
        kind: "archetype",
        key: arch,
        members,
        strength: members.length + bad,
        fact: `${members.length} decisions of type "${arch.replace(/_/g, " ")}" have survived in memory${bad ? `, and ${bad} went badly` : ""}.`
      });
    }
  }

  // 2) A failure mode that recurs across different decisions.
  const byMode = {};
  pool.forEach(e => {
    const modes = new Set((e.full?.failures || []).map(f => (f.failure_mode || "").trim().toLowerCase()).filter(Boolean));
    modes.forEach(m => (byMode[m] ||= []).push(e));
  });
  for (const [mode, members] of Object.entries(byMode)) {
    if (members.length >= 3) {
      clusters.push({
        kind: "failure_mode",
        key: mode,
        members,
        strength: members.length + 1,
        fact: `The same failure mode — "${mode}" — was flagged across ${members.length} separate decisions.`
      });
    }
  }

  // 3) Outcome recurrence: the flagged risk keeps materialising.
  const triggered = pool.filter(e => e.postMortem?.triggered);
  if (triggered.length >= 3) {
    clusters.push({
      kind: "outcome",
      key: "risk_materialised",
      members: triggered,
      strength: triggered.length,
      fact: `In ${triggered.length} resolved decisions, the risk Vestige flagged actually materialised.`
    });
  }

  // Strongest first; cap at 3 so it stays a finding, not a wall.
  return clusters.sort((a, b) => b.strength - a.strength).slice(0, 3);
}

// ── Feed-forward: does a NEW decision walk into a surviving pattern? ───────────
// Matches an incoming decision against clusters that survived forgetting. When
// it matches, the decision inherits a warning the cluster earned — fed into the
// scoring (pre-analysis) and surfaced on the result (post-analysis, archetype-
// aware). This is the loop closing: the past changing the verdict of the present.
function matchClustersToDecision(clusters, decisionText, archetype = null, now = Date.now()) {
  if (!clusters || clusters.length === 0) return [];
  const tokens = new Set(tokenise(decisionText));
  const matches = [];
  for (const c of clusters) {
    let matched = false;
    let why = "";
    // Archetype match (only available post-analysis).
    if (c.kind === "archetype" && archetype && archetype !== "generic" && c.key === archetype) {
      matched = true; why = "same decision type";
    }
    // Failure-mode key terms appearing in the new decision text.
    if (!matched && c.kind === "failure_mode") {
      const keyTerms = tokenise(c.key);
      if (keyTerms.length && keyTerms.some(t => tokens.has(t))) { matched = true; why = "names the recurring failure"; }
    }
    // Text overlap with the cluster's own members (works pre-analysis).
    if (!matched) {
      const memberTokens = new Set();
      c.members.forEach(m => tokenise(m.decision || m.summary).forEach(t => memberTokens.add(t)));
      const overlap = [...tokens].filter(t => memberTokens.has(t)).length;
      if (overlap >= 2) { matched = true; why = "echoes past decisions in this cluster"; }
    }
    if (matched) {
      // How strongly do these traces survive? A pattern made of vivid, reinforced
      // memories carries more weight than one barely clinging on.
      const avgStrength = c.members.reduce((s, m) => s + (m.strength ?? computeStrength(m, now)), 0) / c.members.length;
      matches.push({ ...c, why, avgStrength });
    }
  }
  return matches.sort((a, b) => (b.strength * b.avgStrength) - (a.strength * a.avgStrength)).slice(0, 2);
}

// ── Principles — the top tier of memory: lessons that crystallised ────────────
// Human semantic memory: repeated episodic experiences harden into durable
// general knowledge. A principle here is a lesson VALIDATED across ≥3 outcome-
// resolved decisions in one territory, pointing consistently the same way. It
// carries its evidence, its time span, and — honestly — its exceptions. Mixed
// evidence forms NO principle: genuine uncertainty isn't dressed up as wisdom.
const ARCHETYPE_LABELS = {
  pricing_change: "pricing", hire_decision: "hiring", fire_decision: "personnel removal",
  scope_cut: "scope-cut", partnership: "partnership", market_entry: "market-entry",
  product_launch: "product-launch", capital_raise: "capital-raise", pivot: "pivot",
  restructure: "restructure", vendor_switch: "vendor-switch", contract_negotiation: "contract",
  role_redesign: "role-redesign", geographic_expansion: "expansion"
};
function archetypeLabel(a) { return ARCHETYPE_LABELS[a] || (a || "").replace(/_/g, " "); }

function timeSpanDays(members, now = Date.now()) {
  const times = members.map(e => new Date(e.timestamp).getTime()).filter(Boolean);
  if (times.length < 2) return 0;
  return Math.round((Math.max(...times) - Math.min(...times)) / 86400000);
}

function derivePrinciples(memory, now = Date.now()) {
  const validated = memory.filter(e => e.postMortem && e.commitment?.move && e.archetype && e.archetype !== "generic");
  const byArch = {};
  validated.forEach(e => (byArch[e.archetype] ||= []).push(e));

  const principles = [];
  for (const [arch, members] of Object.entries(byArch)) {
    if (members.length < 3) continue; // a principle must be earned across ≥3 validated decisions

    let proceedPunished = 0, cautionRewarded = 0, proceedRewarded = 0;
    members.forEach(e => {
      const m = e.commitment.move, pm = e.postMortem;
      if (m === "proceed" && (pm.triggered || pm.outcome === "proceeded_bad")) proceedPunished++;
      else if ((m === "modify" || m === "abandon") && (pm.outcome === "modified" || pm.outcome === "abandoned" || !pm.triggered)) cautionRewarded++;
      else if (m === "proceed" && pm.outcome === "proceeded_good" && !pm.triggered) proceedRewarded++;
    });

    const cautionSignal = proceedPunished + cautionRewarded; // both say caution pays here
    const boldSignal    = proceedRewarded;                   // proceeding works here
    const total = members.length;
    const span  = timeSpanDays(members, now);

    if (cautionSignal >= 3 && cautionSignal / total >= 0.6 && cautionSignal > boldSignal) {
      principles.push({
        territory: arch, direction: "caution",
        statement: `In ${archetypeLabel(arch)} decisions, holding back has served you — proceeding is where it's gone wrong.`,
        supportCount: cautionSignal, exceptions: boldSignal, total, timeSpanDays: span,
        strength: cautionSignal - boldSignal * 0.5, members
      });
    } else if (boldSignal >= 3 && boldSignal / total >= 0.6 && boldSignal > cautionSignal) {
      principles.push({
        territory: arch, direction: "bold",
        statement: `In ${archetypeLabel(arch)} decisions, proceeding has consistently worked out for you.`,
        supportCount: boldSignal, exceptions: cautionSignal, total, timeSpanDays: span,
        strength: boldSignal - cautionSignal * 0.5, members
      });
    }
    // else: genuinely mixed evidence → no principle (honest silence)
  }
  return principles.sort((a, b) => b.strength - a.strength);
}

// Does a new decision fall under an earned principle? (text/territory match)
function matchPrincipleToDecision(principles, decisionText, archetype = null) {
  if (!principles || principles.length === 0) return null;
  const tokens = new Set(tokenise(decisionText));
  for (const p of principles) {
    if (archetype && archetype !== "generic" && p.territory === archetype) return p;
    const memberTokens = new Set();
    p.members.forEach(m => tokenise(m.decision || m.summary).forEach(t => memberTokens.add(t)));
    const overlap = [...tokens].filter(t => memberTokens.has(t)).length;
    if (overlap >= 2) return p;
  }
  return null;
}

// ── Commitment consistency — the memory defends its validated lessons ─────────
// At the moment of choice, does the move you're about to make contradict your
// own OUTCOME-VALIDATED experience in this territory? This is the sharpest form
// of feed-forward: not "you've been here" but "you're about to repeat the thing
// that already burned you" — raised before you lock it in.
//
// DISCIPLINE: only validated outcomes (a post-mortem where reality actually
// ruled) count as evidence, and the challenge only fires on genuine directional
// opposition. No post-mortems → no challenge. Silence is the default.
function checkCommitmentConsistency(memory, entry, proposedMove, now = Date.now()) {
  if (!proposedMove || !entry) return null;

  // Territory: same archetype, or strong decay-weighted recall, excluding self.
  const territory = memory.filter(e => {
    if (e.id === entry.id) return false;
    if (!e.postMortem) return false; // only outcome-validated experience
    const sameArch = entry.archetype && e.archetype && entry.archetype !== "generic" && e.archetype === entry.archetype;
    return sameArch;
  });
  // Widen with recall if archetype alone is thin.
  if (territory.length < 1) {
    const recalled = findRecall(memory, entry, 4, now).filter(e => e.postMortem);
    recalled.forEach(e => { if (!territory.find(t => t.id === e.id)) territory.push(e); });
  }
  if (territory.length === 0) return null;

  // Past decisions where PROCEEDING went badly.
  const proceededBad = territory.filter(e =>
    e.commitment?.move === "proceed" && (e.postMortem.triggered || e.postMortem.outcome === "proceeded_bad")
  );
  // Past decisions where MODIFYING or WALKING worked out.
  const cautionWorked = territory.filter(e =>
    (e.commitment?.move === "modify" || e.commitment?.move === "abandon") &&
    (e.postMortem.outcome === "modified" || e.postMortem.outcome === "abandoned" || e.postMortem.outcome === "proceeded_good" || !e.postMortem.triggered)
  );

  // Strongest applicable challenge.
  if (proposedMove === "proceed" && proceededBad.length >= 1) {
    const wt = proceededBad.reduce((s, e) => s + (e.strength ?? computeStrength(e, now)), 0);
    return {
      severity: proceededBad.length >= 2 ? "high" : "medium",
      headline: proceededBad.length >= 2
        ? `You've proceeded on decisions like this ${proceededBad.length} times — and it went badly each time.`
        : "Last time you proceeded on a decision like this, it went badly.",
      body: "You're choosing to proceed again. Your own logged outcomes say that's the move that's burned you here.",
      evidence: proceededBad.slice(0, 4).map(e => ({ id: e.id, decision: e.decision || e.summary, brittleness: e.brittleness, lesson: e.lesson })),
      weight: wt
    };
  }
  if (proposedMove === "proceed" && cautionWorked.length >= 2) {
    return {
      severity: "medium",
      headline: `Holding back has worked for you here before (${cautionWorked.length}×).`,
      body: "You're proceeding now. In this territory, the times you modified or walked away are the ones that went well.",
      evidence: cautionWorked.slice(0, 4).map(e => ({ id: e.id, decision: e.decision || e.summary, brittleness: e.brittleness, lesson: e.lesson })),
      weight: cautionWorked.reduce((s, e) => s + (e.strength ?? computeStrength(e, now)), 0)
    };
  }

  return null;
}

// ── Reasoning trace — make the silent intelligence legible (honestly) ─────────
// Narrates the chain behind a read using ONLY real computed signals: how much
// relevant history exists, how vivid it is (decay), the connections drawn
// (recall + clusters), and how grounded the read therefore is. No fabricated
// confidence — perceived intelligence should track actual intelligence. When
// there's nothing relevant, it says so plainly: this was a cold read.
function buildReasoningTrace(memory, result, now = Date.now()) {
  const archetype = result?.anatomy?.archetype;
  const entryLike = { id: result?.entryId ?? -1, decision: result?.anatomy?.decision || "", parentId: null, archetype, full: result };
  const related = findRecall(memory, entryLike, 5, now);
  const resolvedRelated = related.filter(e => e.postMortem);
  const vivid  = related.filter(e => (e.strength ?? computeStrength(e, now)) >= 0.6);
  const faded  = related.filter(e => (e.strength ?? computeStrength(e, now)) < 0.6);
  const warnings = result?.inheritedWarnings || [];

  const steps = [];

  // 1) What it drew on.
  if (related.length === 0) {
    steps.push({ tone: "neutral", text: "Nothing in your memory resembles this decision. This is a first read of the situation on its own terms." });
  } else {
    const archLabel = archetype && archetype !== "generic" ? `"${archetype.replace(/_/g, " ")}"` : "related";
    steps.push({ tone: "neutral", text: `Found ${related.length} ${archLabel} decision${related.length !== 1 ? "s" : ""} in your memory worth comparing against.` });
    // 2) Decay state — how vivid the evidence is.
    if (vivid.length && faded.length) {
      steps.push({ tone: "neutral", text: `${vivid.length} ${vivid.length === 1 ? "is" : "are"} still vivid; ${faded.length} ${faded.length === 1 ? "has" : "have"} faded toward residue and carried less weight.` });
    } else if (vivid.length) {
      steps.push({ tone: "neutral", text: `${vivid.length === 1 ? "It is" : "They are"} still vivid in memory, so ${vivid.length === 1 ? "it" : "they"} weighed heavily here.` });
    } else if (faded.length) {
      steps.push({ tone: "soft", text: `${faded.length === 1 ? "It has" : "They have"} faded toward residue — present, but weighted down by time.` });
    }
  }

  // 3) Outcomes that are actually known.
  if (resolvedRelated.length) {
    const triggered = resolvedRelated.filter(e => e.postMortem.triggered).length;
    steps.push({
      tone: triggered ? "warn" : "good",
      text: triggered
        ? `Of ${resolvedRelated.length} you've seen through, the risk you were warned about actually hit in ${triggered}.`
        : `You saw ${resolvedRelated.length} through to an outcome, and the flagged risk didn't materialise.`
    });
  }

  // 4) The sharpest connection: a surviving pattern.
  if (warnings.length) {
    steps.push({ tone: "warn", text: `This repeats a pattern that survived in your memory: ${warnings[0].fact} I weighted the read up and said so in the verdict.` });
  }

  // Grounding: how trustworthy is this particular read?
  let grounding;
  if (resolvedRelated.length >= 2) {
    grounding = { level: "grounded", label: `Grounded in ${resolvedRelated.length} of your decisions with known outcomes`, color: "#22c55e" };
  } else if (resolvedRelated.length === 1 || related.length >= 1) {
    grounding = { level: "partial", label: resolvedRelated.length === 1
      ? "Partly grounded — one comparable decision with a known outcome"
      : `Partly grounded — ${related.length} comparable decision${related.length !== 1 ? "s" : ""}, outcomes not yet logged`, color: PURPLE_BRIGHT };
  } else {
    grounding = { level: "cold", label: "Cold read — no comparable history yet", color: "#666" };
  }

  // A one-line honesty note about the instrument's own track record for this user.
  const cal = computeCalibration(memory);
  if (cal.status === "ok") {
    if (cal.discrimination === "strong" || cal.discrimination === "moderate") {
      steps.push({ tone: "good", text: `For context: Vestige's score has been ${cal.discrimination === "strong" ? "a strong" : "a moderately reliable"} signal for you historically (${cal.auc100}% correct ranking).${cal.biasReliable ? (cal.biasPoints > 0 ? " It tends to run hot, so read this down a little." : " It tends to run cold, so weight this a little heavier.") : ""}` });
    } else if (cal.discrimination === "inverted") {
      steps.push({ tone: "warn", text: `Honest caveat: Vestige's score has been inverted for you historically — trust your own read over this number.` });
    } else {
      steps.push({ tone: "soft", text: `Honest caveat: Vestige's score hasn't been predictive for you yet (near chance). Treat this as a prompt to think, not a verdict.` });
    }
  }

  return { grounding, steps };
}
function buildDecisionProfile(memory, decisionText) {
  const resolved = memory.filter(e => e.postMortem);
  const priors = findRecall(memory, { id: -1, decision: decisionText, parentId: null, archetype: null, full: null }, 3)
    .filter(e => e.postMortem || e.commitment);
  // Feed-forward: surviving clusters this decision may be walking into.
  const clusters = detectResidueClusters(memory);
  const clusterMatches = matchClustersToDecision(clusters, decisionText, null);
  // The top tier: an earned principle governing this territory.
  const principle = matchPrincipleToDecision(derivePrinciples(memory, Date.now()), decisionText, null);

  if (resolved.length === 0 && priors.length === 0 && clusterMatches.length === 0 && !principle) {
    return { text: "", matches: [] };
  }

  const lines = [];
  lines.push("DECISION-MAKER HISTORY (use to personalise this analysis; never fabricate beyond what's stated):");
  lines.push(`- Decisions on record: ${memory.length}; with logged outcomes: ${resolved.length}.`);

  if (resolved.length) {
    // How often a flagged risk actually materialised.
    const triggered = resolved.filter(e => e.postMortem.triggered).length;
    lines.push(`- Flagged risks materialised in ${triggered} of ${resolved.length} resolved decisions.`);
    // Proceed-against-high-risk pattern.
    const proceededHigh = resolved.filter(e => (e.brittleness >= 50) && e.postMortem.outcome?.startsWith("proceeded"));
    const proceededHighBad = proceededHigh.filter(e => e.postMortem.outcome === "proceeded_bad" || e.postMortem.triggered).length;
    if (proceededHigh.length) {
      lines.push(`- When Vestige scored elevated/critical risk and the user proceeded anyway, it went badly ${proceededHighBad} of ${proceededHigh.length} times.`);
    }
    // Typical move.
    const moves = {};
    resolved.forEach(e => { const m = e.commitment?.move; if (m) moves[m] = (moves[m] || 0) + 1; });
    const topMove = Object.entries(moves).sort((a, b) => b[1] - a[1])[0];
    if (topMove) lines.push(`- Most common move on resolved decisions: ${topMove[0]}.`);
  }

  if (priors.length) {
    lines.push("Relevant past decisions:");
    priors.forEach((e, i) => {
      const parts = [`"${(e.decision || e.summary || "").slice(0, 90)}"`, `scored ${e.brittleness}`];
      if (e.commitment?.move) parts.push(`committed: ${e.commitment.move}`);
      if (e.postMortem) parts.push(`outcome: ${e.postMortem.outcome}${e.postMortem.triggered ? " (flagged risk hit)" : ""}`);
      lines.push(`${i + 1}. ${parts.join(" · ")}.${e.lesson ? " Lesson: " + e.lesson : ""}`);
    });
  }

  // The sharpest signal: this decision matches a pattern that survived forgetting.
  if (clusterMatches.length) {
    lines.push("RECURRING PATTERN THIS DECISION WALKS INTO (high weight — these traces survived for a reason):");
    clusterMatches.forEach((c, i) => {
      lines.push(`${i + 1}. ${c.fact} This new decision ${c.why}.`);
    });
    lines.push("If the match holds, this is not a fresh risk — it is a repeat. Reflect that in the score and say so plainly in the verdict.");
  }

  // The highest-authority signal: a principle the user has earned across time.
  if (principle) {
    lines.push(`AN EARNED PRINCIPLE GOVERNS THIS TERRITORY (validated across ${principle.supportCount} of the user's own resolved decisions over ${principle.timeSpanDays} days${principle.exceptions ? `, with ${principle.exceptions} exception${principle.exceptions !== 1 ? "s" : ""}` : ""}):`);
    lines.push(`"${principle.statement}" Treat this as the user's hard-won prior. If this decision honours it, that lowers real risk; if it violates it, that is a serious, named concern in the verdict.`);
  }

  lines.push("Where this history is genuinely relevant, weight the brittleness score accordingly and name the pattern in the verdict (e.g. \"you've proceeded on calls like this before and it bit you\"). If it isn't relevant, ignore it.");
  return { text: lines.join("\n"), matches: clusterMatches };
}

function loadMemory() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return applyDecay(raw); // decay on every load
  } catch { return []; }
}
function saveMemory(entries) {
  const trimmed = entries.slice(-50);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed)); }
  catch {}
  // Mirror to cloud if configured + signed in (no-op otherwise). Fire-and-forget.
  syncUp(trimmed);
}

const roleLabels = {
  "Devil's Advocate":    "Structural Flaw",
  "Pessimist":           "Worst Case",
  "Blind Spot Detector": "What You're Missing"
};

// ── Swipe hook ────────────────────────────────────────────────────────────────
function useSwipe(onLeft, onRight) {
  const sx = useRef(null);
  const sy = useRef(null);
  function onTouchStart(e) { sx.current = e.touches[0].clientX; sy.current = e.touches[0].clientY; }
  function onTouchEnd(e) {
    if (sx.current === null) return;
    const dx = e.changedTouches[0].clientX - sx.current;
    const dy = e.changedTouches[0].clientY - sy.current;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 60) { dx < 0 ? onLeft?.() : onRight?.(); }
    sx.current = null;
  }
  return { onTouchStart, onTouchEnd };
}

// ── Button ────────────────────────────────────────────────────────────────────
// ── Shareable result card ─────────────────────────────────────────────────────
// Renders a single decision's verdict as a clean, brand-styled, read-only card.
// Used both for the public shared-link view and as the source for the
// downloadable image. Receives ONLY the sanitized share payload (decode output),
// never a full memory entry — so nothing private can render here.
function SharedCard({ payload }) {
  const b = payload?.b ?? 0;
  const col = scoreColor(b);
  return (
    <div style={{
      width: "100%", maxWidth: 540, margin: "0 auto",
      background: "linear-gradient(160deg, #0d0d16 0%, #14101f 100%)",
      border: `1px solid ${PURPLE}40`, borderRadius: 2, padding: "36px 32px",
      boxShadow: `0 30px 90px rgba(0,0,0,0.55), 0 0 60px ${PURPLE}14`
    }}>
      {/* Mark + wordmark */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 28 }}>
        <svg width="22" height="22" viewBox="0 0 32 32" fill="none">
          <path d="M5 8 L16 26 L27 8" stroke={PURPLE_BRIGHT} strokeWidth="3.4" strokeLinecap="square" fill="none" />
          <circle cx="16" cy="15.5" r="2.9" fill={PURPLE_BRIGHT} />
        </svg>
        <span style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 19, color: "#fff", letterSpacing: "0.01em" }}>Vestige</span>
        <span style={{ marginLeft: "auto", fontSize: 10.5, letterSpacing: 1.5, textTransform: "uppercase", color: "#6a6a82" }}>Decision Brittleness</span>
      </div>

      {/* Decision */}
      <p style={{ fontSize: 12, letterSpacing: 1.2, textTransform: "uppercase", color: "#6a6a82", margin: "0 0 8px" }}>The decision</p>
      <p style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 24, lineHeight: 1.3, color: "#fff", margin: "0 0 26px", letterSpacing: "-0.01em" }}>{payload?.d}</p>

      {/* Score */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 26 }}>
        <span style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 64, lineHeight: 1, color: col, fontWeight: 400 }}>{b}</span>
        <div>
          <div style={{ fontSize: 13, color: col, fontWeight: 600, letterSpacing: 0.3 }}>{scoreLabel(b)} brittleness</div>
          <div style={{ fontSize: 11.5, color: "#6a6a82" }}>out of 100</div>
        </div>
      </div>

      {/* Verdict */}
      {payload?.v && (
        <div style={{ borderLeft: `2px solid ${PURPLE}55`, paddingLeft: 14, margin: "0 0 24px" }}>
          <p style={{ fontSize: 14.5, lineHeight: 1.65, color: "#c9c9d6", margin: 0, fontStyle: "italic" }}>{payload.v}</p>
        </div>
      )}

      {/* Failure headlines */}
      {Array.isArray(payload?.f) && payload.f.length > 0 && (
        <div>
          <p style={{ fontSize: 12, letterSpacing: 1.2, textTransform: "uppercase", color: "#6a6a82", margin: "0 0 12px" }}>How it could break</p>
          {payload.f.map((x, i) => (
            <div key={i} style={{ display: "flex", gap: 10, marginBottom: 10, alignItems: "flex-start" }}>
              <span style={{ fontSize: 11, color: PURPLE_BRIGHT, fontWeight: 700, minWidth: 18 }}>{String(i + 1).padStart(2, "0")}</span>
              <div>
                <span style={{ fontSize: 13, color: "#e6e6ee", fontWeight: 600 }}>{x.m}</span>
                {x.r && <span style={{ fontSize: 11.5, color: "#6a6a82", marginLeft: 8 }}>· {x.r}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 28, paddingTop: 16, borderTop: "1px solid #ffffff0d", textAlign: "center" }}>
        <span style={{ fontSize: 11.5, color: "#56566a" }}>Scored by Vestige — decision intelligence</span>
      </div>
    </div>
  );
}

// Public view shown when someone opens a #share= link. No app shell, no memory,
// no auth — just the card and a CTA back to the app.
export function ShareView({ payload }) {
  return (
    <div style={{
      minHeight: "100vh", background: "#08080d",
      padding: "calc(40px + var(--safe-top)) 20px calc(40px + var(--safe-bottom))",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      fontFamily: "'Inter', -apple-system, sans-serif"
    }}>
      <SharedCard payload={payload} />
      <a href={window.location.pathname} style={{
        marginTop: 26, textDecoration: "none",
        background: `linear-gradient(135deg, ${PURPLE}, ${PURPLE_BRIGHT})`,
        color: "#fff", fontSize: 14, fontWeight: 600, padding: "12px 24px", borderRadius: 10
      }}>Analyse your own decision →</a>
      <p style={{ fontSize: 11.5, color: "#56566a", marginTop: 14, textAlign: "center", maxWidth: 320, lineHeight: 1.6 }}>
        Vestige scores how brittle a decision is and argues the case against it. This card was shared with you.
      </p>
    </div>
  );
}

// Render the card to a PNG using NATIVE canvas drawing commands (no SVG
// foreignObject). This is the iOS-compatible path: Safari taints any canvas that
// has had an SVG-with-foreignObject drawn onto it, so toDataURL() throws there.
// Drawing text/shapes directly keeps the canvas clean and exportable on mobile.
async function cardToPng(payload, scale = 3) {
  const W = 600;
  const PAD = 36;
  const CW = W - PAD * 2; // content width

  // Set up a measuring context first so we can compute height before sizing.
  const measure = document.createElement("canvas").getContext("2d");
  const font = (size, weight = 400, italic = false) =>
    `${italic ? "italic " : ""}${weight} ${size}px -apple-system, "Helvetica Neue", Arial, sans-serif`;

  // Word-wrap helper: returns array of lines that fit within maxW at given font.
  function wrap(ctx, text, maxW, fontStr) {
    ctx.font = fontStr;
    const words = String(text || "").split(/\s+/);
    const lines = [];
    let line = "";
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (ctx.measureText(test).width > maxW && line) {
        lines.push(line);
        line = w;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  const col = scoreColor(payload?.b ?? 0);
  const decision = payload?.d || "A decision";
  const verdict = payload?.v || "";
  const failures = Array.isArray(payload?.f) ? payload.f.slice(0, 3) : [];

  // Pre-compute wrapped lines + total height.
  const decLines = wrap(measure, decision, CW, font(23, 400));
  const verdictLines = verdict ? wrap(measure, verdict, CW - 14, font(14.5, 400, true)) : [];
  const failLines = failures.map((x, i) =>
    wrap(measure, `${String(i + 1).padStart(2, "0")}  ${x.m}${x.r ? "  · " + x.r : ""}`, CW - 8, font(13, 600))
  );

  let y = PAD;
  y += 24;                                  // wordmark row
  y += 22;                                  // "THE DECISION" eyebrow
  y += decLines.length * 30 + 18;           // decision
  y += 70 + 18;                             // score block
  if (verdictLines.length) y += verdictLines.length * 23 + 22;
  if (failures.length) { y += 26; failLines.forEach(l => { y += l.length * 19 + 8; }); }
  y += 14 + 22 + PAD;                       // footer
  const H = Math.max(420, Math.round(y));

  // Now the real canvas.
  const canvas = document.createElement("canvas");
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.textBaseline = "alphabetic";

  // Background gradient + border.
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, "#0d0d16");
  grad.addColorStop(1, "#14101f");
  ctx.fillStyle = grad;
  roundRect(ctx, 0, 0, W, H, 20); ctx.fill();
  ctx.strokeStyle = PURPLE + "66"; ctx.lineWidth = 1;
  roundRect(ctx, 0.5, 0.5, W - 1, H - 1, 20); ctx.stroke();

  let cy = PAD;

  // Wordmark row: V mark + "Vestige" + right-aligned eyebrow.
  ctx.fillStyle = PURPLE_BRIGHT;
  ctx.font = font(22, 700);
  ctx.fillText("V", PAD, cy + 18);
  ctx.fillStyle = "#fff";
  ctx.font = font(18, 500);
  ctx.fillText("Vestige", PAD + 22, cy + 18);
  ctx.fillStyle = "#6a6a82";
  ctx.font = font(10, 500);
  ctx.textAlign = "right";
  ctx.fillText("DECISION BRITTLENESS", W - PAD, cy + 16);
  ctx.textAlign = "left";
  cy += 24 + 22;

  // "THE DECISION" eyebrow.
  ctx.fillStyle = "#6a6a82";
  ctx.font = font(11, 500);
  ctx.fillText("THE DECISION", PAD, cy);
  cy += 22;

  // Decision text.
  ctx.fillStyle = "#fff";
  ctx.font = font(23, 400);
  for (const line of decLines) { ctx.fillText(line, PAD, cy + 18); cy += 30; }
  cy += 18;

  // Score: big number + label beside it.
  ctx.fillStyle = col;
  ctx.font = font(60, 400);
  ctx.fillText(String(payload?.b ?? 0), PAD, cy + 52);
  const numW = ctx.measureText(String(payload?.b ?? 0)).width;
  ctx.font = font(13, 600);
  ctx.fillText(`${scoreLabel(payload?.b ?? 0)} brittleness`, PAD + numW + 14, cy + 34);
  ctx.fillStyle = "#6a6a82";
  ctx.font = font(11, 400);
  ctx.fillText("out of 100", PAD + numW + 14, cy + 50);
  cy += 70 + 18;

  // Verdict (italic, left rule).
  if (verdictLines.length) {
    ctx.fillStyle = PURPLE + "88";
    ctx.fillRect(PAD, cy - 2, 2, verdictLines.length * 23);
    ctx.fillStyle = "#c9c9d6";
    ctx.font = font(14.5, 400, true);
    for (const line of verdictLines) { ctx.fillText(line, PAD + 14, cy + 14); cy += 23; }
    cy += 22;
  }

  // Failures.
  if (failures.length) {
    ctx.fillStyle = "#6a6a82";
    ctx.font = font(11, 500);
    ctx.fillText("HOW IT COULD BREAK", PAD, cy);
    cy += 26;
    failLines.forEach((lines) => {
      ctx.fillStyle = "#e6e6ee";
      ctx.font = font(13, 600);
      for (const line of lines) { ctx.fillText(line, PAD, cy + 13); cy += 19; }
      cy += 8;
    });
  }

  // Footer.
  cy = H - PAD - 8;
  ctx.strokeStyle = "#ffffff14"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PAD, cy - 14); ctx.lineTo(W - PAD, cy - 14); ctx.stroke();
  ctx.fillStyle = "#56566a";
  ctx.font = font(11, 400);
  ctx.textAlign = "center";
  ctx.fillText("Scored by Vestige — decision intelligence", W / 2, cy + 4);
  ctx.textAlign = "left";

  return canvas.toDataURL("image/png");
}

// Rounded-rectangle path helper (canvas has no native one in older Safari).
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}


function Btn({ children, onClick, variant = "secondary", disabled, style: extra }) {
  const [pressed, setPressed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const base = {
    fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
    fontSize: 11, fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase",
    padding: "12px 20px", borderRadius: 2, cursor: disabled ? "not-allowed" : "pointer",
    border: "1px solid transparent", transition: "all 0.15s", WebkitTapHighlightColor: "transparent",
    userSelect: "none", opacity: disabled ? 0.35 : pressed ? 0.75 : 1,
    transform: pressed ? "scale(0.97)" : "scale(1)", ...extra
  };
  const v = {
    primary:   { ...base, background: hovered ? `${PURPLE}26` : `${PURPLE}1a`, border: `1px solid ${hovered ? PURPLE : PURPLE + "88"}`, color: hovered ? "#fff" : "#d6cdf0" },
    secondary: { ...base, background: "transparent", border: `1px solid ${hovered ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.12)"}`, color: hovered ? "#bcbccc" : "#7a7a8c" },
    ghost:     { ...base, background: "none", border: "1px solid transparent", color: hovered ? "#9a9aac" : "#5a5a6a" },
    danger:    { ...base, background: hovered ? "rgba(239,83,80,0.08)" : "transparent", border: `1px solid ${hovered ? "#7a2a2a" : "#3a1a1a"}`, color: hovered ? "#d66" : "#6a3a3a" },
  };
  return (
    <button className={(variant === "primary" || variant === "secondary") ? "v-reticle" : undefined} style={v[variant]} onClick={onClick} disabled={disabled}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => { setHovered(false); setPressed(false); }}
      onPointerDown={() => setPressed(true)} onPointerUp={() => setPressed(false)}
    >{children}</button>
  );
}

// ── Shared input ──────────────────────────────────────────────────────────────
function DecisionInput({ value, onChange, onSubmit, autoFocus, placeholder, rows = 3 }) {
  const ref  = useRef(null);
  const [focused, setFocused] = useState(false);
  const chars = value.length;
  const near  = chars > MAX_CHARS * 0.8;
  const full  = chars >= MAX_CHARS;
  useEffect(() => { if (autoFocus) setTimeout(() => ref.current?.focus(), 80); }, [autoFocus]);
  return (
    <div style={{
      background: "linear-gradient(135deg, rgba(15,15,24,0.95), rgba(20,16,32,0.95))",
      border: `1px solid ${focused ? "rgba(124,92,191,0.4)" : "rgba(255,255,255,0.08)"}`,
      borderRadius: 2,
      padding: "20px 20px 16px",
      boxShadow: focused
        ? `0 0 0 4px rgba(124,92,191,0.08), 0 24px 64px rgba(0,0,0,0.5), 0 0 60px ${PURPLE}22`
        : "0 0 0 1px rgba(255,255,255,0.02), 0 24px 64px rgba(0,0,0,0.5)",
      transition: "all 0.3s ease"
    }}>
      <textarea
        ref={ref} rows={rows}
        placeholder={placeholder || "Describe the decision you're sitting with..."}
        value={value} maxLength={MAX_CHARS}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSubmit(); }}
        style={{ width: "100%", background: "transparent", border: "none", color: "#ddd", fontSize: 16, lineHeight: 1.75, resize: "none", fontFamily: "inherit", fontWeight: 400 }}
      />
      <div style={{ height: 1, background: `linear-gradient(90deg, transparent, ${focused ? PURPLE + "44" : "rgba(255,255,255,0.08)"}, transparent)`, margin: "12px 0", transition: "all 0.3s" }} />
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 12 }}>
        {near && <span style={{ fontSize: 11, color: full ? "#ef4444" : "#666", fontWeight: 500 }}>{MAX_CHARS - chars} left</span>}
        <button onClick={onSubmit} disabled={!value.trim()} style={{
          background: value.trim() ? `${PURPLE}1a` : "transparent",
          border: value.trim() ? `1px solid ${PURPLE}` : "1px solid rgba(255,255,255,0.08)",
          color: value.trim() ? "#fff" : "#333",
          fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
          fontSize: 12, fontWeight: 500, letterSpacing: "0.16em", textTransform: "uppercase",
          padding: "12px 24px", borderRadius: 2,
          cursor: value.trim() ? "pointer" : "not-allowed",
          WebkitTapHighlightColor: "transparent", minHeight: 46,
          transition: "all 0.2s",
          display: "flex", alignItems: "center", gap: 8
        }}
        onMouseEnter={e => { if (value.trim()) { e.currentTarget.style.background = `${PURPLE}2e`; }}}
        onMouseLeave={e => { if (value.trim()) { e.currentTarget.style.background = `${PURPLE}1a`; }}}
        >
          Analyse
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
        </button>
      </div>
    </div>
  );
}

// ── Failure card with scenario simulation ─────────────────────────────────────
function FailureCard({ f, i, analysisContext }) {
  const [open, setOpen]           = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [simulation, setSimulation] = useState(null);
  const sc  = Math.round(f.likelihood * 0.5 + f.impact * 0.5);
  const col = scoreColor(sc);

  async function runSimulation(e) {
    e.stopPropagation();
    setSimulating(true);
    setSimulation(null);
    try {
      const res = await fetch("/api/analyse", {
        method: "POST",
        headers: await authedHeaders(),
        body: JSON.stringify({
          decision: `SCENARIO SIMULATION REQUEST. 
Original decision: ${analysisContext?.decision}
Failure mode triggered: ${f.failure_mode}
Role: ${f.role}
Trigger condition: ${f.trigger}

Simulate what happens when this failure materialises. Walk through:
1. What breaks first (within 30 days)
2. The cascade (30-90 days)  
3. Where it stabilises or collapses
4. One concrete recovery action

Keep it under 120 words. Direct, no hedging. Plain sentences.
Return as plain text, NOT JSON.`
        })
      });
      const data = await res.json();
      const text = data.verdict || data.anatomy?.decision || (data.content?.[0]?.text) || "Simulation unavailable.";
      setSimulation(text);
    } catch { setSimulation("Simulation failed - try again."); }
    setSimulating(false);
  }

  const MONO = "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace";
  return (
    <div onClick={() => setOpen(o => !o)} style={{
      background: "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)",
      border: "1px solid rgba(255,255,255,0.06)",
      borderRadius: 2, padding: 0,
      display: "grid", gridTemplateColumns: "54px 1fr",
      animation: "fadeUp 0.4s ease both", animationDelay: `${i * 0.1}s`,
      cursor: "pointer", WebkitTapHighlightColor: "transparent", transition: "border-color 0.25s"
    }}
    onMouseEnter={e => { e.currentTarget.style.borderColor = col + "55"; }}
    onMouseLeave={e => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.06)"; }}
    >
      <div style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: PURPLE_BRIGHT,
        textAlign: "center", paddingTop: 18, borderRight: "1px solid rgba(255,255,255,0.06)" }}>
        {String(i + 1).padStart(2, "0")}
      </div>
      <div style={{ padding: "16px 18px 16px 16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: MONO, fontSize: 9, color: "#4a4a5a", letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 7 }}>
              {(roleLabels[f.role] || f.role).toUpperCase()}
            </div>
            <div style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 18, lineHeight: 1.25, color: "#e6e6ee" }}>{f.failure_mode}</div>
          </div>
          <span style={{ fontFamily: MONO, fontSize: 11, color: "#3a3a4a", display: "inline-block", transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s", flexShrink: 0, paddingTop: 4 }}>v</span>
        </div>
        <div style={{ display: "flex", gap: 18, marginTop: 11, fontFamily: MONO, fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: "#7a7a8c" }}>
          <span>Likelihood <b style={{ color: "#bcbccc", fontWeight: 500 }}>{f.likelihood}</b>
            <span style={{ height: 3, width: 46, background: "rgba(255,255,255,0.10)", display: "inline-block", verticalAlign: "middle", marginLeft: 7, position: "relative", borderRadius: 2 }}>
              <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${f.likelihood}%`, background: col, borderRadius: 2 }} />
            </span>
          </span>
          <span>Impact <b style={{ color: "#bcbccc", fontWeight: 500 }}>{f.impact}</b>
            <span style={{ height: 3, width: 46, background: "rgba(255,255,255,0.10)", display: "inline-block", verticalAlign: "middle", marginLeft: 7, position: "relative", borderRadius: 2 }}>
              <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${f.impact}%`, background: col, borderRadius: 2 }} />
            </span>
          </span>
        </div>

      {open && (
        <div style={{ marginTop: 14, animation: "fadeUp 0.2s ease" }} onClick={e => e.stopPropagation()}>
          <p style={{ fontSize: 13, color: "#444", lineHeight: 1.75, margin: "0 0 10px" }}>{f.argument}</p>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 12 }}>
            <span style={{ fontSize: 9, color: "#1e1e2e", letterSpacing: 3, fontWeight: 600, paddingTop: 2, flexShrink: 0 }}>TRIGGER</span>
            <span style={{ fontSize: 12, color: "#2a2a3a", lineHeight: 1.5 }}>{f.trigger}</span>
          </div>
          {f.addressed_by && (
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 16, padding: "8px 12px", background: "rgba(34,197,94,0.06)", borderRadius: 8, border: "1px solid rgba(34,197,94,0.15)" }}>
              <span style={{ fontSize: 9, color: "#22c55e", letterSpacing: 3, fontWeight: 600, paddingTop: 2, flexShrink: 0, opacity: 0.8 }}>MITIGATED BY</span>
              <span style={{ fontSize: 12, color: "#7a9a82", lineHeight: 1.5 }}>{f.addressed_by}</span>
            </div>
          )}
          {!f.addressed_by && <div style={{ marginBottom: 16 }} />}

          {/* Scenario simulation */}
          {!simulation && !simulating && (
            <button onClick={runSimulation} style={{
              background: "transparent", border: `1px solid ${col}33`,
              color: col, fontSize: 11, fontWeight: 600, padding: "8px 14px",
              borderRadius: 6, cursor: "pointer", fontFamily: "inherit",
              WebkitTapHighlightColor: "transparent", letterSpacing: "0.05em",
              transition: "all 0.2s"
            }}
            onMouseEnter={e => { e.target.style.background = col + "11"; }}
            onMouseLeave={e => { e.target.style.background = "transparent"; }}
            >Simulate this failure</button>
          )}

          {simulating && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0" }}>
              <div style={{ width: 14, height: 14, borderRadius: "50%", border: `1.5px solid ${col}33`, borderTopColor: col, animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: "#333", fontStyle: "italic" }}>Running simulation...</span>
            </div>
          )}

          {simulation && (
            <div style={{ background: "#080810", border: `1px solid ${col}22`, borderRadius: 10, padding: "16px", marginTop: 4 }}>
              <div style={{ fontSize: 9, color: col, letterSpacing: 3, fontWeight: 600, marginBottom: 10, opacity: 0.7 }}>SIMULATION</div>
              <p style={{ fontSize: 13, color: "#555", lineHeight: 1.8, margin: "0 0 12px" }}>{simulation}</p>
              <button onClick={e => { e.stopPropagation(); setSimulation(null); }} style={{ background: "none", border: "none", fontSize: 11, color: "#2a2a3a", cursor: "pointer", fontFamily: "inherit", padding: 0 }}>clear</button>
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
}

// ── Score readout — forensic instrument gauge ──────────────────────────────────
function ScoreBar({ brittleness, animate }) {
  const col = scoreColor(brittleness);
  const MONO = "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace";
  const ticks = Array.from({ length: 17 });
  return (
    <div style={{
      position: "relative",
      border: "1px solid rgba(255,255,255,0.10)",
      borderRadius: 2,
      padding: "26px 24px 22px",
      marginBottom: 16,
      background: "linear-gradient(180deg, rgba(255,255,255,0.015), transparent)",
      overflow: "hidden"
    }}>
      {animate && <span className="v-readout-scan" />}
      {/* corner brackets, tinted by score */}
      {["tl","tr","bl","br"].map(c => (
        <span key={c} style={{
          position: "absolute", width: 9, height: 9, pointerEvents: "none",
          borderColor: animate ? col : "#2a2a38", transition: "border-color 1s ease",
          ...(c === "tl" && { top: -1, left: -1, borderTop: "1px solid", borderLeft: "1px solid" }),
          ...(c === "tr" && { top: -1, right: -1, borderTop: "1px solid", borderRight: "1px solid" }),
          ...(c === "bl" && { bottom: -1, left: -1, borderBottom: "1px solid", borderLeft: "1px solid" }),
          ...(c === "br" && { bottom: -1, right: -1, borderBottom: "1px solid", borderRight: "1px solid" })
        }} />
      ))}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start",
        fontFamily: MONO, fontSize: 9.5, letterSpacing: "0.2em", textTransform: "uppercase", color: "#7a7a8c" }}>
        <span>Structural Brittleness</span>
      </div>

      <div style={{ display: "flex", alignItems: "flex-end", gap: 16, marginTop: 8 }}>
        <span style={{
          fontFamily: MONO, fontWeight: 700, fontSize: 84, lineHeight: 0.82,
          color: animate ? col : "#1a1a28", letterSpacing: "-0.04em",
          transition: "color 1s ease",
          animation: animate ? "countUp 0.6s ease" : "none",
          textShadow: animate ? `0 0 40px ${col}44` : "none"
        }}>{brittleness}</span>
        <div style={{ paddingBottom: 8 }}>
          <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, letterSpacing: "0.15em",
            textTransform: "uppercase", color: animate ? col : "#2a2a38", transition: "color 1s ease" }}>
            {scoreLabel(brittleness)}
          </div>
          <div style={{ fontFamily: MONO, fontSize: 10, color: "#7a7a8c", letterSpacing: "0.1em", marginTop: 3 }}>
            / 100
          </div>
        </div>
      </div>

      {/* tick scale with needle */}
      <div style={{ marginTop: 20, height: 26, position: "relative" }}>
        <div style={{ display: "flex", justifyContent: "space-between", position: "absolute", inset: 0, alignItems: "flex-end" }}>
          {ticks.map((_, i) => (
            <span key={i} style={{ width: 1, background: i % 4 === 0 ? "#4a4a5a" : "rgba(255,255,255,0.10)", height: i % 4 === 0 ? 14 : 8 }} />
          ))}
        </div>
        <div style={{
          position: "absolute", bottom: 0, width: 2, height: 26,
          left: animate ? `${brittleness}%` : "0%",
          background: col, boxShadow: `0 0 10px ${col}`,
          transition: "left 2s cubic-bezier(0.16,1,0.3,1)"
        }}>
          <span style={{ position: "absolute", top: -4, left: -3, width: 8, height: 8, borderRadius: "50%", background: col }} />
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontFamily: MONO, fontSize: 8.5, color: "#4a4a5a", letterSpacing: "0.1em", marginTop: 5 }}>
        <span>0 STABLE</span><span>50 ELEVATED</span><span>100 CRITICAL</span>
      </div>
    </div>
  );
}

// ── Stakes calibration — surfaces the worst case before analysis ───────────────
function StakesCalibration({ onContinue, onSkip }) {
  const [downside, setDownside]       = useState("");
  const [upside, setUpside]           = useState("");
  const [reversibility, setReversibility] = useState(null);

  const ready = downside.trim() && upside.trim() && reversibility !== null;

  return (
    <div style={{
      background: "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)",
      backdropFilter: "blur(20px)",
      border: `1px solid ${CYAN}33`,
      borderRadius: 2, padding: "24px 22px", marginBottom: 24
    }}>
      <div style={{ fontSize: 10, color: CYAN, letterSpacing: 4, fontWeight: 600, marginBottom: 4, opacity: 0.85 }}>STAKES CALIBRATION</div>
      <p style={{ fontSize: 12, color: "#444", marginBottom: 20, lineHeight: 1.55 }}>Before Vestige runs, answer these three. Often the decision resolves itself here.</p>

      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 10, color: "#888", letterSpacing: 2, fontWeight: 600, marginBottom: 8 }}>WORST-CASE DOWNSIDE IF THIS FAILS</div>
        <textarea
          value={downside} onChange={e => setDownside(e.target.value)}
          placeholder="What is the realistic worst outcome?"
          rows={2}
          style={{
            width: "100%", background: "rgba(0,0,0,0.25)",
            border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10,
            padding: "10px 12px", color: "#ccc", fontSize: 13, lineHeight: 1.6,
            resize: "none", fontFamily: "inherit"
          }}
        />
      </div>

      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 10, color: "#888", letterSpacing: 2, fontWeight: 600, marginBottom: 8 }}>BEST-CASE UPSIDE IF IT WORKS</div>
        <textarea
          value={upside} onChange={e => setUpside(e.target.value)}
          placeholder="What is the realistic best outcome?"
          rows={2}
          style={{
            width: "100%", background: "rgba(0,0,0,0.25)",
            border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10,
            padding: "10px 12px", color: "#ccc", fontSize: 13, lineHeight: 1.6,
            resize: "none", fontFamily: "inherit"
          }}
        />
      </div>

      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 10, color: "#888", letterSpacing: 2, fontWeight: 600, marginBottom: 8 }}>HOW REVERSIBLE</div>
        <div style={{ display: "flex", gap: 6 }}>
          {[
            { v: "reversible", l: "Reversible" },
            { v: "partial",    l: "Partial" },
            { v: "irreversible", l: "Irreversible" }
          ].map(o => (
            <button key={o.v} onClick={() => setReversibility(o.v)} style={{
              flex: 1, background: reversibility === o.v ? `${CYAN}22` : "transparent",
              border: `1px solid ${reversibility === o.v ? CYAN + "55" : "rgba(255,255,255,0.08)"}`,
              color: reversibility === o.v ? "#fff" : "#666",
              fontSize: 12, padding: "9px 10px", borderRadius: 8,
              cursor: "pointer", fontFamily: "inherit",
              WebkitTapHighlightColor: "transparent", transition: "all 0.2s"
            }}>{o.l}</button>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Btn variant="ghost" onClick={onSkip}>Skip</Btn>
        <Btn variant="primary" onClick={() => onContinue({ downside, upside, reversibility })} disabled={!ready}>Continue to analysis</Btn>
      </div>
    </div>
  );
}

// ── Thread analysis — analyse the conversation itself ────────────────────────
function ThreadAnalysisCard({ analysis, onRefresh, loading }) {
  if (loading) {
    return (
      <div style={{
        background: "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)",
        backdropFilter: "blur(20px)",
        border: `1px solid ${CYAN}22`,
        borderRadius: 2, padding: "40px 22px", marginBottom: 12,
        display: "flex", flexDirection: "column", alignItems: "center", gap: 16
      }}>
        <div style={{ width: 28, height: 28, borderRadius: "50%", border: `2px solid ${CYAN}22`, borderTopColor: CYAN, animation: "spin 0.9s linear infinite" }} />
        <p style={{ fontSize: 12, color: "#444", fontStyle: "italic" }}>Reading the conversation...</p>
      </div>
    );
  }
  if (!analysis) return null;

  const convergenceColor = {
    converging: "#22c55e",
    stuck:      "#f97316",
    diverging:  "#ef4444"
  }[analysis.convergence?.status] || "#666";

  const shiftIcons = {
    score_shift:       "↕",
    reframe:           "↺",
    new_consideration: "+",
    risk_resolved:     "✓"
  };

  return (
    <div style={{
      background: "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)",
      backdropFilter: "blur(20px)",
      border: `1px solid ${CYAN}33`,
      borderRadius: 2, padding: "24px 22px", marginBottom: 12
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ fontSize: 10, color: CYAN, letterSpacing: 4, fontWeight: 600, opacity: 0.85 }}>THREAD ANALYSIS</div>
        <button onClick={onRefresh} style={{
          background: "none", border: "none", color: "#444", fontSize: 11,
          cursor: "pointer", fontFamily: "inherit", padding: 0
        }}>re-analyse</button>
      </div>

      {/* Signature */}
      {analysis.thread_signature && (
        <p style={{
          fontFamily: "'Instrument Serif', Georgia, serif",
          fontSize: 16, color: "#aaa", lineHeight: 1.7, margin: "0 0 20px",
          fontStyle: "italic", fontWeight: 400
        }}>{analysis.thread_signature}</p>
      )}

      {/* Convergence indicator */}
      {analysis.convergence && (
        <div style={{
          display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
          background: `${convergenceColor}0a`, border: `1px solid ${convergenceColor}33`,
          borderRadius: 10, marginBottom: 20
        }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: convergenceColor, boxShadow: `0 0 6px ${convergenceColor}` }} />
          <span style={{ fontSize: 11, color: convergenceColor, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase" }}>
            {analysis.convergence.status}
          </span>
          <span style={{ fontSize: 12, color: "#777", lineHeight: 1.5, flex: 1 }}>{analysis.convergence.explanation}</span>
        </div>
      )}

      {/* Shifts */}
      {analysis.shifts && analysis.shifts.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 9, color: PURPLE_BRIGHT, letterSpacing: 3, fontWeight: 600, marginBottom: 10, opacity: 0.7 }}>WHERE THINKING SHIFTED</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {analysis.shifts.map((s, i) => {
              const magColor = s.magnitude === "high" ? "#ef4444" : s.magnitude === "medium" ? "#f97316" : PURPLE_BRIGHT;
              return (
                <div key={i} style={{
                  display: "flex", gap: 12, padding: "10px 14px",
                  background: "rgba(0,0,0,0.2)", borderRadius: 10,
                  borderLeft: `2px solid ${magColor}66`
                }}>
                  <span style={{ fontSize: 14, color: magColor, fontWeight: 700, lineHeight: 1.5, flexShrink: 0, width: 16, textAlign: "center" }}>
                    {shiftIcons[s.type] || "•"}
                  </span>
                  <p style={{ fontSize: 12.5, color: "#888", lineHeight: 1.6, margin: 0 }}>{s.description}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Unresolved */}
      {analysis.unresolved && analysis.unresolved.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 9, color: "#f97316", letterSpacing: 3, fontWeight: 600, marginBottom: 10, opacity: 0.8 }}>STILL UNRESOLVED</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {analysis.unresolved.map((item, i) => (
              <div key={i} style={{
                display: "flex", gap: 10, padding: "8px 14px",
                background: "rgba(249,115,22,0.05)", borderRadius: 8,
                border: "1px solid rgba(249,115,22,0.12)"
              }}>
                <span style={{ fontSize: 11, color: "#f97316", flexShrink: 0, opacity: 0.7 }}>○</span>
                <p style={{ fontSize: 12.5, color: "#888", lineHeight: 1.6, margin: 0 }}>{item}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Blind spots */}
      {analysis.blind_spots && analysis.blind_spots.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 9, color: "#ef4444", letterSpacing: 3, fontWeight: 600, marginBottom: 10, opacity: 0.8 }}>NOT ASKED, BUT SHOULD BE</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {analysis.blind_spots.map((item, i) => (
              <div key={i} style={{
                display: "flex", gap: 10, padding: "10px 14px",
                background: "rgba(239,68,68,0.05)", borderRadius: 8,
                border: "1px solid rgba(239,68,68,0.15)"
              }}>
                <span style={{ fontSize: 14, color: "#ef4444", flexShrink: 0, opacity: 0.7, lineHeight: 1.2 }}>!</span>
                <p style={{ fontSize: 12.5, color: "#aaa", lineHeight: 1.6, margin: 0 }}>{item}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Next question */}
      {analysis.next_question && (
        <div style={{
          background: `linear-gradient(135deg, ${PURPLE}11, ${CYAN}08)`,
          border: `1px solid ${PURPLE}33`,
          borderRadius: 2, padding: "16px 18px"
        }}>
          <div style={{ fontSize: 9, color: PURPLE_BRIGHT, letterSpacing: 3, fontWeight: 600, marginBottom: 8, opacity: 0.8 }}>ASK THIS NEXT</div>
          <p style={{
            fontFamily: "'Instrument Serif', Georgia, serif",
            fontSize: 15, color: "#bbb", lineHeight: 1.6, margin: 0,
            fontStyle: "italic", fontWeight: 400
          }}>"{analysis.next_question}"</p>
        </div>
      )}
    </div>
  );
}

// ── Lens selector modal ────────────────────────────────────────────────────
function LensSelectorModal({ lenses, entry, onApply, onClose }) {
  const [loadingLensId, setLoadingLensId] = useState(null);

  async function handleApply(lens) {
    setLoadingLensId(lens.id);
    await onApply(lens, entry);
    setLoadingLensId(null);
    onClose();
  }

  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
      background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 1000, padding: 20
    }}
    onClick={onClose}
    >
      <div style={{
        background: "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)",
        backdropFilter: "blur(20px)",
        border: `1px solid ${PURPLE}33`,
        borderRadius: 2, padding: "24px 22px",
        maxWidth: 500, maxHeight: "80vh", overflowY: "auto",
        animation: "fadeUp 0.2s ease"
      }}
      onClick={e => e.stopPropagation()}
      >
        <h3 style={{ fontSize: 16, color: "#bbb", marginBottom: 20, fontWeight: 600 }}>Apply a lens</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {lenses.map(lens => (
            <button
              key={lens.id}
              onClick={() => handleApply(lens)}
              disabled={loadingLensId === lens.id}
              style={{
                background: "transparent", border: `1px solid ${PURPLE}44`,
                color: "#bbb", padding: "14px 16px", borderRadius: 10,
                cursor: loadingLensId === lens.id ? "wait" : "pointer",
                fontFamily: "inherit", fontSize: 12, fontWeight: 500,
                textAlign: "left", transition: "all 0.2s",
                opacity: loadingLensId === lens.id ? 0.6 : 1
              }}
              onMouseEnter={e => {
                if (loadingLensId !== lens.id) {
                  e.currentTarget.style.borderColor = `${PURPLE}88`;
                  e.currentTarget.style.background = `${PURPLE}11`;
                }
              }}
              onMouseLeave={e => {
                if (loadingLensId !== lens.id) {
                  e.currentTarget.style.borderColor = `${PURPLE}44`;
                  e.currentTarget.style.background = "transparent";
                }
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <span style={{ fontWeight: 600 }}>{lens.name}</span>
                {loadingLensId === lens.id && (
                  <span style={{ fontSize: 10, color: PURPLE_BRIGHT }}>Analysing...</span>
                )}
              </div>
              <div style={{ fontSize: 11, color: "#666", lineHeight: 1.5 }}>
                {lens.prompt.slice(0, 70)}{lens.prompt.length > 70 ? "..." : ""}
              </div>
            </button>
          ))}
        </div>
        <button
          onClick={onClose}
          style={{
            marginTop: 20, width: "100%",
            background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
            color: "#666", padding: "12px", borderRadius: 10,
            cursor: "pointer", fontFamily: "inherit", fontSize: 12
          }}
        >
          Close
        </button>
      </div>
    </div>
  );
}

// ── Insight card — displays a single emergent insight ──────────────────────
function InsightCard({ insight, index }) {
  return (
    <div style={{
      background: "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)",
      backdropFilter: "blur(20px)",
      border: `1px solid ${PURPLE}33`,
      borderLeft: `3px solid ${PURPLE}88`,
      borderRadius: 2, padding: "24px 22px", marginBottom: 12
    }}>
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", marginBottom: 14 }}>
        <div style={{
          width: 36, height: 36, borderRadius: "50%",
          background: `${PURPLE}22`, border: `1px solid ${PURPLE}55`,
          display: "flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0, fontSize: 16, fontWeight: 700, color: PURPLE_BRIGHT
        }}>
          {index + 1}
        </div>
        <h3 style={{
          fontSize: 18, fontWeight: 600, color: "#bbb", margin: 0,
          lineHeight: 1.5, flex: 1
        }}>
          {insight.headline}
        </h3>
      </div>

      <div style={{ marginBottom: 14, paddingLeft: 52 }}>
        <p style={{
          fontSize: 13, color: "#888", lineHeight: 1.7, margin: 0,
          fontStyle: "italic"
        }}>
          {insight.details}
        </p>
      </div>

      <div style={{
        background: `${CYAN}08`,
        border: `1px solid ${CYAN}22`,
        borderRadius: 10, padding: "14px 16px",
        marginLeft: 52
      }}>
        <div style={{
          fontSize: 9, color: CYAN, letterSpacing: 2, fontWeight: 600,
          marginBottom: 6, opacity: 0.85
        }}>RECOMMENDED ACTION</div>
        <p style={{
          fontSize: 13, color: "#aaa", lineHeight: 1.6, margin: 0
        }}>
          {insight.recommendation}
        </p>
      </div>
    </div>
  );
}

// ── Lens card — displays a saved analytical lens ────────────────────────────
function LensCard({ lens, onApply, onDelete, applied }) {
  return (
    <div style={{
      background: "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)",
      border: `1px solid ${applied ? CYAN + "66" : "rgba(255,255,255,0.08)"}`,
      borderRadius: 2, padding: "18px 20px", marginBottom: 10,
      transition: "all 0.2s",
      cursor: "pointer"
    }}
    onMouseEnter={e => {
      if (!applied) e.currentTarget.style.borderColor = "rgba(255,255,255,0.15)";
    }}
    onMouseLeave={e => {
      if (!applied) e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)";
    }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 8 }}>
        <h4 style={{ fontSize: 14, fontWeight: 600, color: "#bbb", margin: 0, flex: 1 }}>{lens.name}</h4>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          {applied && (
            <span style={{ fontSize: 9, color: CYAN, letterSpacing: 1.5, fontWeight: 700, padding: "3px 8px", background: `${CYAN}11`, borderRadius: 4 }}>APPLIED</span>
          )}
          {lens.usageCount > 0 && (
            <span style={{ fontSize: 10, color: "#444", opacity: 0.7 }}>×{lens.usageCount}</span>
          )}
        </div>
      </div>
      <p style={{ fontSize: 12, color: "#666", lineHeight: 1.6, margin: "0 0 10px", fontStyle: "italic" }}>
        {lens.prompt.slice(0, 80)}{lens.prompt.length > 80 ? "..." : ""}
      </p>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        {onApply && (
          <button onClick={() => onApply(lens)} style={{
            background: "none", border: "none", color: CYAN, fontSize: 11,
            cursor: "pointer", fontFamily: "inherit", fontWeight: 600,
            padding: 0, letterSpacing: 1
          }}>Apply</button>
        )}
        {onDelete && (
          <button onClick={() => onDelete(lens.id)} style={{
            background: "none", border: "none", color: "#444", fontSize: 11,
            cursor: "pointer", fontFamily: "inherit", padding: 0
          }}>Delete</button>
        )}
      </div>
    </div>
  );
}

// ── Anatomy card ──────────────────────────────────────────────────────────────
function AnatomyCard({ anatomy }) {
  if (!anatomy) return null;
  const rows = [
    ["Summary",        anatomy?.decision],
    ["Category",       anatomy?.decision_type],
    ["Stakes",         anatomy?.stakes],
    ["Reversibility",  anatomy?.reversibility],
    ["Strengths",      Array.isArray(anatomy?.strengths) && anatomy.strengths.length ? anatomy.strengths.join(" · ") : null],
    ["Assumptions",    Array.isArray(anatomy?.assumptions) ? anatomy.assumptions.join(" · ") : anatomy?.assumptions],
    ["Unknowns",       Array.isArray(anatomy?.unknowns)    ? anatomy.unknowns.join(" · ")    : anatomy?.unknowns],
  ].filter(([, v]) => v);
  const MONO = "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace";
  return (
    <div style={{
      border: "1px solid rgba(255,255,255,0.08)",
      borderRadius: 2, padding: "24px 22px", marginBottom: 16,
      background: "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)"
    }}>
      <div style={{ fontFamily: MONO, fontSize: 9.5, color: "#7a7a8c", letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 20, paddingBottom: 12, borderBottom: "1px solid rgba(255,255,255,0.06)" }}>Decision Dossier</div>
      {rows.map(([label, value]) => {
        const isStrength = label === "Strengths";
        return (
          <div key={label} style={{ display: "flex", gap: 14, marginBottom: 13, flexWrap: "wrap" }}>
            <span style={{ fontFamily: MONO, fontSize: 9, color: isStrength ? "#5fcf80" : "#4a4a5a", fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase", minWidth: 96, paddingTop: 3, flexShrink: 0 }}>{label}</span>
            <span style={{ fontSize: 14.5, fontFamily: "'Instrument Serif', Georgia, serif", color: isStrength ? "#8fbf99" : "#cacad6", lineHeight: 1.45, flex: 1, minWidth: 180, wordBreak: "break-word" }}>{value}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Signals card — observable thresholds that would prove the risk ─────────────
function SignalsCard({ signals }) {
  if (!signals || !signals.length) return null;
  const MONO = "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace";
  return (
    <div style={{
      border: "1px solid rgba(255,255,255,0.08)",
      borderRadius: 2,
      padding: "22px 20px",
      marginBottom: 12,
      background: "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)"
    }}>
      <div style={{ fontFamily: MONO, fontSize: 9.5, color: PURPLE_BRIGHT, letterSpacing: "0.22em", textTransform: "uppercase", marginBottom: 8 }}>What Would Change Your Mind</div>
      <p style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 16, color: "#9a9aac", marginBottom: 18, lineHeight: 1.45 }}>Watch for these. If any cross their threshold, the analysis no longer holds.</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
        {signals.map((s, i) => (
          <div key={i} style={{
            borderTop: "1px solid rgba(255,255,255,0.06)",
            padding: "14px 0",
            display: "flex", gap: 14, alignItems: "flex-start"
          }}>
            <div style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: PURPLE_BRIGHT, paddingTop: 1, minWidth: 22 }}>{String(i + 1).padStart(2, "0")}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 17, color: "#e0e0e8", marginBottom: 5 }}>{s.metric}</div>
              <div style={{ fontFamily: MONO, fontSize: 10.5, color: "#8a8a9a", letterSpacing: "0.04em", lineHeight: 1.5 }}>
                <span style={{ color: PURPLE_BRIGHT }}>THRESHOLD </span>{s.threshold}
              </div>
              {s.watches && (
                <div style={{ fontFamily: MONO, fontSize: 9, color: "#4a4a5a", marginTop: 5, letterSpacing: "0.12em", textTransform: "uppercase" }}>
                  Tied to {s.watches}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Post-mortem — calibrate Vestige to your real outcomes ─────────────────────
// ── Hindsight gap ─────────────────────────────────────────────────────────────
// Human memory rewrites itself after an outcome is known (hindsight bias). Vestige
// holds the uncorrupted T1 prediction; at post-mortem it asks you to recall what
// it predicted BEFORE revealing the truth, then measures the drift. Over time it
// learns how YOUR memory distorts — a measurement no prompt could produce, because
// producing it needs the past prediction you no longer have honest access to.
const HINDSIGHT_MIN_AGE_DAYS = 10; // below this, memory hasn't meaningfully drifted

function decisionAgeDays(entry, now = Date.now()) {
  const t = new Date(entry?.commitment?.committedAt || entry?.timestamp || now).getTime();
  return Math.max(0, (now - t) / 86400000);
}

// Honest interpretation of the gap. Small gaps are praised as accurate memory,
// not stretched into false insight.
function interpretHindsightGap(recalled, actual, outcome) {
  if (recalled == null || actual == null) return null;
  const gap = recalled - actual;          // + = remembered as riskier than it was
  const mag = Math.abs(gap);
  if (mag < 8) {
    return { gap, direction: "accurate", text: `Your memory held up — you recalled ${recalled}, it was ${actual}. Close.` };
  }
  if (gap > 0) {
    // Remembered as riskier than it was — classic after a bad outcome ("I knew it was shaky").
    const tail = outcome && (outcome === "proceeded_bad")
      ? " After it went badly, hindsight has made the warning feel louder than it was."
      : " Hindsight has rewritten this as more obviously risky than it looked at the time.";
    return { gap, direction: "inflated", text: `You remembered Vestige rating this ${recalled}. It actually said ${actual} — ${mag} points lower.${tail}` };
  }
  // Remembered as safer than it was — common after a good outcome ("I was always confident").
  const tail = outcome && (outcome === "proceeded_good")
    ? " It worked out, and memory has smoothed over how risky it actually looked."
    : " You remember being calmer about this than Vestige actually was.";
  return { gap, direction: "deflated", text: `You remembered Vestige rating this ${recalled}. It actually said ${actual} — ${mag} points higher.${tail}` };
}

// Aggregate across post-mortems that captured a recollection. Needs >=3 to speak.
function computeHindsightProfile(memory) {
  const samples = memory
    .map(e => e.postMortem)
    .filter(pm => pm && typeof pm.recalledBrittleness === "number" && typeof pm.hindsightGap === "number");
  if (samples.length < 3) return null;
  const avg = samples.reduce((s, pm) => s + pm.hindsightGap, 0) / samples.length;
  const absAvg = samples.reduce((s, pm) => s + Math.abs(pm.hindsightGap), 0) / samples.length;
  let label;
  if (Math.abs(avg) < 6) label = "Your memory of past risk is well-calibrated — it neither inflates nor softens much.";
  else if (avg > 0) label = `Your memory runs ~${Math.round(avg)} points high — you tend to remember past decisions as riskier than Vestige actually rated them. Classic hindsight.`;
  else label = `Your memory runs ~${Math.round(Math.abs(avg))} points low — you tend to remember past decisions as safer than Vestige actually rated them.`;
  return { count: samples.length, avgGap: avg, avgMagnitude: absAvg, label };
}

// ── Open loops & follow-through ───────────────────────────────────────────────
// The whole calibration apparatus depends on post-mortems, which people don't
// file — and the ones they avoid filing aren't random (motivated forgetting: you
// close the loop on wins, quietly leave the flops open). Vestige holds the
// faithful record of what you committed to and never closed.
const OPEN_LOOP_MIN_AGE_DAYS = 21; // outcome should plausibly be known by now

// A decision is "resolvable" if it was committed to in a way that produces an
// outcome (proceed/modify/abandon — not an explicit "hold") and is old enough.
function isResolvable(e, now = Date.now()) {
  if (!e.commitment?.move) return false;
  if (e.commitment.move === "waiting") return false; // explicitly deferred, not neglected
  const committedAt = e.commitment.committedAt || e.timestamp;
  const age = (now - new Date(committedAt).getTime()) / 86400000;
  // If a review date was set and has passed, it's resolvable regardless of age.
  if (e.commitment.reviewDate && new Date(e.commitment.reviewDate).getTime() <= now) return true;
  return age >= OPEN_LOOP_MIN_AGE_DAYS;
}

function findOpenLoops(memory, now = Date.now()) {
  return memory
    .filter(e => isResolvable(e, now) && !e.postMortem)
    .map(e => {
      const committedAt = e.commitment.committedAt || e.timestamp;
      const ageDays = Math.round((now - new Date(committedAt).getTime()) / 86400000);
      // Priority: bigger blind spot if higher brittleness, higher stakes, older.
      const stakesW = { low: 0.3, medium: 0.6, high: 0.85, critical: 1 }[String(e.stakes || "").toLowerCase()] ?? 0.6;
      const priority = (e.brittleness ?? 50) * 0.6 + stakesW * 30 + Math.min(ageDays, 120) * 0.2;
      return { ...e, ageDays, priority };
    })
    .sort((a, b) => b.priority - a.priority);
}

// The mirror: how much you actually close, and whether you avoid the hard ones.
// Disciplined — needs enough resolvable decisions, and only asserts a bias on a
// real skew.
function computeFollowThrough(memory, now = Date.now()) {
  const resolvable = memory.filter(e => isResolvable(e, now));
  if (resolvable.length < 5) return null;
  const closed = resolvable.filter(e => e.postMortem);
  const open   = resolvable.filter(e => !e.postMortem);
  const closeRate = closed.length / resolvable.length;

  let bias = null;
  if (open.length >= 3 && closed.length >= 2) {
    const avg = arr => arr.reduce((s, e) => s + (e.brittleness ?? 50), 0) / arr.length;
    const openAvg = avg(open), closedAvg = avg(closed);
    const openProceed = open.filter(e => e.commitment?.move === "proceed").length / open.length;
    const closedProceed = closed.filter(e => e.commitment?.move === "proceed").length / closed.length;
    // Real skew: the open ones run materially riskier, or are disproportionately
    // proceeds. The proceed-skew needs enough absolute proceeds behind it, so a
    // single decision can't flip a small-sample ratio into a false accusation.
    if (openAvg - closedAvg >= 12) {
      bias = `The decisions you've left open run ~${Math.round(openAvg - closedAvg)} points riskier on average than the ones you've closed. You may be avoiding the post-mortems that would teach you the most.`;
    } else if (openProceed - closedProceed >= 0.3 && openProceed >= 0.6 && open.filter(e => e.commitment?.move === "proceed").length >= 3) {
      bias = `Your open loops are disproportionately decisions you proceeded on. The reckonings you're skipping are mostly the bold calls — exactly the ones worth learning from.`;
    }
  }

  let label;
  if (closeRate >= 0.75) label = `You close the loop on most of what you decide (${closed.length} of ${resolvable.length} resolvable decisions). That discipline is why the rest of this works.`;
  else if (closeRate >= 0.4) label = `You've closed ${closed.length} of ${resolvable.length} resolvable decisions. ${open.length} are still hanging — each one is a lesson you haven't collected.`;
  else label = `You've left most of your decisions unreviewed — ${open.length} of ${resolvable.length} resolvable ones are still open. The loop only teaches you if you close it.`;

  return { resolvable: resolvable.length, closed: closed.length, open: open.length, closeRate, label, bias };
}

// ── Self-calibration ──────────────────────────────────────────────────────────
// Does Vestige's own brittleness score actually predict this user's outcomes?
// Measured on the ORIGINAL recorded prediction vs ground truth (did the flagged
// risk materialise). Reported honestly — never used to rewrite the score, or the
// loop would eat itself. Silent until there are enough outcomes in both classes.
//
// Discrimination via AUC (Mann–Whitney): the probability that a decision which
// broke was scored higher than one that didn't. 0.5 = chance, 1.0 = perfect,
// <0.5 = inverted. Bias via implied-vs-actual: mean score against actual bad rate.
function calibrationAUC(scoresTriggered, scoresNot) {
  let wins = 0, total = 0;
  for (const t of scoresTriggered) for (const n of scoresNot) {
    total++;
    if (t > n) wins += 1;
    else if (t === n) wins += 0.5;
  }
  return total ? wins / total : null;
}

function computeCalibration(memory) {
  const resolved = memory.filter(e => e.postMortem && typeof e.postMortem.triggered === "boolean" && typeof e.brittleness === "number");
  const triggered = resolved.filter(e => e.postMortem.triggered).map(e => e.brittleness);
  const notTrig   = resolved.filter(e => !e.postMortem.triggered).map(e => e.brittleness);

  // Need both classes populated to measure whether the score separates them.
  if (resolved.length < 6 || triggered.length < 2 || notTrig.length < 2) {
    return { status: "insufficient", resolved: resolved.length, needed: 6, haveTriggered: triggered.length, haveClear: notTrig.length };
  }

  const auc = calibrationAUC(triggered, notTrig);
  const auc100 = Math.round(auc * 100);

  // Directional bias (only asserted with a solid sample and a real gap).
  const baseRate = triggered.length / resolved.length;       // actual rate of "it broke"
  const meanPredicted = resolved.reduce((s, e) => s + e.brittleness, 0) / resolved.length;
  const biasPoints = Math.round(meanPredicted - baseRate * 100); // + = runs hot
  const biasReliable = resolved.length >= 8 && Math.abs(biasPoints) >= 15;

  // Honest discrimination label.
  let discrimination, signal;
  if (auc >= 0.75) { discrimination = "strong"; signal = `Vestige's risk score has been a strong signal for you — across ${resolved.length} resolved decisions it ranked the ones that broke above the ones that didn't ${auc100}% of the time.`; }
  else if (auc >= 0.6) { discrimination = "moderate"; signal = `Vestige's score has been moderately predictive for you — it ranked outcomes correctly ${auc100}% of the time across ${resolved.length} resolved decisions.`; }
  else if (auc >= 0.45) { discrimination = "weak"; signal = `Vestige's score hasn't reliably separated your hits from misses yet (about chance, ${auc100}%). Treat the number as a prompt to think, not a verdict.`; }
  else { discrimination = "inverted"; signal = `Honest flag: for you, Vestige's score has been inverted — lower-scored decisions broke more often (${auc100}%). Something about how you decide is escaping the model. Trust your own read here.`; }

  let biasLabel = null;
  if (biasReliable) {
    biasLabel = biasPoints > 0
      ? `It also runs ~${biasPoints} points hot for you: it rates decisions at ${Math.round(meanPredicted)} on average while ${Math.round(baseRate * 100)}% actually went wrong. Read its scores down a touch.`
      : `It also runs ~${Math.abs(biasPoints)} points cold for you: it rates decisions at ${Math.round(meanPredicted)} on average while ${Math.round(baseRate * 100)}% actually went wrong. When it flags something, weight it a little heavier.`;
  }

  return { status: "ok", resolved: resolved.length, auc, auc100, discrimination, signal, biasPoints, biasReliable, biasLabel, meanPredicted: Math.round(meanPredicted), baseRate: Math.round(baseRate * 100) };
}

// ── Evolution ─────────────────────────────────────────────────────────────────
// How you're changing as a decision-maker. Splits the record into your earlier
// self and your recent self and measures real shifts. Trajectory on thin data is
// noise, so it requires genuine history spanning genuine time, compares cohorts,
// and surfaces only shifts large enough to mean something. Silent otherwise, and
// never "you have become X" — only how the decisions and the behaviour have moved.
function computeEvolution(memory, now = Date.now()) {
  const all = memory
    .filter(e => typeof e.brittleness === "number" && e.timestamp)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const spanDays = all.length >= 2 ? (new Date(all[all.length - 1].timestamp) - new Date(all[0].timestamp)) / 86400000 : 0;
  if (all.length < 8 || spanDays < 30) {
    return { status: "insufficient", count: all.length, needed: 8, spanDays: Math.round(spanDays) };
  }

  const mid = Math.floor(all.length / 2);
  const earlier = all.slice(0, mid);
  const recent  = all.slice(mid);
  const mean = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
  const pct  = x => Math.round(x * 100);

  const shifts = [];

  // 1) Structural risk of the decisions being weighed.
  if (earlier.length >= 3 && recent.length >= 3) {
    const ea = mean(earlier.map(e => e.brittleness));
    const ra = mean(recent.map(e => e.brittleness));
    if (Math.abs(ra - ea) >= 10) {
      shifts.push({
        key: "risk", dir: ra > ea ? "up" : "down", magnitude: Math.abs(ra - ea),
        text: ra > ea
          ? `The decisions you're weighing have grown more structurally risky — your average brittleness has risen from ${Math.round(ea)} to ${Math.round(ra)}.`
          : `You're bringing more solid decisions than you used to — average brittleness has fallen from ${Math.round(ea)} to ${Math.round(ra)}.`
      });
    }
  }

  // 2) Boldness — proceed rate among committed decisions.
  const committed = a => a.filter(e => e.commitment?.move);
  const ec = committed(earlier), rc = committed(recent);
  if (ec.length >= 3 && rc.length >= 3) {
    const ep = ec.filter(e => e.commitment.move === "proceed").length / ec.length;
    const rp = rc.filter(e => e.commitment.move === "proceed").length / rc.length;
    if (Math.abs(rp - ep) >= 0.25) {
      shifts.push({
        key: "boldness", dir: rp > ep ? "up" : "down", magnitude: Math.abs(rp - ep),
        text: rp > ep
          ? `You're proceeding more readily than you used to — from ${pct(ep)}% to ${pct(rp)}% of your committed decisions.`
          : `You've grown more cautious — you proceed on ${pct(rp)}% of your decisions now versus ${pct(ep)}% earlier.`
      });
    }
  }

  // 3) Follow-through — close rate among resolvable decisions.
  const resolvable = a => a.filter(e => isResolvable(e, now));
  const er = resolvable(earlier), rr = resolvable(recent);
  if (er.length >= 3 && rr.length >= 3) {
    const ecl = er.filter(e => e.postMortem).length / er.length;
    const rcl = rr.filter(e => e.postMortem).length / rr.length;
    if (Math.abs(rcl - ecl) >= 0.25) {
      shifts.push({
        key: "followthrough", dir: rcl > ecl ? "up" : "down", magnitude: Math.abs(rcl - ecl),
        text: rcl > ecl
          ? `Your follow-through is improving — you now close ${pct(rcl)}% of resolvable decisions versus ${pct(ecl)}% earlier.`
          : `Your follow-through is slipping — you're closing ${pct(rcl)}% of loops now versus ${pct(ecl)}% earlier.`
      });
    }
  }

  // 4) Self-knowledge — is the hindsight gap narrowing?
  const withGap = a => a.filter(e => e.postMortem && typeof e.postMortem.hindsightGap === "number");
  const eg = withGap(earlier), rg = withGap(recent);
  if (eg.length >= 3 && rg.length >= 3) {
    const em = mean(eg.map(e => Math.abs(e.postMortem.hindsightGap)));
    const rm = mean(rg.map(e => Math.abs(e.postMortem.hindsightGap)));
    if (Math.abs(rm - em) >= 8) {
      shifts.push({
        key: "selfknowledge", dir: rm < em ? "up" : "down", magnitude: Math.abs(rm - em),
        text: rm < em
          ? `You're learning to remember your own judgment more honestly — your hindsight gap has narrowed from ${Math.round(em)} to ${Math.round(rm)} points.`
          : `Your memory of past decisions is drifting further from what Vestige recorded — your hindsight gap has widened from ${Math.round(em)} to ${Math.round(rm)} points.`
      });
    }
  }

  // 5) Outcome quality — rate the flagged risk actually materialised.
  const resolved = a => a.filter(e => e.postMortem && typeof e.postMortem.triggered === "boolean");
  const eo = resolved(earlier), ro = resolved(recent);
  if (eo.length >= 3 && ro.length >= 3) {
    const eb = eo.filter(e => e.postMortem.triggered).length / eo.length;
    const rb = ro.filter(e => e.postMortem.triggered).length / ro.length;
    if (Math.abs(rb - eb) >= 0.25) {
      shifts.push({
        key: "outcomes", dir: rb < eb ? "up" : "down", magnitude: Math.abs(rb - eb),
        text: rb < eb
          ? `Your decisions are going better — the flagged risk materialised in ${pct(rb)}% of recent resolved decisions versus ${pct(eb)}% earlier.`
          : `More of your recent decisions have gone wrong — the flagged risk hit ${pct(rb)}% of the time versus ${pct(eb)}% earlier.`
      });
    }
  }

  if (shifts.length === 0) {
    return { status: "stable", count: all.length, spanDays: Math.round(spanDays), earlierCount: earlier.length, recentCount: recent.length };
  }

  // Honest synthesis — recognise a few meaningful pairings, else lead with the biggest shift.
  const has = k => shifts.find(s => s.key === k);
  let summary;
  const bolder = has("boldness")?.dir === "up", cautious = has("boldness")?.dir === "down";
  const outcomesWorse = has("outcomes")?.dir === "down", outcomesBetter = has("outcomes")?.dir === "up";
  const sharper = has("selfknowledge")?.dir === "up";
  if (bolder && outcomesWorse) summary = "You're taking on more risk, and it's starting to cost you. Worth a hard look before the next bold call.";
  else if (cautious && outcomesBetter) summary = "Your caution is paying off — you're proceeding less and your outcomes have improved.";
  else if (sharper) summary = "The clearest shift: you're becoming more self-aware — your memory of your own judgment is getting more honest.";
  else summary = shifts.slice().sort((a, b) => b.magnitude - a.magnitude)[0].text;

  return { status: "ok", count: all.length, spanDays: Math.round(spanDays), earlierCount: earlier.length, recentCount: recent.length, shifts, summary };
}

function PostMortemPrompt({ entry, onSubmit, onSkip }) {
  const hasPrediction = typeof entry?.brittleness === "number";
  const aged = decisionAgeDays(entry) >= HINDSIGHT_MIN_AGE_DAYS;
  // Only run the hindsight capture when there's a prediction to compare against
  // and enough time has passed for memory to have plausibly drifted.
  const runHindsight = hasPrediction && aged;

  const [phase, setPhase]         = useState(runHindsight ? "recall" : "postmortem");
  const [recalled, setRecalled]   = useState(50);
  const [recallUnknown, setRecallUnknown] = useState(false);
  const [outcome, setOutcome]     = useState("");
  const [accuracy, setAccuracy]   = useState(null); // 1-5
  const [triggered, setTriggered] = useState(null); // boolean
  const [notes, setNotes]         = useState("");

  const gapInfo = (!recallUnknown && runHindsight) ? interpretHindsightGap(recalled, entry.brittleness, outcome) : null;

  function submit() {
    if (!outcome || accuracy === null || triggered === null) return;
    const payload = { outcome, accuracy, triggered, notes, completedAt: new Date().toISOString() };
    if (runHindsight && !recallUnknown) {
      payload.recalledBrittleness = recalled;
      payload.hindsightGap = recalled - entry.brittleness;
    }
    onSubmit(payload);
  }

  const ready = outcome && accuracy !== null && triggered !== null;
  const col = scoreColor(entry?.brittleness ?? 50);

  // ── Phase 1: recall (before the truth is shown) ──
  if (phase === "recall") {
    return (
      <div style={{
        background: "linear-gradient(135deg, rgba(94,212,212,0.06), rgba(15,12,24,0.7))",
        backdropFilter: "blur(20px)", border: `1px solid ${CYAN}33`,
        borderRadius: 2, padding: "24px 22px", marginBottom: 20
      }}>
        <div style={{ fontSize: 10, color: CYAN, letterSpacing: 4, fontWeight: 600, marginBottom: 12, opacity: 0.85 }}>BEFORE YOU LOOK BACK</div>
        <p style={{ fontSize: 14, color: "#bbb", marginBottom: 4, lineHeight: 1.55 }}>This decision is {Math.round(decisionAgeDays(entry))} days old. Before Vestige shows you what it actually said — what do you <em>remember</em> it rating this?</p>
        <p style={{ fontSize: 12, color: "#555", marginBottom: 22, lineHeight: 1.55 }}>From memory. Don't peek at the analysis. The gap is the point.</p>

        <div style={{ opacity: recallUnknown ? 0.4 : 1, pointerEvents: recallUnknown ? "none" : "auto", transition: "opacity 0.2s" }}>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 12, marginBottom: 10 }}>
            <span style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 56, fontWeight: 400, color: scoreColor(recalled), lineHeight: 0.9, letterSpacing: "-0.03em" }}>{recalled}</span>
            <span style={{ fontSize: 13, color: "#444", paddingBottom: 8 }}>/ 100 · {scoreLabel(recalled)}</span>
          </div>
          <input type="range" min="0" max="100" value={recalled} onChange={e => setRecalled(Number(e.target.value))}
            style={{ width: "100%", accentColor: CYAN, cursor: "pointer", marginBottom: 6 }} />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#333" }}>
            <span>Stable</span><span>Critical</span>
          </div>
        </div>

        <button onClick={() => setRecallUnknown(u => !u)} style={{
          background: "none", border: "none", color: recallUnknown ? CYAN : "#555", fontSize: 11.5,
          cursor: "pointer", fontFamily: "inherit", padding: "10px 0 0", textDecoration: "underline"
        }}>{recallUnknown ? "Actually, let me estimate" : "I genuinely don't remember"}</button>

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 18 }}>
          <Btn variant="ghost" onClick={onSkip}>Skip</Btn>
          <Btn variant="primary" onClick={() => setPhase(recallUnknown ? "postmortem" : "reveal")}>{recallUnknown ? "Continue" : "Reveal what it actually said"}</Btn>
        </div>
      </div>
    );
  }

  // ── Phase 2: reveal the gap ──
  if (phase === "reveal") {
    return (
      <div style={{
        background: "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)",
        backdropFilter: "blur(20px)", border: `1px solid ${PURPLE}33`,
        borderRadius: 2, padding: "24px 22px", marginBottom: 20, animation: "fadeUp 0.3s ease"
      }}>
        <div style={{ fontSize: 10, color: PURPLE_BRIGHT, letterSpacing: 4, fontWeight: 600, marginBottom: 18, opacity: 0.8 }}>THE HINDSIGHT GAP</div>
        <div style={{ display: "flex", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 120, textAlign: "center", padding: "16px 12px", background: `${CYAN}0a`, border: `1px solid ${CYAN}22`, borderRadius: 2 }}>
            <div style={{ fontSize: 9, color: CYAN, letterSpacing: 2, fontWeight: 600, marginBottom: 8, opacity: 0.8 }}>YOU REMEMBERED</div>
            <div style={{ fontSize: 40, fontWeight: 800, color: scoreColor(recalled), letterSpacing: "-0.03em", lineHeight: 1 }}>{recalled}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", color: "#444", fontSize: 20 }}>→</div>
          <div style={{ flex: 1, minWidth: 120, textAlign: "center", padding: "16px 12px", background: `${col}0a`, border: `1px solid ${col}33`, borderRadius: 2 }}>
            <div style={{ fontSize: 9, color: col, letterSpacing: 2, fontWeight: 600, marginBottom: 8, opacity: 0.8 }}>IT ACTUALLY SAID</div>
            <div style={{ fontSize: 40, fontWeight: 800, color: col, letterSpacing: "-0.03em", lineHeight: 1 }}>{entry.brittleness}</div>
          </div>
        </div>
        {gapInfo && (
          <p style={{
            fontFamily: gapInfo.direction === "accurate" ? "inherit" : "'Instrument Serif', Georgia, serif",
            fontSize: gapInfo.direction === "accurate" ? 13 : 16,
            color: gapInfo.direction === "accurate" ? "#7a9a82" : "#bbb",
            lineHeight: 1.7, margin: 0, fontStyle: gapInfo.direction === "accurate" ? "normal" : "italic"
          }}>{gapInfo.text}</p>
        )}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 20 }}>
          <Btn variant="primary" onClick={() => setPhase("postmortem")}>Now, how did it play out?</Btn>
        </div>
      </div>
    );
  }

  // ── Phase 3: the post-mortem itself ──
  return (
    <div style={{
      background: "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)",
      backdropFilter: "blur(20px)",
      border: `1px solid ${PURPLE}33`,
      borderRadius: 2,
      padding: "24px 22px",
      marginBottom: 20
    }}>
      <div style={{ fontSize: 10, color: PURPLE_BRIGHT, letterSpacing: 4, fontWeight: 600, marginBottom: 12, opacity: 0.8 }}>POST-MORTEM</div>
      <p style={{ fontSize: 14, color: "#aaa", marginBottom: 4, lineHeight: 1.5 }}>How did this decision actually play out?</p>
      <p style={{ fontSize: 12, color: "#444", marginBottom: 20, lineHeight: 1.5 }}>This calibrates Vestige to your judgment. You only see this once per decision.</p>

      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 10, color: "#888", letterSpacing: 2, fontWeight: 600, marginBottom: 8 }}>OUTCOME</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {[
            { v: "proceeded_good", l: "Proceeded · Good outcome" },
            { v: "proceeded_bad",  l: "Proceeded · Bad outcome" },
            { v: "modified",       l: "Modified the plan" },
            { v: "abandoned",      l: "Abandoned" },
          ].map(o => (
            <button key={o.v} onClick={() => setOutcome(o.v)} style={{
              background: outcome === o.v ? `${PURPLE}33` : "transparent",
              border: `1px solid ${outcome === o.v ? PURPLE + "66" : "rgba(255,255,255,0.08)"}`,
              color: outcome === o.v ? "#fff" : "#666",
              fontSize: 12, padding: "8px 14px", borderRadius: 8,
              cursor: "pointer", fontFamily: "inherit",
              WebkitTapHighlightColor: "transparent", transition: "all 0.2s"
            }}>{o.l}</button>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 10, color: "#888", letterSpacing: 2, fontWeight: 600, marginBottom: 8 }}>DID THE FLAGGED RISK TRIGGER?</div>
        <div style={{ display: "flex", gap: 6 }}>
          {[
            { v: true,  l: "Yes" },
            { v: false, l: "No" },
          ].map(o => (
            <button key={String(o.v)} onClick={() => setTriggered(o.v)} style={{
              background: triggered === o.v ? `${PURPLE}33` : "transparent",
              border: `1px solid ${triggered === o.v ? PURPLE + "66" : "rgba(255,255,255,0.08)"}`,
              color: triggered === o.v ? "#fff" : "#666",
              fontSize: 12, padding: "8px 18px", borderRadius: 8,
              cursor: "pointer", fontFamily: "inherit",
              WebkitTapHighlightColor: "transparent", transition: "all 0.2s",
              minWidth: 70
            }}>{o.l}</button>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 10, color: "#888", letterSpacing: 2, fontWeight: 600, marginBottom: 8 }}>HOW ACCURATE WAS VESTIGE'S READ?</div>
        <div style={{ display: "flex", gap: 4 }}>
          {[1, 2, 3, 4, 5].map(n => (
            <button key={n} onClick={() => setAccuracy(n)} style={{
              flex: 1, background: accuracy !== null && n <= accuracy ? `linear-gradient(135deg, ${PURPLE}, ${PURPLE_BRIGHT})` : "transparent",
              border: `1px solid ${accuracy !== null && n <= accuracy ? PURPLE + "88" : "rgba(255,255,255,0.08)"}`,
              color: accuracy !== null && n <= accuracy ? "#fff" : "#444",
              fontSize: 13, fontWeight: 600, padding: "10px", borderRadius: 8,
              cursor: "pointer", fontFamily: "inherit",
              WebkitTapHighlightColor: "transparent", transition: "all 0.2s"
            }}>{n}</button>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#333", marginTop: 6 }}>
          <span>Way off</span>
          <span>Nailed it</span>
        </div>
      </div>

      <textarea
        value={notes} onChange={e => setNotes(e.target.value)}
        placeholder="What actually happened? (optional)"
        rows={3}
        style={{
          width: "100%", background: "rgba(0,0,0,0.2)",
          border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10,
          padding: "12px 14px", color: "#bbb", fontSize: 13, lineHeight: 1.6,
          resize: "none", fontFamily: "inherit", marginBottom: 16
        }}
      />

      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <Btn variant="ghost" onClick={onSkip}>Skip for now</Btn>
        <Btn variant="primary" onClick={submit} disabled={!ready}>Save post-mortem</Btn>
      </div>
    </div>
  );
}

// ── Commitment block — what's your move after the verdict ─────────────────────
function CommitmentBlock({ entry, onCommit, memory = [], onOpen }) {
  const [move, setMove]             = useState(entry?.commitment?.move || null);
  const [reviewDate, setReviewDate] = useState(entry?.commitment?.reviewDate || "");
  const [notes, setNotes]           = useState(entry?.commitment?.notes || "");
  const [editing, setEditing]       = useState(!entry?.commitment);

  const committed = entry?.commitment && !editing;

  // The memory defends its validated lessons at the moment of choice.
  const challenge = (!committed && move) ? checkCommitmentConsistency(memory, entry, move) : null;

  function save() {
    if (!move) return;
    onCommit({ move, reviewDate, notes, committedAt: new Date().toISOString(), overrodeChallenge: challenge ? challenge.severity : null });
    setEditing(false);
  }

  if (committed) {
    const moveLabels = { proceed: "Proceeding", modify: "Modifying first", abandon: "Walking away", waiting: "Holding for now" };
    const moveColors = { proceed: "#22c55e", modify: PURPLE_BRIGHT, abandon: "#ef4444", waiting: "#f97316" };
    return (
      <div style={{
        border: `1px solid ${moveColors[entry.commitment.move]}44`,
        borderLeft: `2px solid ${moveColors[entry.commitment.move]}`,
        borderRadius: 2, padding: "18px 20px", marginBottom: 12,
        background: "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)"
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace", fontSize: 9.5, color: moveColors[entry.commitment.move], letterSpacing: "0.2em", textTransform: "uppercase" }}>Your Commitment</div>
          <button onClick={() => setEditing(true)} style={{
            background: "none", border: "none", color: "#5a5a6a", fontSize: 11, cursor: "pointer",
            fontFamily: "'JetBrains Mono', monospace", padding: 0, letterSpacing: "0.05em"
          }}>edit</button>
        </div>
        <div style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 20, color: "#e0e0e8", marginBottom: entry.commitment.reviewDate ? 6 : 0 }}>
          {moveLabels[entry.commitment.move]}
        </div>
        {entry.commitment.reviewDate && (
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, color: "#7a7a8c", letterSpacing: "0.04em" }}>
            Review by {new Date(entry.commitment.reviewDate).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}
          </div>
        )}
        {entry.commitment.notes && (
          <p style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 15, color: "#9a9aac", lineHeight: 1.5, margin: "10px 0 0", paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.06)" }}>{entry.commitment.notes}</p>
        )}
        {entry.commitment.overrodeChallenge && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.06)" }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={entry.commitment.overrodeChallenge === "high" ? "#ef4444" : "#f97316"} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9.5, color: entry.commitment.overrodeChallenge === "high" ? "#9a6a6a" : "#9a7a5a", letterSpacing: "0.06em" }}>Committed against your own prior evidence</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{
      border: "1px solid rgba(255,255,255,0.08)",
      borderRadius: 2, padding: "20px 20px", marginBottom: 12,
      background: "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)"
    }}>
      <div style={{ fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace", fontSize: 9.5, color: PURPLE_BRIGHT, letterSpacing: "0.22em", textTransform: "uppercase", marginBottom: 6 }}>Your Move</div>
      <p style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 16, color: "#9a9aac", marginBottom: 16, lineHeight: 1.4 }}>Commit to a path. Vestige tracks what you actually do.</p>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
        {[
          { v: "proceed", l: "Proceed" },
          { v: "modify",  l: "Modify first" },
          { v: "waiting", l: "Hold" },
          { v: "abandon", l: "Abandon" },
        ].map(o => (
          <button key={o.v} onClick={() => setMove(o.v)} style={{
            background: move === o.v ? `${PURPLE}33` : "transparent",
            border: `1px solid ${move === o.v ? PURPLE + "66" : "rgba(255,255,255,0.08)"}`,
            color: move === o.v ? "#fff" : "#666",
            fontSize: 12, padding: "8px 14px", borderRadius: 8,
            cursor: "pointer", fontFamily: "inherit",
            WebkitTapHighlightColor: "transparent", transition: "all 0.2s"
          }}>{o.l}</button>
        ))}
      </div>

      {challenge && (
        <div style={{
          background: challenge.severity === "high"
            ? "linear-gradient(135deg, rgba(239,68,68,0.1), rgba(124,92,191,0.04))"
            : "linear-gradient(135deg, rgba(249,115,22,0.08), rgba(124,92,191,0.04))",
          border: `1px solid ${challenge.severity === "high" ? "rgba(239,68,68,0.3)" : "rgba(249,115,22,0.28)"}`,
          borderLeft: `2px solid ${challenge.severity === "high" ? "#ef4444" : "#f97316"}`,
          borderRadius: 2, padding: "16px 18px", marginBottom: 14,
          animation: "fadeUp 0.3s ease"
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={challenge.severity === "high" ? "#ef4444" : "#f97316"} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <span style={{ fontSize: 9, color: challenge.severity === "high" ? "#ef4444" : "#f97316", letterSpacing: 2.5, fontWeight: 700, opacity: 0.9 }}>YOUR OWN EVIDENCE SAYS OTHERWISE</span>
          </div>
          <p style={{ fontSize: 13.5, color: "#cdc3c3", lineHeight: 1.6, margin: "0 0 6px", fontWeight: 600 }}>{challenge.headline}</p>
          <p style={{ fontSize: 12, color: "#8a7a7a", lineHeight: 1.6, margin: "0 0 12px" }}>{challenge.body}</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {challenge.evidence.map(ev => (
              <button key={ev.id} onClick={() => onOpen && onOpen(memory.find(m => m.id === ev.id))} disabled={!onOpen} style={{
                textAlign: "left", background: "rgba(0,0,0,0.22)",
                border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8,
                padding: "9px 12px", cursor: onOpen ? "pointer" : "default", fontFamily: "inherit"
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                  <span style={{ fontSize: 11.5, color: "#999", lineHeight: 1.45, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ev.decision}</span>
                  {ev.brittleness != null && <span style={{ fontSize: 12, fontWeight: 700, color: scoreColor(ev.brittleness), flexShrink: 0 }}>{ev.brittleness}</span>}
                </div>
                {ev.lesson && <div style={{ fontSize: 10.5, color: "#6a8a8a", marginTop: 3, fontStyle: "italic" }}>{ev.lesson}</div>}
              </button>
            ))}
          </div>
          <p style={{ fontSize: 11, color: challenge.severity === "high" ? "#9a6a6a" : "#9a7a5a", lineHeight: 1.5, margin: "12px 0 0" }}>
            You can still commit — but now you're doing it with your eyes open. The override is logged.
          </p>
        </div>
      )}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: "#666", letterSpacing: 1 }}>Review by</span>
        <input
          type="date"
          value={reviewDate}
          onChange={e => setReviewDate(e.target.value)}
          style={{
            background: "rgba(0,0,0,0.2)", border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 8, padding: "8px 12px", color: "#bbb", fontSize: 13,
            fontFamily: "inherit", colorScheme: "dark"
          }}
        />
      </div>
      <textarea
        value={notes} onChange={e => setNotes(e.target.value)}
        placeholder="Why this move? (optional)"
        rows={2}
        style={{
          width: "100%", background: "rgba(0,0,0,0.2)",
          border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8,
          padding: "10px 12px", color: "#bbb", fontSize: 13, lineHeight: 1.6,
          resize: "none", fontFamily: "inherit", marginBottom: 12
        }}
      />
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        {entry?.commitment && <Btn variant="ghost" onClick={() => setEditing(false)}>Cancel</Btn>}
        <Btn variant="primary" onClick={save} disabled={!move}>{challenge ? "Commit anyway" : "Commit"}</Btn>
      </div>
    </div>
  );
}

// ── Archetype context — pattern knowledge for the decision type ───────────────
function ArchetypeContext({ archetype, context }) {
  if (!context || !archetype || archetype === "generic") return null;
  const labels = {
    pricing_change: "Pricing Change", hire_decision: "Hire Decision",
    fire_decision: "Personnel Removal", scope_cut: "Scope Reduction",
    partnership: "Partnership", market_entry: "Market Entry",
    product_launch: "Product Launch", capital_raise: "Capital Raise",
    pivot: "Pivot", restructure: "Restructure",
    vendor_switch: "Vendor Switch", contract_negotiation: "Contract Negotiation",
    role_redesign: "Role Redesign", geographic_expansion: "Geographic Expansion"
  };
  return (
    <div style={{
      border: "1px solid rgba(94,212,212,0.18)",
      borderRadius: 2, padding: "14px 18px", marginBottom: 12,
      display: "flex", gap: 12, alignItems: "flex-start",
      background: "linear-gradient(180deg, rgba(94,212,212,0.025), transparent)"
    }}>
      <div style={{
        fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
        fontSize: 9, color: CYAN, letterSpacing: "0.14em", fontWeight: 500,
        flexShrink: 0, marginTop: 3, textTransform: "uppercase"
      }}>{(labels[archetype] || archetype)}</div>
      <p style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 15, color: "#9a9aac", lineHeight: 1.45, margin: 0, flex: 1 }}>{context}</p>
    </div>
  );
}

// ── Follow-up conversation ────────────────────────────────────────────────────
function FollowUp({ analysisContext, existingThread, onAppendMessage, onUpdateBrittleness }) {
  // Filter existing thread to only show conversational messages (skip initial decision/analysis - those render elsewhere)
  const threadMessages = (existingThread || []).filter(m => m.type === "message" || m.type === "vestige_reply");
  const [messages, setMessages] = useState(threadMessages.map(m => ({
    role: m.role === "vestige" ? "assistant" : "user",
    content: m.content,
    updatedScore: m.updatedScore,
    timestamp: m.timestamp
  })));
  const [input, setInput]       = useState("");
  const [loading, setLoading]   = useState(false);
  const bottomRef               = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send() {
    const q = input.trim();
    if (!q || loading) return;
    setInput("");
    const userMsg = { role: "user", content: q, timestamp: new Date().toISOString() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setLoading(true);

    // Persist user message to thread
    if (onAppendMessage) {
      onAppendMessage({
        role: "user",
        type: "message",
        content: q,
        timestamp: new Date().toISOString()
      });
    }

    const contextSummary = `You are Vestige, a decision intelligence system. The user just received this analysis:

Decision: ${analysisContext.decision}
Stakes: ${analysisContext.stakes}
Reversibility: ${analysisContext.anatomy?.reversibility}
Risk Score: ${analysisContext.brittleness}/100 (${scoreLabel(analysisContext.brittleness)})
Failure modes: ${(analysisContext.failures || []).map(f => `${f.failure_mode} (${roleLabels[f.role] || f.role})`).join(", ")}
Verdict: ${analysisContext.verdict}

Now the user is asking follow-up questions. Answer directly, no hedging, max 3 sentences per reply. Do not repeat the analysis back. Be a sharp advisor.`;

    const history = newMessages.map(m => ({ role: m.role, content: m.content }));

    try {
      const res = await fetch("/api/followup", {
        method: "POST",
        headers: await authedHeaders(),
        body: JSON.stringify({ context: contextSummary, messages: history })
      });
      const data = await res.json();
      const reply = data.reply || "Could not get a response - try again.";
      const assistantMsg = { role: "assistant", content: reply, updatedScore: data.updatedScore, timestamp: new Date().toISOString() };
      setMessages(prev => [...prev, assistantMsg]);

      // Persist assistant message to thread
      if (onAppendMessage) {
        onAppendMessage({
          role: "vestige",
          type: "vestige_reply",
          content: reply,
          updatedScore: data.updatedScore || null,
          timestamp: new Date().toISOString()
        });
      }
      // Update brittleness if score changed
      if (data.updatedScore && onUpdateBrittleness) {
        onUpdateBrittleness(data.updatedScore);
      }
    } catch {
      setMessages(prev => [...prev, { role: "assistant", content: "Connection failed - try again." }]);
    }
    setLoading(false);
  }

  const suggestions = [
    "Which failure would kill this fastest?",
    "What am I not seeing?",
    "What would you do?",
  ];

  return (
    <div style={{
      background: "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)",
      border: "1px solid rgba(255,255,255,0.06)",
      borderRadius: 2,
      overflow: "hidden",
      marginBottom: 20
    }}>
      <div style={{
        padding: "18px 22px",
        borderBottom: "1px solid rgba(255,255,255,0.04)",
        display: "flex", alignItems: "center", gap: 12
      }}>
        <div style={{
          width: 8, height: 8, borderRadius: "50%",
          background: PURPLE_BRIGHT,
          boxShadow: `0 0 12px ${PURPLE_BRIGHT}, 0 0 4px ${PURPLE_BRIGHT}`,
          animation: "pulse 2s ease infinite"
        }} />
        <span style={{ fontSize: 10, color: PURPLE_BRIGHT, letterSpacing: 4, fontWeight: 600, opacity: 0.7 }}>
          {messages.length > 0 ? `CONVERSATION · ${messages.filter(m => m.role === "user").length} pushback${messages.filter(m => m.role === "user").length !== 1 ? "s" : ""}` : "ASK VESTIGE"}
        </span>
      </div>

      {messages.length === 0 && (
        <div style={{ padding: "16px 20px 0" }}>
          <p style={{ fontSize: 12, color: "#2a2a3a", marginBottom: 12 }}>Push back. Ask what the verdict means for you.</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
            {suggestions.map((s, i) => (
              <button key={i} onClick={() => { setInput(s); }} style={{
                background: "#0f0f18", border: "1px solid #ffffff07",
                color: "#333", fontSize: 12, padding: "10px 14px", borderRadius: 8,
                cursor: "pointer", fontFamily: "inherit", textAlign: "left",
                transition: "all 0.2s", WebkitTapHighlightColor: "transparent"
              }}
              onMouseEnter={e => { e.currentTarget.style.color = "#666"; e.currentTarget.style.borderColor = "#ffffff12"; }}
              onMouseLeave={e => { e.currentTarget.style.color = "#333"; e.currentTarget.style.borderColor = "#ffffff07"; }}
              >{s}</button>
            ))}
          </div>
        </div>
      )}

      {messages.length > 0 && (
        <div style={{ maxHeight: 460, overflowY: "auto", padding: "16px 20px" }}>
          {messages.map((m, i) => (
            <div key={i} style={{
              marginBottom: 16,
              display: "flex",
              flexDirection: "column",
              alignItems: m.role === "user" ? "flex-end" : "flex-start"
            }}>
              <div style={{
                maxWidth: "85%",
                background: m.role === "user"
                  ? `linear-gradient(135deg, ${PURPLE}33, ${PURPLE}1a)`
                  : "linear-gradient(135deg, rgba(15,15,24,0.8), rgba(20,16,32,0.6))",
                border: `1px solid ${m.role === "user" ? PURPLE + "33" : "rgba(255,255,255,0.06)"}`,
                borderRadius: m.role === "user" ? "14px 14px 3px 14px" : "14px 14px 14px 3px",
                padding: "11px 15px",
                backdropFilter: "blur(10px)",
                WebkitBackdropFilter: "blur(10px)"
              }}>
                <p style={{ fontSize: 13, color: m.role === "user" ? "#aaa" : "#666", lineHeight: 1.7, margin: 0 }}>{m.content}</p>
                {m.updatedScore !== null && m.updatedScore !== undefined && (
                  <div style={{
                    marginTop: 10, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.06)",
                    display: "flex", alignItems: "center", gap: 8
                  }}>
                    <span style={{ fontSize: 9, color: "#2a2a3a", letterSpacing: 2.5, fontWeight: 600 }}>UPDATED RISK</span>
                    <span style={{
                      fontSize: 16, fontWeight: 800,
                      color: m.updatedScore >= 75 ? "#ef4444" : m.updatedScore >= 50 ? "#f97316" : m.updatedScore >= 25 ? "#9B7FD4" : "#22c55e",
                      letterSpacing: "-0.02em"
                    }}>{m.updatedScore}<span style={{ fontSize: 11, color: "#2a2a3a", fontWeight: 500 }}>/100</span></span>
                  </div>
                )}
              </div>
              {m.timestamp && (
                <span style={{ fontSize: 9, color: "#2a2a3a", marginTop: 4, padding: "0 4px", letterSpacing: 0.5 }}>
                  {new Date(m.timestamp).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} · {new Date(m.timestamp).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
            </div>
          ))}
          {loading && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
              <div style={{ width: 12, height: 12, borderRadius: "50%", border: `1.5px solid ${PURPLE}33`, borderTopColor: PURPLE, animation: "spin 0.8s linear infinite" }} />
              <span style={{ fontSize: 12, color: "#2a2a3a", fontStyle: "italic" }}>thinking...</span>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      )}

      <div style={{ padding: "12px 16px", borderTop: "1px solid #ffffff06" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value.slice(0, CHAT_MAX_CHARS))}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Push back..."
            rows={1}
            style={{
              flex: 1, background: "transparent", border: "none",
              color: "#ccc", fontSize: 16, fontFamily: "inherit",
              outline: "none", padding: "8px 0", resize: "none",
              maxHeight: 120, lineHeight: 1.5
            }}
          />
          <button onClick={send} disabled={!input.trim() || loading} style={{
            background: input.trim() && !loading ? `linear-gradient(135deg,${PURPLE},#9333ea)` : "#141420",
            border: "none", color: input.trim() && !loading ? "#fff" : "#333",
            fontSize: 13, fontWeight: 600, padding: "8px 18px", borderRadius: 8,
            cursor: input.trim() && !loading ? "pointer" : "not-allowed",
            fontFamily: "inherit", WebkitTapHighlightColor: "transparent",
            minHeight: 40, transition: "all 0.2s", flexShrink: 0
          }}>Send</button>
        </div>
        {/* Character counter — appears once you start typing; warns near the cap. */}
        {input.length > 0 && (
          <div style={{
            textAlign: "right", fontSize: 10.5, marginTop: 4, letterSpacing: 0.3,
            color: input.length >= CHAT_MAX_CHARS ? "#ef6a6a" : input.length > CHAT_MAX_CHARS * 0.85 ? "#f0a060" : "#444"
          }}>
            {input.length} / {CHAT_MAX_CHARS}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Inline confirm ────────────────────────────────────────────────────────────
function InlineConfirm({ message, onConfirm, onCancel }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", background: "#1a0808", border: "1px solid #3a1010", borderRadius: 8, flexWrap: "wrap", marginBottom: 20 }}>
      <span style={{ fontSize: 13, color: "#888", flex: 1 }}>{message}</span>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn variant="danger" onClick={onConfirm} style={{ fontSize: 12, padding: "6px 14px" }}>Clear</Btn>
        <Btn variant="ghost"  onClick={onCancel}  style={{ fontSize: 12, padding: "6px 14px" }}>Cancel</Btn>
      </div>
    </div>
  );
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function Toast({ msg }) {
  if (!msg) return null;
  return (
    <div style={{
      position: "fixed", bottom: "calc(32px + var(--safe-bottom))", left: "50%", transform: "translateX(-50%)",
      background: "linear-gradient(135deg, rgba(26,26,42,0.95), rgba(20,18,32,0.95))",
      border: "1px solid rgba(255,255,255,0.1)",
      color: "#ccc", fontSize: 13, fontWeight: 500,
      padding: "12px 22px", borderRadius: 2, zIndex: 200,
      maxWidth: "calc(100vw - 32px)", textAlign: "center",
      animation: "fadeUp 0.3s ease",
      boxShadow: `0 12px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.02), inset 0 1px 0 rgba(255,255,255,0.08)`,
      pointerEvents: "none",
      display: "flex", alignItems: "center", gap: 10
    }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={PURPLE_BRIGHT} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      {msg}
    </div>
  );
}

// ── Memory badge ──────────────────────────────────────────────────────────────
function RetentionBadge({ retention, importance, strength, accessCount, fresh }) {
  const colors = { full: "#22c55e", partial: PURPLE_BRIGHT, compress: "#444" };
  const labels = { full: "vivid", partial: "fading", compress: "faint" };
  const col = colors[retention] || "#444";
  const pct = Math.round((strength ?? (retention === "full" ? 0.8 : retention === "partial" ? 0.4 : 0.15)) * 100);
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      fontSize: 9, color: col, letterSpacing: 2, fontWeight: 600,
      border: `1px solid ${col}33`, padding: "2px 7px", borderRadius: 4,
      animation: fresh && retention === "full" ? "pulse 2s ease 3" : "none"
    }}>
      {labels[retention] || "stored"}
      <span style={{ position: "relative", width: 22, height: 3, background: "rgba(255,255,255,0.08)", borderRadius: 2, overflow: "hidden" }}>
        <span style={{ position: "absolute", inset: 0, width: `${pct}%`, background: col, borderRadius: 2 }} />
      </span>
      {accessCount > 0 && <span style={{ opacity: 0.6, fontSize: 8 }}>↺{accessCount}</span>}
    </span>
  );
}

// ── Recalled memories — what the past says about this decision ────────────────
// ── Inherited warning — the decision walked into a surviving pattern ──────────
// ── Reasoning trace UI — "How Vestige read this" ─────────────────────────────
function ReasoningTrace({ memory, result }) {
  const [open, setOpen] = useState(false);
  const { grounding, steps } = buildReasoningTrace(memory, result);
  const toneColor = { neutral: "#888", soft: "#666", warn: "#f0a060", good: "#6ab88a" };
  return (
    <div style={{
      border: "1px solid rgba(255,255,255,0.08)",
      borderRadius: 2, marginBottom: 16, overflow: "hidden",
      background: "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)"
    }}>
      <button onClick={() => setOpen(o => !o)} style={{
        width: "100%", background: "none", border: "none", cursor: "pointer",
        fontFamily: "inherit", padding: "16px 18px", display: "flex",
        alignItems: "center", justifyContent: "space-between", gap: 12, textAlign: "left",
        WebkitTapHighlightColor: "transparent"
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={grounding.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <circle cx="12" cy="12" r="3"/><path d="M12 1v6M12 17v6M4.2 4.2l4.3 4.3M15.5 15.5l4.3 4.3M1 12h6M17 12h6M4.2 19.8l4.3-4.3M15.5 8.5l4.3-4.3"/>
          </svg>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace", fontSize: 9.5, color: PURPLE_BRIGHT, letterSpacing: "0.2em", textTransform: "uppercase" }}>How Vestige Read This</div>
            <div style={{ fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace", fontSize: 10.5, color: grounding.color, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", letterSpacing: "0.04em" }}>{grounding.label}</div>
          </div>
        </div>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "#4a4a5a", flexShrink: 0, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>▾</span>
      </button>
      {open && (
        <div style={{ padding: "0 18px 18px", animation: "fadeUp 0.2s ease" }}>
          <div style={{ height: 1, background: "rgba(255,255,255,0.05)", margin: "0 0 14px" }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {steps.map((s, i) => (
              <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0, paddingTop: 2 }}>
                  <div style={{ width: 7, height: 7, borderRadius: "50%", background: toneColor[s.tone] || "#888", opacity: 0.8 }} />
                  {i < steps.length - 1 && <div style={{ width: 1, height: 22, background: "rgba(255,255,255,0.08)", marginTop: 4 }} />}
                </div>
                <p style={{ fontSize: 13, color: "#9a9aa5", lineHeight: 1.6, margin: 0 }}>{s.text}</p>
              </div>
            ))}
          </div>
          {grounding.level === "cold" && (
            <p style={{ fontSize: 11, color: "#555", lineHeight: 1.6, margin: "14px 0 0", fontStyle: "italic" }}>
              As you log outcomes, reads like this stop being cold — Vestige starts judging it against what actually happened to you.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function InheritedWarning({ warnings, memory, onOpen }) {
  if (!warnings || warnings.length === 0) return null;
  return (
    <div style={{
      background: "linear-gradient(135deg, rgba(239,68,68,0.07), rgba(124,92,191,0.04))",
      border: "1px solid rgba(239,68,68,0.25)",
      borderLeft: "2px solid #ef4444",
      borderRadius: 2, padding: "22px 22px", marginBottom: 16
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        <div style={{ fontSize: 10, color: "#ef4444", letterSpacing: 4, fontWeight: 600, opacity: 0.9 }}>YOU'VE WALKED INTO THIS BEFORE</div>
      </div>
      <p style={{ fontSize: 12, color: "#7a5a5a", lineHeight: 1.6, margin: "0 0 16px" }}>This isn't a fresh risk. It matches a pattern that survived in your memory — inherited into this analysis.</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {warnings.map((w, i) => (
          <div key={i}>
            <p style={{ fontSize: 13.5, color: "#cfc0c0", lineHeight: 1.65, margin: "0 0 8px" }}>{w.fact}</p>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {(w.memberIds || []).slice(0, 5).map(id => {
                const m = memory.find(x => x.id === id);
                if (!m) return null;
                return (
                  <button key={id} onClick={() => onOpen(m)} style={{
                    background: "rgba(0,0,0,0.25)", border: "1px solid rgba(239,68,68,0.18)",
                    borderRadius: 6, padding: "5px 10px", cursor: "pointer", fontFamily: "inherit",
                    fontSize: 10.5, color: "#8a6a6a", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
                  }}>{(m.decision || m.summary || "").slice(0, 36)}</button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RecalledMemories({ recalled, onOpen }) {
  if (!recalled || recalled.length === 0) return null;
  const outcomeLabel = {
    proceeded_good: "proceeded · good", proceeded_bad: "proceeded · bad",
    modified: "modified", abandoned: "abandoned"
  };
  return (
    <div style={{
      background: "linear-gradient(135deg, rgba(94,212,212,0.05), rgba(124,92,191,0.04))",
      border: `1px solid ${CYAN}22`,
      borderLeft: `2px solid ${CYAN}88`,
      borderRadius: 2, padding: "22px 22px", marginBottom: 16
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={CYAN} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.8 }}>
          <path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/>
        </svg>
        <div style={{ fontSize: 10, color: CYAN, letterSpacing: 4, fontWeight: 600, opacity: 0.85 }}>YOU'VE BEEN HERE BEFORE</div>
      </div>
      <p style={{ fontSize: 12, color: "#555", lineHeight: 1.6, margin: "0 0 16px" }}>Related decisions Vestige remembers — and what actually happened.</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {recalled.map(e => (
          <button key={e.id} onClick={() => onOpen(e)} style={{
            textAlign: "left", background: "rgba(0,0,0,0.22)", border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: 2, padding: "13px 15px", cursor: "pointer", fontFamily: "inherit",
            transition: "all 0.2s", display: "flex", flexDirection: "column", gap: 6
          }}
          onMouseEnter={ev => { ev.currentTarget.style.borderColor = `${CYAN}44`; }}
          onMouseLeave={ev => { ev.currentTarget.style.borderColor = "rgba(255,255,255,0.06)"; }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
              <span style={{ fontSize: 12.5, color: "#999", lineHeight: 1.5, flex: 1 }}>{e.decision || e.summary}</span>
              <span style={{ fontSize: 15, fontWeight: 800, color: scoreColor(e.currentBrittleness || e.brittleness), flexShrink: 0, letterSpacing: "-0.02em" }}>{e.currentBrittleness || e.brittleness}</span>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 10, color: "#444" }}>{new Date(e.timestamp).toLocaleDateString("en-GB", { month: "short", year: "numeric" })}</span>
              {e.commitment && <span style={{ fontSize: 10, color: PURPLE_BRIGHT, opacity: 0.8 }}>· {({ proceed: "proceeded", modify: "modified", abandon: "abandoned", waiting: "held" })[e.commitment.move] || e.commitment.move}</span>}
              {e.postMortem && <span style={{ fontSize: 10, color: e.postMortem.triggered ? "#ef4444" : "#22c55e", opacity: 0.85 }}>· {outcomeLabel[e.postMortem.outcome] || "resolved"}{e.postMortem.triggered ? " · risk hit" : ""}</span>}
            </div>
            {e.lesson && (
              <div style={{ fontSize: 11.5, color: CYAN, opacity: 0.85, lineHeight: 1.5, fontStyle: "italic", marginTop: 2 }}>{e.lesson}</div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Cloud sync modal — sign in / out for cross-device sync ────────────────────
// ── Plans / upgrade ───────────────────────────────────────────────────────────
function PlanFeatureRow({ children, included }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 9 }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={included ? "#6ab88a" : "#444"} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
        {included ? <polyline points="20 6 9 17 4 12"/> : <line x1="5" y1="12" x2="19" y2="12"/>}
      </svg>
      <span style={{ fontSize: 12.5, color: included ? "#aaa" : "#555", lineHeight: 1.5 }}>{children}</span>
    </div>
  );
}

function PlanModal({ plan, usage, onClose, onUpgrade, onDowngrade }) {
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)",
        backdropFilter: "blur(20px)", border: `1px solid ${PURPLE}33`,
        borderRadius: 2, padding: "26px 24px", maxWidth: 460, width: "100%",
        maxHeight: "85vh", overflowY: "auto", animation: "fadeUp 0.2s ease"
      }}>
        <div style={{ fontSize: 10, color: PURPLE_BRIGHT, letterSpacing: 4, fontWeight: 600, marginBottom: 6, opacity: 0.8 }}>YOUR PLAN</div>
        <p style={{ fontSize: 13, color: "#777", lineHeight: 1.6, marginBottom: 20 }}>
          Vestige's depth — memory, principles, calibration, the hindsight gap — works on every plan. What the plan sets is how many fresh analyses you run each month.
        </p>

        {/* Free */}
        <div style={{ border: `1px solid ${plan === "free" ? PURPLE + "55" : "rgba(255,255,255,0.08)"}`, borderRadius: 2, padding: "18px 18px", marginBottom: 12, background: plan === "free" ? `${PURPLE}0d` : "transparent" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: "#ddd" }}>Free</span>
            <span style={{ fontSize: 13, color: "#666" }}>{plan === "free" ? "Current" : "£0"}</span>
          </div>
          <PlanFeatureRow included>{FREE_MONTHLY_ANALYSES} fresh analyses per month</PlanFeatureRow>
          <PlanFeatureRow included>Full memory, decay & recall</PlanFeatureRow>
          <PlanFeatureRow included>Principles, hindsight gap, calibration</PlanFeatureRow>
          <PlanFeatureRow included>Unlimited follow-up on past analyses</PlanFeatureRow>
        </div>

        {/* Pro */}
        <div style={{ border: `1px solid ${plan === "pro" ? "#d4b48355" : CYAN + "44"}`, borderRadius: 2, padding: "18px 18px", marginBottom: 18, background: plan === "pro" ? "rgba(212,180,131,0.06)" : `${CYAN}08` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>Pro</span>
            <span style={{ fontSize: 13, color: CYAN, fontWeight: 600 }}>{plan === "pro" ? "Current" : PRO_PRICE}</span>
          </div>
          <PlanFeatureRow included>Unlimited analyses, comparisons & simulations</PlanFeatureRow>
          <PlanFeatureRow included>Everything in Free</PlanFeatureRow>
          <PlanFeatureRow included>Priority on new capabilities</PlanFeatureRow>
        </div>

        {plan === "free" ? (
          <Btn variant="primary" onClick={onUpgrade} style={{ width: "100%", justifyContent: "center", display: "flex" }}>Upgrade to Pro — {PRO_PRICE}</Btn>
        ) : (
          <div style={{ display: "flex", gap: 10, justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "#6ab88a" }}>You're on Pro. Analyse freely.</span>
            <button onClick={onDowngrade} style={{ background: "none", border: "none", color: "#555", fontSize: 11, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}>Switch to Free</button>
          </div>
        )}
        <button onClick={onClose} style={{ marginTop: 16, width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#666", padding: "11px", borderRadius: 10, cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>Close</button>
      </div>
    </div>
  );
}

// Paywall — appears when a free user hits the monthly cap. Reflects their own
// accumulated record back at them: the engine they've built is the reason to keep it running.
function Paywall({ memory, usage, onUpgrade, onClose }) {
  const principleCount = derivePrinciples(memory).length;
  const closed = memory.filter(e => e.postMortem).length;
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(5px)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1100, padding: 20
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)",
        backdropFilter: "blur(20px)", border: `1px solid ${CYAN}33`,
        borderRadius: 2, padding: "28px 24px", maxWidth: 440, width: "100%", animation: "fadeUp 0.25s ease",
        boxShadow: `0 24px 80px rgba(0,0,0,0.6), 0 0 60px ${PURPLE}1a`
      }}>
        <div style={{ fontSize: 10, color: CYAN, letterSpacing: 4, fontWeight: 600, marginBottom: 14, opacity: 0.85 }}>MONTHLY ANALYSES USED</div>
        <h3 style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 26, fontWeight: 400, color: "#fff", lineHeight: 1.25, margin: "0 0 14px", letterSpacing: "-0.02em" }}>
          You've spent your {FREE_MONTHLY_ANALYSES} free analyses this month.
        </h3>
        <p style={{ fontSize: 13.5, color: "#999", lineHeight: 1.7, margin: "0 0 18px" }}>
          {memory.length > 0
            ? <>You've built {memory.length} decision{memory.length !== 1 ? "s" : ""} of memory{principleCount > 0 ? `, ${principleCount} earned principle${principleCount !== 1 ? "s" : ""}` : ""}{closed > 0 ? `, and closed ${closed} loop${closed !== 1 ? "s" : ""}` : ""}. That engine keeps running on every plan — Pro just lets you keep feeding it.</>
            : <>Pro removes the cap entirely — analyse, compare and simulate as much as you need.</>}
        </p>
        <div style={{ background: `${CYAN}0a`, border: `1px solid ${CYAN}22`, borderRadius: 2, padding: "14px 16px", marginBottom: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>Vestige Pro</span>
            <span style={{ fontSize: 14, color: CYAN, fontWeight: 600 }}>{PRO_PRICE}</span>
          </div>
          <p style={{ fontSize: 12, color: "#777", lineHeight: 1.5, margin: "8px 0 0" }}>Unlimited analyses, comparisons and simulations. Your free analyses reset next month.</p>
        </div>
        <Btn variant="primary" onClick={onUpgrade} style={{ width: "100%", justifyContent: "center", display: "flex", marginBottom: 10 }}>Upgrade to Pro</Btn>
        <button onClick={onClose} style={{ width: "100%", background: "none", border: "none", color: "#555", padding: "8px", cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>Maybe later — I'll wait for the reset</button>
      </div>
    </div>
  );
}

// ── Share modal — copy link + download image (both client-side, no backend) ───
function ShareModal({ target, onClose, showToast }) {
  const [copied, setCopied]   = useState(false);
  const [downloading, setDl]  = useState(false);
  const url = buildShareUrl(target);
  const payload = {
    d: target?.anatomy?.decision || target?.decision || target?.summary || "A decision",
    b: Math.max(0, Math.min(100, Math.round(Number(target?.brittleness ?? 0)))),
    v: target?.verdict || "",
    f: (Array.isArray(target?.failures) ? target.failures : []).slice(0, 3).map(x => ({ r: x?.role || "", m: x?.failure_mode || "" }))
  };

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true); showToast?.("Link copied");
      setTimeout(() => setCopied(false), 2000);
    } catch { showToast?.("Couldn't copy — long-press to copy the link"); }
  }
  async function downloadImage() {
    setDl(true);
    try {
      const dataUrl = await cardToPng(payload, 3);
      // Convert data URL → Blob (needed for both the share sheet and a reliable
      // object-URL download on mobile).
      const blob = await (await fetch(dataUrl)).blob();
      const file = new File([blob], "vestige-decision.png", { type: "image/png" });

      // iOS path: the native share sheet is the reliable way to save an image to
      // Photos/Files. Use it when the browser can share files.
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: "Vestige" });
          setDl(false);
          return;
        } catch (shareErr) {
          // User cancelled the share sheet, or it failed — fall through to download.
          if (shareErr?.name === "AbortError") { setDl(false); return; }
        }
      }

      // Desktop / Android path: object-URL download.
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "vestige-decision.png";
      a.target = "_blank";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      showToast?.("Image saved");
    } catch {
      showToast?.("Couldn't generate the image");
    }
    setDl(false);
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.72)", backdropFilter: "blur(6px)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1200, padding: 20, overflowY: "auto"
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)",
        border: `1px solid ${PURPLE}40`, borderRadius: 2, padding: "26px 24px",
        maxWidth: 480, width: "100%", animation: "fadeUp 0.25s ease",
        boxShadow: `0 30px 90px rgba(0,0,0,0.65)`
      }}>
        <h3 style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 23, fontWeight: 400, color: "#fff", margin: "0 0 6px", letterSpacing: "-0.01em" }}>
          Share this verdict
        </h3>
        <p style={{ fontSize: 12.5, color: "#999", lineHeight: 1.6, margin: "0 0 18px" }}>
          A read-only card with the score, verdict, and failure modes — nothing else from your account or history travels.
        </p>

        {/* Live preview */}
        <div style={{ transform: "scale(0.92)", transformOrigin: "top center", marginBottom: 8 }}>
          <SharedCard payload={payload} />
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 18, flexWrap: "wrap" }}>
          <Btn variant="primary" onClick={copyLink} style={{ flex: 1, minWidth: 140, justifyContent: "center", display: "flex" }}>
            {copied ? "Copied ✓" : "Copy link"}
          </Btn>
          <Btn variant="secondary" onClick={downloadImage} disabled={downloading} style={{ flex: 1, minWidth: 140, justifyContent: "center", display: "flex" }}>
            {downloading ? "Generating…" : "Download image"}
          </Btn>
        </div>
        <button onClick={onClose} style={{ marginTop: 14, width: "100%", background: "none", border: "none", color: "#555", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
          Close
        </button>
      </div>
    </div>
  );
}

// ── Auth gate — sign in to run an analysis (sells the tool, then the magic link)
function AuthGate({ onClose, onAuthed, showToast }) {
  const [email, setEmail]   = useState("");
  const [stage, setStage]   = useState("email"); // email | sent
  const [code, setCode]     = useState("");
  const [busy, setBusy]     = useState(false);
  const [err, setErr]       = useState("");

  async function sendLink() {
    const e = email.trim();
    const check = checkSignupEmail(e);
    if (!check.ok) { setErr(check.reason); return; }
    setBusy(true); setErr("");
    try { await cloudAuth.sendMagicLink(e); setStage("sent"); }
    catch (ex) { setErr(ex?.message || "Couldn't send the link. Try again."); }
    setBusy(false);
  }
  async function verify() {
    const c = code.trim();
    if (!c) { setErr("Enter the 6-digit code from your email."); return; }
    setBusy(true); setErr("");
    try {
      const user = await cloudAuth.verifyCode(email.trim(), c);
      onAuthed?.(user);
      showToast?.("Signed in");
      onClose?.();
    } catch (ex) { setErr(ex?.message || "That code didn't work. Check it and retry."); }
    setBusy(false);
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.72)", backdropFilter: "blur(6px)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1200, padding: 20
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)",
        backdropFilter: "blur(20px)", border: `1px solid ${PURPLE}40`,
        borderRadius: 2, padding: "30px 26px", maxWidth: 440, width: "100%",
        animation: "fadeUp 0.25s ease",
        boxShadow: `0 30px 90px rgba(0,0,0,0.65), 0 0 70px ${PURPLE}1f`
      }}>
        {/* Mark */}
        <svg width="40" height="40" viewBox="0 0 32 32" fill="none" style={{ marginBottom: 16, filter: `drop-shadow(0 0 12px ${PURPLE}66)` }}>
          <path d="M3 5 L16 27 L29 5" stroke={PURPLE_BRIGHT} strokeWidth="3.5" strokeLinecap="square" strokeLinejoin="miter" fill="none" />
          <circle cx="16" cy="16" r="3.2" fill={PURPLE_BRIGHT} />
        </svg>

        {stage === "email" ? (
          <>
            <h3 style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 26, fontWeight: 400, color: "#fff", lineHeight: 1.25, margin: "0 0 10px", letterSpacing: "-0.02em" }}>
              Sign in to run your analysis.
            </h3>
            <p style={{ fontSize: 13.5, color: "#999", lineHeight: 1.7, margin: "0 0 18px" }}>
              Vestige scores how brittle a decision is, argues the case against it from three angles, and remembers it — so your record sharpens every future call. Your decisions are saved to your account and sync across devices.
            </p>
            <input
              type="email" inputMode="email" autoComplete="email" placeholder="you@email.com"
              value={email} onChange={e => setEmail(e.target.value)}
              onKeyDown={e => e.key === "Enter" && sendLink()}
              style={{
                width: "100%", background: "rgba(0,0,0,0.3)", border: `1px solid ${PURPLE}33`,
                borderRadius: 10, padding: "13px 14px", color: "#fff", fontSize: 16,
                fontFamily: "inherit", marginBottom: 12, outline: "none"
              }}
            />
            {err && <p style={{ fontSize: 12, color: "#ef6a6a", margin: "0 0 12px" }}>{err}</p>}
            <Btn variant="primary" onClick={sendLink} disabled={busy} style={{ width: "100%", justifyContent: "center", display: "flex", marginBottom: 10 }}>
              {busy ? "Sending…" : "Email me a sign-in link"}
            </Btn>
            <p style={{ fontSize: 11, color: "#555", lineHeight: 1.5, margin: 0, textAlign: "center" }}>
              No password. We email you a one-tap link (and a code, if you prefer).
            </p>
          </>
        ) : (
          <>
            <h3 style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 24, fontWeight: 400, color: "#fff", lineHeight: 1.3, margin: "0 0 10px", letterSpacing: "-0.02em" }}>
              Check your email.
            </h3>
            <p style={{ fontSize: 13.5, color: "#999", lineHeight: 1.7, margin: "0 0 18px" }}>
              We sent a sign-in link to <span style={{ color: "#cbb8e8" }}>{email.trim()}</span>. Tap it to come straight back signed in — or enter the 6-digit code from that email here.
            </p>
            <input
              inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code"
              value={code} onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              onKeyDown={e => e.key === "Enter" && verify()}
              style={{
                width: "100%", background: "rgba(0,0,0,0.3)", border: `1px solid ${PURPLE}33`,
                borderRadius: 10, padding: "13px 14px", color: "#fff", fontSize: 16,
                fontFamily: "inherit", marginBottom: 12, outline: "none", letterSpacing: 4, textAlign: "center"
              }}
            />
            {err && <p style={{ fontSize: 12, color: "#ef6a6a", margin: "0 0 12px" }}>{err}</p>}
            <Btn variant="primary" onClick={verify} disabled={busy} style={{ width: "100%", justifyContent: "center", display: "flex", marginBottom: 10 }}>
              {busy ? "Verifying…" : "Verify & continue"}
            </Btn>
            <button onClick={() => { setStage("email"); setErr(""); setCode(""); }} style={{ width: "100%", background: "none", border: "none", color: "#666", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
              Use a different email
            </button>
          </>
        )}
        <button onClick={onClose} style={{ marginTop: 14, width: "100%", background: "none", border: "none", color: "#444", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
          Not now
        </button>
      </div>
    </div>
  );
}

function SyncModal({ user, syncState, onClose, onAuthed, showToast }) {
  const [mode, setMode]         = useState("signin"); // signin | signup
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy]         = useState(false);
  const [err, setErr]           = useState("");

  async function submit() {
    if (!email.trim() || !password) { setErr("Enter email and password"); return; }
    setBusy(true); setErr("");
    try {
      const u = mode === "signup"
        ? await cloudAuth.signUp(email.trim(), password)
        : await cloudAuth.signIn(email.trim(), password);
      onAuthed(u);
      showToast(mode === "signup" ? "Account created — syncing" : "Signed in — syncing");
      onClose();
    } catch (e) {
      setErr(e.message || "Authentication failed");
    }
    setBusy(false);
  }

  async function signOut() {
    setBusy(true);
    try { await cloudAuth.signOut(); onAuthed(null); showToast("Signed out — local only"); onClose(); }
    catch (e) { setErr(e.message || "Sign out failed"); }
    setBusy(false);
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)",
        backdropFilter: "blur(20px)", border: `1px solid ${CYAN}33`,
        borderRadius: 2, padding: "26px 24px", maxWidth: 420, width: "100%",
        animation: "fadeUp 0.2s ease"
      }}>
        <div style={{ fontSize: 10, color: CYAN, letterSpacing: 4, fontWeight: 600, marginBottom: 6, opacity: 0.85 }}>CLOUD SYNC</div>

        {user ? (
          <>
            <p style={{ fontSize: 15, color: "#bbb", lineHeight: 1.6, margin: "0 0 6px" }}>
              Synced as <span style={{ color: CYAN }}>{user.email}</span>
            </p>
            <p style={{ fontSize: 12, color: "#555", lineHeight: 1.6, marginBottom: 22 }}>
              Your decisions are backed up and sync across every device you sign in on.
              {syncState === "syncing" ? " Currently syncing…" : ""}
            </p>
            {err && <p style={{ fontSize: 12, color: "#e87878", marginBottom: 14 }}>{err}</p>}
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <Btn variant="ghost" onClick={onClose}>Close</Btn>
              <Btn variant="danger" onClick={signOut} disabled={busy}>{busy ? "..." : "Sign out"}</Btn>
            </div>
          </>
        ) : (
          <>
            <p style={{ fontSize: 13, color: "#777", lineHeight: 1.6, marginBottom: 20 }}>
              {mode === "signup" ? "Create an account" : "Sign in"} to back up your decisions and sync across devices. Your local history stays exactly as it is and merges in.
            </p>
            <input
              type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="Email" autoComplete="email"
              style={{ width: "100%", background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, padding: "12px 14px", color: "#ddd", fontSize: 14, fontFamily: "inherit", marginBottom: 10 }}
            />
            <input
              type="password" value={password} onChange={e => setPassword(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") submit(); }}
              placeholder="Password" autoComplete={mode === "signup" ? "new-password" : "current-password"}
              style={{ width: "100%", background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, padding: "12px 14px", color: "#ddd", fontSize: 14, fontFamily: "inherit", marginBottom: 14 }}
            />
            {err && <p style={{ fontSize: 12, color: "#e87878", marginBottom: 14 }}>{err}</p>}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <button onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setErr(""); }} style={{
                background: "none", border: "none", color: "#666", fontSize: 12, cursor: "pointer", fontFamily: "inherit", padding: 0, textDecoration: "underline"
              }}>{mode === "signup" ? "Have an account? Sign in" : "Need an account? Sign up"}</button>
              <div style={{ display: "flex", gap: 8 }}>
                <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
                <Btn variant="primary" onClick={submit} disabled={busy}>{busy ? "..." : mode === "signup" ? "Sign up" : "Sign in"}</Btn>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView]             = useState("landing");
  const [input, setInput]           = useState("");
  const [result, setResult]         = useState(null);
  const [recall, setRecall]         = useState([]);
  const [memory, setMemory]         = useState(() => loadMemory());
  const [cloudUser, setCloudUser]   = useState(null);
  const [syncState, setSyncState]   = useState("local"); // local | syncing | cloud
  const [showSync, setShowSync]     = useState(false);
  const [plan, setPlan]             = useState(() => getPlan());
  const [usage, setUsage]           = useState(() => getUsage());
  const [showPaywall, setShowPaywall] = useState(false);
  const [showPlans, setShowPlans]   = useState(false);
  const [showAuthGate, setShowAuthGate] = useState(false);
  const [shareTarget, setShareTarget] = useState(null);
  const [selected, setSelected]     = useState(null);
  const [stage, setStage]           = useState("");
  const [error, setError]           = useState("");
  const [animScore, setAnimScore]   = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [toast, setToast]           = useState("");
  const [patterns, setPatterns]     = useState(null);
  const [patternsLoading, setPatternsLoading] = useState(false);
  const [showPostMortem, setShowPostMortem]   = useState(false);
  const [compareA, setCompareA]               = useState("");
  const [compareB, setCompareB]               = useState("");
  const [compareResult, setCompareResult]     = useState(null);
  const [compareLoading, setCompareLoading]   = useState(false);
  const [calibration, setCalibration]         = useState(null);
  const [showCalibration, setShowCalibration] = useState(false);
  const [parentEntryId, setParentEntryId]     = useState(null);
  const [threadAnalysis, setThreadAnalysis]   = useState(null);
  const [threadLoading, setThreadLoading]     = useState(false);
  const [threadAnalysisEntryId, setThreadAnalysisEntryId] = useState(null);
  const [simulationDecision, setSimulationDecision] = useState("");
  const [simulationContext, setSimulationContext]   = useState("");
  const [simulationScenarios, setSimulationScenarios] = useState(["", "", ""]);
  const [simulationResults, setSimulationResults] = useState([]);
  const [simulationLoading, setSimulationLoading] = useState(false);
  const [insights, setInsights] = useState(null);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [lenses, setLenses] = useState(() => {
    try {
      const saved = localStorage.getItem("vestige-lenses-v1");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [lensResults, setLensResults] = useState(null);
  const [lensLoading, setLensLoading] = useState(false);
  const [showCreateLens, setShowCreateLens] = useState(false);
  const [newLensName, setNewLensName] = useState("");
  const [newLensPrompt, setNewLensPrompt] = useState("");
  const [newLensInstructions, setNewLensInstructions] = useState("");
  const [newLensExamples, setNewLensExamples] = useState("");
  const [lensApplicationTarget, setLensApplicationTarget] = useState(null);
  const [showIntro, setShowIntro]   = useState(() => {
    try { return !localStorage.getItem(ONBOARDING_KEY); } catch { return false; }
  });

  function dismissIntro() {
    try { localStorage.setItem(ONBOARDING_KEY, "1"); } catch {}
    setShowIntro(false);
  }

  // Swipe handlers only active in detail view
  const detailSwipe = useSwipe(
    null,
    () => { if (view === "detail") setView("history"); }
  );

  // Cloud sync: on mount, if configured + signed in, pull cloud decisions and
  // reconcile with local. Pure-local mode if not configured — nothing happens.
  useEffect(() => {
    if (!isCloudConfigured()) return;
    let unsub = () => {};
    (async () => {
      const user = await cloudAuth.getUser();
      setCloudUser(user);
      if (user) {
        setSyncState("syncing");
        try {
          const merged = await syncDown();
          if (merged) setMemory(applyDecay(merged));
          try { const pu = await syncPlanUsageDown(); setPlan(pu.plan); setUsage(pu.usage); } catch {}
          setSyncState("cloud");
        } catch { setSyncState("local"); }
      }
      unsub = await cloudAuth.onChange(async (u) => {
        setCloudUser(u);
        if (u) {
          setSyncState("syncing");
          try {
            const merged = await syncDown();
            if (merged) setMemory(applyDecay(merged));
            try { const pu = await syncPlanUsageDown(); setPlan(pu.plan); setUsage(pu.usage); } catch {}
            setSyncState("cloud");
          } catch { setSyncState("local"); }
        } else {
          setSyncState("local");
        }
      });
    })();
    return () => unsub();
  }, []);

  useEffect(() => {
    const titles = { landing: "Vestige - Decision Intelligence", analyse: "Vestige - New Analysis", loading: "Vestige - Analysing...", result: "Vestige - Your Result", history: "Vestige - History", detail: "Vestige - Analysis Detail", patterns: "Vestige - Patterns", compare: "Vestige - Compare", reviews: "Vestige - Reviews", landscape: "Vestige - Memory Landscape", openloops: "Vestige - Open Loops", evolution: "Vestige - How You're Changing", insights: "Vestige - Insights", lenses: "Vestige - Lenses", simulation: "Vestige - Simulation" };
    document.title = titles[view] || "Vestige";
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [view]);

  useEffect(() => {
    if (view === "result") setTimeout(() => setAnimScore(true), 600);
    else setAnimScore(false);
  }, [view]);

  function showToast(msg, ms = 2200) { setToast(msg); setTimeout(() => setToast(""), ms); }
  function goAnalyse(prefill = "", parentId = null) {
    setInput(prefill);
    setError("");
    setParentEntryId(parentId);
    setCalibration(null);
    setShowCalibration(false);
    setView("analyse");
  }

  function followOnFrom(entry) {
    setInput("");
    setError("");
    setParentEntryId(entry.id);
    setCalibration(null);
    setShowCalibration(false);
    setView("analyse");
    showToast("Following on from previous decision");
  }

  async function fetchPatterns() {
    if (memory.length < 3) {
      showToast("Need at least 3 analyses to find patterns");
      return;
    }
    setPatternsLoading(true);
    setPatterns(null);
    try {
      const compact = memory.map(e => ({
        decision: e.decision,
        archetype: e.archetype || "generic",
        stakes: e.stakes,
        brittleness: e.brittleness,
        failures: e.full?.failures?.map(f => ({ role: f.role, failure_mode: f.failure_mode })) || [],
        commitment: e.commitment ? { move: e.commitment.move, reviewDate: e.commitment.reviewDate || null } : null,
        postMortem: e.postMortem ? {
          outcome: e.postMortem.outcome,
          triggered: e.postMortem.triggered,
          accuracy: e.postMortem.accuracy
        } : null
      }));
      const res = await fetch("/api/patterns", {
        method: "POST",
        headers: await authedHeaders(),
        body: JSON.stringify({ decisions: compact })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setPatterns(data);
    } catch (e) {
      showToast("Pattern analysis failed");
    }
    setPatternsLoading(false);
  }

  // Revisiting a trace strengthens it (reinforcement). Returns updated memory.
  // A trace that has already lost its full data can be kept from fading further,
  // but its detail can't be reconstructed — it stays compressed.
  function reinforceEntry(entryId) {
    const updated = memory.map(e => {
      if (e.id !== entryId) return e;
      const imp = e.importance || importanceScore(e);
      const r = reinforce(e);
      return { ...r, strength: 1, retention: e.full ? retentionFromStrength(1, imp) : "compress" };
    });
    setMemory(updated);
    saveMemory(updated);
    if (selected && selected.id === entryId) setSelected(updated.find(e => e.id === entryId));
    return updated;
  }

  // Open a decision in detail and reinforce it (accessing memory strengthens it).
  function openDecision(entry) {
    const imp = entry.importance || importanceScore(entry);
    const r = reinforce(entry);
    const reinforced = { ...r, strength: 1, retention: entry.full ? retentionFromStrength(1, imp) : "compress" };
    const updated = memory.map(e => e.id === entry.id ? reinforced : e);
    setMemory(updated);
    saveMemory(updated);
    setSelected(reinforced);
    setView("detail");
  }

  function savePostMortem(entryId, pmData) {
    const updated = memory.map(e => {
      if (e.id !== entryId) return e;
      const withPm = { ...reinforce(e), postMortem: pmData };
      return { ...withPm, lesson: consolidateLesson(withPm), strength: 1, retention: retentionFromStrength(1, withPm.importance) };
    });
    setMemory(updated);
    saveMemory(updated);
    if (selected && selected.id === entryId) {
      setSelected(updated.find(e => e.id === entryId));
    }
    setShowPostMortem(false);
    showToast("Post-mortem saved · lesson consolidated");
  }

  function appendToThread(entryId, message) {
    const updated = memory.map(e => {
      if (e.id !== entryId) return e;
      // Engaging the conversation reinforces the trace.
      return { ...reinforce(e), thread: [...(e.thread || []), message], strength: 1, retention: retentionFromStrength(1, e.importance || importanceScore(e)) };
    });
    setMemory(updated);
    saveMemory(updated);
    if (selected && selected.id === entryId) {
      const updatedEntry = updated.find(e => e.id === entryId);
      setSelected(updatedEntry);
    }
  }

  function updateEntryBrittleness(entryId, newScore) {
    const updated = memory.map(e => {
      if (e.id !== entryId) return e;
      return { ...e, currentBrittleness: newScore };
    });
    setMemory(updated);
    saveMemory(updated);
    if (selected && selected.id === entryId) {
      setSelected({ ...selected, currentBrittleness: newScore });
    }
    if (result && result.entryId === entryId) {
      setResult({ ...result, currentBrittleness: newScore });
    }
  }

  function saveCommitment(entryId, commitmentData) {
    const updated = memory.map(e => e.id === entryId ? { ...e, commitment: commitmentData } : e);
    setMemory(updated);
    saveMemory(updated);
    if (selected && selected.id === entryId) {
      setSelected({ ...selected, commitment: commitmentData });
    }
    // Also update result if it matches
    if (result && result.entryId === entryId) {
      setResult({ ...result, commitment: commitmentData });
    }
    showToast("Commitment recorded");
  }

  async function fetchThreadAnalysis(entry) {
    if (!entry?.thread || entry.thread.length < 2) {
      showToast("Need conversation history to analyse");
      return;
    }
    setThreadLoading(true);
    setThreadAnalysis(null);
    setThreadAnalysisEntryId(entry.id);
    try {
      const compactEntry = {
        archetype: entry.archetype,
        stakes: entry.stakes,
        brittleness: entry.brittleness,
        currentBrittleness: entry.currentBrittleness,
        commitment: entry.commitment ? { move: entry.commitment.move } : null,
        thread: entry.thread
      };
      const res = await fetch("/api/thread-analysis", {
        method: "POST",
        headers: await authedHeaders(),
        body: JSON.stringify({ entry: compactEntry })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setThreadAnalysis(data);
    } catch (e) {
      showToast("Thread analysis failed - try again");
    }
    setThreadLoading(false);
  }

  // Clear thread analysis when switching between detail entries
  useEffect(() => {
    if (selected && threadAnalysisEntryId && selected.id !== threadAnalysisEntryId) {
      setThreadAnalysis(null);
      setThreadAnalysisEntryId(null);
    }
  }, [selected?.id]);

  function saveLensToLibrary(lensData) {
    const newLens = {
      id: Date.now(),
      name: lensData.name,
      prompt: lensData.prompt,
      instructions: lensData.instructions,
      examples: lensData.examples || "",
      createdAt: new Date().toISOString(),
      usageCount: 0
    };
    const updated = [...lenses, newLens];
    setLenses(updated);
    try {
      localStorage.setItem("vestige-lenses-v1", JSON.stringify(updated));
    } catch {
      showToast("Could not save lens");
    }
    setNewLensName("");
    setNewLensPrompt("");
    setNewLensInstructions("");
    setNewLensExamples("");
    setShowCreateLens(false);
    showToast(`Lens "${lensData.name}" created`);
    return newLens;
  }

  function deleteLens(lensId) {
    const updated = lenses.filter(l => l.id !== lensId);
    setLenses(updated);
    try {
      localStorage.setItem("vestige-lenses-v1", JSON.stringify(updated));
    } catch {
      showToast("Could not delete lens");
    }
    showToast("Lens deleted");
  }

  async function applyLensToDecision(lens, entry) {
    setLensLoading(true);
    setLensResults(null);
    try {
      const res = await fetch("/api/lenses", {
        method: "POST",
        headers: await authedHeaders(),
        body: JSON.stringify({
          decision: entry.decision,
          context: entry.full?.anatomy?.decision || "",
          lens: {
            name: lens.name,
            prompt: lens.prompt,
            instructions: lens.instructions,
            examples: lens.examples
          }
        })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setLensResults({ ...data, lensId: lens.id, entryId: entry.id });
      // Update lens usage count
      const updated = lenses.map(l => l.id === lens.id ? { ...l, usageCount: (l.usageCount || 0) + 1 } : l);
      setLenses(updated);
      try {
        localStorage.setItem("vestige-lenses-v1", JSON.stringify(updated));
      } catch {}
    } catch (e) {
      showToast("Lens analysis failed - try again");
    }
    setLensLoading(false);
  }

  async function generateInsights() {
    if (memory.length < 3) {
      showToast("Need at least 3 decisions to generate insights");
      return;
    }
    setInsightsLoading(true);
    setInsights(null);
    try {
      const compactHistory = memory.map(e => ({
        decision: e.decision,
        archetype: e.archetype,
        stakes: e.stakes,
        brittleness: e.brittleness,
        currentBrittleness: e.currentBrittleness,
        thread: e.thread || [],
        postMortem: e.postMortem || null,
        commitment: e.commitment || null
      }));
      const res = await fetch("/api/insights", {
        method: "POST",
        headers: await authedHeaders(),
        body: JSON.stringify({ history: compactHistory })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setInsights(data.insights);
    } catch (e) {
      showToast("Insight generation failed - try again");
    }
    setInsightsLoading(false);
  }

  async function runSimulation() {
    if (!simulationDecision || !simulationContext || !simulationScenarios.some(s => s.trim())) {
      showToast("Please provide a decision, context, and at least one scenario");
      return;
    }
    if (!requireSignedIn()) return;
    if (!canAnalyse()) return;
    setSimulationLoading(true);
    setSimulationResults([]);
    try {
      const scenarios = simulationScenarios.filter(s => s.trim());
      const data = await callApi("/api/simulate", {
        decision: simulationDecision.trim(),
        context: simulationContext.trim(),
        simulations: scenarios
      });
      recordAnalysis();
      setSimulationResults(data.simulations);
    } catch (e) {
      showToast(e.message || "Simulation failed - try again");
    }
    setSimulationLoading(false);
  }

  async function runCompare() {
    if (!compareA.trim() || !compareB.trim()) return;
    if (!requireSignedIn()) return;
    if (!canAnalyse()) return;
    setCompareLoading(true);
    setCompareResult(null);
    try {
      const data = await callApi("/api/compare", { decisionA: compareA.trim(), decisionB: compareB.trim() });
      recordAnalysis();
      setCompareResult(data);
    } catch (e) {
      showToast(e.message || "Comparison failed - try again");
    }
    setCompareLoading(false);
  }

  // Freemium volume cap. Returns true if the action may proceed; otherwise shows
  // the paywall and returns false. Pro is effectively unlimited.
  // Build request headers including the auth token (delegates to the shared
  // module-level helper).
  async function apiHeaders() {
    return authedHeaders();
  }

  // Sign-in gate. When cloud auth is configured (a public launch), analysis
  // requires an account — this stops anonymous endpoint abuse and ties usage to
  // a real identity (so clearing localStorage can't reset the cap). When cloud
  // isn't configured (local/dev), it's a no-op and the app runs open.
  function requireSignedIn() {
    if (!isCloudConfigured()) return true;   // no auth backend → gate off
    if (cloudUser) return true;              // already signed in
    setShowAuthGate(true);                   // otherwise, prompt sign-in
    return false;
  }

  function canAnalyse() {
    if (plan === "pro") return true;
    const u = getUsage(); // re-read for monthly rollover
    if (u.month !== usage.month) setUsage(u);
    if (u.analyses >= FREE_MONTHLY_ANALYSES) { setShowPaywall(true); return false; }
    return true;
  }
  async function recordAnalysis() {
    const u = await incrementUsage();
    setUsage(u);
  }

  async function run() {
    if (!input.trim()) return;
    if (!requireSignedIn()) return;
    if (!canAnalyse()) return;
    setView("loading"); setError(""); setStage("Reading your decision...");
    const stages = ["Dissecting the decision...", "Running adversarial agents...", "Scoring brittleness...", "Writing the verdict..."];
    let si = 0;
    const iv = setInterval(() => { si = (si + 1) % stages.length; setStage(stages[si]); }, 2200);
    try {
      const profile = buildDecisionProfile(memory, input.trim());
      const data = await callApi("/api/analyse", { decision: input.trim(), profile: profile.text });
      clearInterval(iv);
      recordAnalysis();
      data.calibrated = Boolean(profile.text);
      // Refine cluster matches now that we know the archetype (feed-forward).
      const refinedMatches = matchClustersToDecision(detectResidueClusters(memory), input.trim(), data.anatomy?.archetype);
      data.inheritedWarnings = (refinedMatches.length ? refinedMatches : profile.matches).map(c => ({
        kind: c.kind, fact: c.fact, why: c.why, count: c.members.length,
        memberIds: c.members.map(m => m.id)
      }));
      const importance = importanceScore({ stakes: data.anatomy?.stakes, brittleness: data.brittleness, full: data });
      const entryId = Date.now();
      const initialThread = [
        {
          role: "user",
          type: "decision",
          content: input.trim(),
          timestamp: new Date().toISOString()
        },
        {
          role: "vestige",
          type: "analysis",
          brittleness: data.brittleness,
          verdict: data.verdict,
          timestamp: new Date().toISOString()
        }
      ];
      const entry = {
        id: entryId, timestamp: new Date().toISOString(),
        decision: data.anatomy?.decision || input.slice(0, 100),
        stakes: data.anatomy?.stakes, brittleness: data.brittleness,
        currentBrittleness: data.brittleness,
        archetype: data.anatomy?.archetype || "generic",
        verdict: data.verdict, full: data,
        importance, retention: retentionClass(importance),
        postMortem: null,
        commitment: null,
        thread: initialThread,
        parentId: parentEntryId,
        relatedIds: [],
        calibration: calibration
      };
      data.entryId = entryId;

      // Update parent's relatedIds
      let updated = [...memory, entry];
      if (parentEntryId) {
        updated = updated.map(e => e.id === parentEntryId
          ? { ...e, relatedIds: [...(e.relatedIds || []), entryId] }
          : e
        );
      }
      // Reset parent tracking after use
      setParentEntryId(null);
      setCalibration(null);
      // Active recall: surface related past traces (memory informing the present).
      setRecall(findRecall(memory, entry));
      setMemory(updated); saveMemory(updated); setResult(data); setView("result");
    } catch(e) { clearInterval(iv); setError(e.message || "Analysis failed - try again"); setView("analyse"); }
  }

  function exportResult(r) {
    if (!r) return;
    const txt = ["VESTIGE - DECISION ANALYSIS", "=".repeat(48), "", r.anatomy?.decision, "", `Stakes: ${r.anatomy?.stakes} | Type: ${r.anatomy?.decision_type}`, "", "FAILURE MODES", ...(r.failures || []).flatMap(f => [`\n[${roleLabels[f.role] || f.role}] ${f.failure_mode}`, f.argument, `Trigger: ${f.trigger}`]), "", "=".repeat(48), `Risk Exposure: ${r.brittleness}/100 - ${scoreLabel(r.brittleness)}`, "", "VERDICT", r.verdict, "", `Vestige - ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([txt], { type: "text/plain" }));
    a.download = `vestige-${Date.now()}.txt`; a.click();
    showToast("Report exported");
  }

  function shareResult(r) {
    if (!r) return;
    const text = [
      `Vestige Analysis`,
      `Decision: ${r.anatomy?.decision}`,
      `Risk Score: ${r.brittleness}/100 - ${scoreLabel(r.brittleness)}`,
      ``,
      `Verdict: ${r.verdict}`,
      ``,
      `Analysed with Vestige - vestige.app`
    ].join("\n");
    if (navigator.share) {
      navigator.share({ title: "Vestige Analysis", text }).catch(() => {});
    } else {
      navigator.clipboard.writeText(text).then(() => showToast("Copied to clipboard"));
    }
  }

  // Reviews due — commitments with a reviewDate that has passed or is within 7 days, no post-mortem yet
  const now = Date.now();
  const reviewsDue = memory
    .filter(e => e.commitment?.reviewDate && !e.postMortem)
    .map(e => {
      const due = new Date(e.commitment.reviewDate).getTime();
      const daysFromNow = Math.round((due - now) / 86400000);
      return { ...e, daysFromNow };
    })
    .filter(e => e.daysFromNow <= 7)
    .sort((a, b) => a.daysFromNow - b.daysFromNow);

  // Open loops — decisions committed to and never closed, now old enough that
  // the outcome should be known. The neglected ones, distinct from scheduled reviews.
  const openLoops = findOpenLoops(memory, now);
  const followThrough = computeFollowThrough(memory, now);

  const examples = [
    "I want to raise prices by 40% and accept losing some clients.",
    "Should I take on a business partner to scale faster?",
    "I'm thinking about shutting down a revenue stream to focus.",
    "Should I let my highest-paid employee go to cut costs?",
  ];

  const SH = { fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace", fontSize: 10, color: "#7a7a8c", letterSpacing: "0.2em", fontWeight: 500, textTransform: "uppercase", marginBottom: 16, padding: "0 2px" };
  const iconBtn = {
    background: "transparent", border: "none", color: "#444",
    width: 40, height: 40, borderRadius: 10, cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center",
    transition: "all 0.2s", WebkitTapHighlightColor: "transparent",
    fontFamily: "inherit"
  };

  return (
    <div style={{ background: "#08080d", minHeight: "100vh", color: "#fff", fontFamily: "'Inter', system-ui, sans-serif", position: "relative", overflowX: "hidden" }}>

      {/* Ambient grid texture */}
      <div style={{
        position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0,
        backgroundImage: `linear-gradient(rgba(124,92,191,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(124,92,191,0.03) 1px, transparent 1px)`,
        backgroundSize: "60px 60px",
        opacity: 0.5
      }} />

      {/* Vignette */}
      <div style={{
        position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0,
        background: "radial-gradient(ellipse at center, transparent 0%, rgba(0,0,0,0.4) 100%)"
      }} />
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=Instrument+Serif:ital@0;1&display=swap');
        @keyframes fadeUp  { from{opacity:0;transform:translateY(18px)} to{opacity:1;transform:translateY(0)} }
        @keyframes glow    { 0%,100%{opacity:.5} 50%{opacity:1} }
        @keyframes pulse   { 0%,100%{opacity:1} 50%{opacity:.2} }
        @keyframes spin    { to{transform:rotate(360deg)} }
        @keyframes shimmer { 0%{background-position:200% center} 100%{background-position:-200% center} }
        @keyframes countUp { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        @keyframes ambientFloat { 0%,100%{ transform: translate(0,0) } 33%{ transform: translate(20px,-30px) } 66%{ transform: translate(-15px,15px) } }
        @keyframes slowPulse { 0%,100%{opacity:.15} 50%{opacity:.35} }
        @keyframes cardLift { from{opacity:0;transform:translateY(20px)} to{opacity:1;transform:translateY(0)} }
        *, *::before, *::after { box-sizing:border-box; margin:0; padding:0 }
        html, body { -webkit-text-size-adjust:100%; text-size-adjust:100%; touch-action: pan-x pan-y; }
        body { overscroll-behavior:none; -webkit-overflow-scrolling:touch }
        ::selection { background:${PURPLE}66; color:#fff }
        textarea, input { font-size:16px !important }
        textarea:focus, input:focus { outline:none }
        textarea::placeholder, input::placeholder { color:#2a2a3a }
        button { -webkit-tap-highlight-color:transparent; touch-action:manipulation }
        /* Mobile: hidden scrollbars for clean look. Desktop (fine pointer): slim
           visible scrollbar so users can see there's more to scroll. */
        @media (hover: none) and (pointer: coarse) {
          ::-webkit-scrollbar { display:none }
          * { scrollbar-width:none; -ms-overflow-style:none }
        }
        @media (hover: hover) and (pointer: fine) {
          ::-webkit-scrollbar { width:10px; height:10px }
          ::-webkit-scrollbar-track { background:transparent }
          ::-webkit-scrollbar-thumb { background:rgba(124,92,191,0.3); border-radius:0; border:2px solid #08080d }
          ::-webkit-scrollbar-thumb:hover { background:rgba(124,92,191,0.5) }
          * { scrollbar-width:thin; scrollbar-color:rgba(124,92,191,0.3) transparent }
        }
        button:focus-visible { outline:2px solid ${PURPLE}; outline-offset:2px }
        button:focus:not(:focus-visible) { outline:none }
        p, span { word-break:break-word; overflow-wrap:break-word }

        /* V mark interactivity - feels alive */
        .vestige-mark:hover .vestige-svg { filter: drop-shadow(0 0 24px ${PURPLE}aa) !important; }
        .vestige-mark:active { transform: scale(0.96); }
        .vestige-mark:hover circle { animation: nodeGlow 1.4s ease infinite; }
        @keyframes nodeGlow { 0%,100% { opacity: 1; } 50% { opacity: 0.5; transform-origin: center; } }

        /* Decay visualisation on history entries */
        .decay-compress { animation: decayPulse 4s ease infinite; }

        /* Forensic button reticle — corner brackets that draw inward on hover,
           like a targeting instrument acquiring a control. Distinct, on-theme. */
        .v-reticle { position: relative; }
        .v-reticle::before, .v-reticle::after {
          content: ""; position: absolute; width: 7px; height: 7px;
          border-color: currentColor; opacity: 0; transition: all 0.22s cubic-bezier(0.16,1,0.3,1);
          pointer-events: none;
        }
        .v-reticle::before { top: 3px; left: 3px; border-top: 1.5px solid; border-left: 1.5px solid; transform: translate(4px,4px); }
        .v-reticle::after  { bottom: 3px; right: 3px; border-bottom: 1.5px solid; border-right: 1.5px solid; transform: translate(-4px,-4px); }
        .v-reticle:hover::before, .v-reticle:hover::after { opacity: 0.7; transform: translate(0,0); }

        /* Score readout: faint live scanline that drifts, like a calibrating gauge */
        .v-readout-scan {
          position: absolute; left: 0; right: 0; height: 1px;
          background: linear-gradient(90deg, transparent, ${PURPLE}55, transparent);
          animation: scanDrift 4.5s ease-in-out infinite; pointer-events: none; opacity: 0.5;
        }
        @keyframes scanDrift { 0%,100% { top: 18%; opacity: 0.15; } 50% { top: 82%; opacity: 0.5; } }
        @keyframes decayPulse {
          0%,100% { opacity: 0.5; }
          50% { opacity: 0.35; }
        }
      `}</style>

      {/* NAV */}
      <nav style={{
        position: "fixed", top: 0, left: 0, right: 0, zIndex: 100,
        padding: "var(--safe-top) 24px 0", minHeight: 68,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        background: "rgba(8,8,13,0.85)",
        backdropFilter: "blur(20px) saturate(180%)",
        WebkitBackdropFilter: "blur(20px) saturate(180%)",
        borderBottom: "1px solid rgba(255,255,255,0.04)"
      }}>
        <button onClick={() => setView("landing")} aria-label="Vestige home" className="vestige-mark"
          style={{
            background: "none", border: "none", cursor: "pointer",
            fontFamily: "inherit", WebkitTapHighlightColor: "transparent",
            minHeight: 44, display: "flex", alignItems: "center", gap: 12,
            padding: "0 4px 0 0", transition: "transform 0.3s ease",
            flexShrink: 0
          }}>
          {/* Logo mark - geometric V intersecting with a circle (decision + observation) */}
          <svg width="44" height="44" viewBox="0 0 32 32" fill="none" className="vestige-svg" style={{ flexShrink: 0, filter: `drop-shadow(0 0 12px ${PURPLE}66)`, transition: "filter 0.4s ease" }}>
            <defs>
              <linearGradient id="logoGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#ffffff" />
                <stop offset="100%" stopColor={PURPLE_BRIGHT} />
              </linearGradient>
            </defs>
            <path d="M3 5 L16 27 L29 5" stroke="url(#logoGrad)" strokeWidth="3.5" strokeLinecap="square" strokeLinejoin="miter" fill="none" />
            <circle cx="16" cy="16" r="3.2" fill={PURPLE_BRIGHT} />
          </svg>
          {/* Wordmark - Instrument Serif, the typeface Anthropic uses for Claude */}
          <span style={{
            fontFamily: "'Instrument Serif', Georgia, serif",
            fontSize: 20,
            fontWeight: 400,
            color: "#fff",
            letterSpacing: "-0.01em",
            lineHeight: 1,
            marginTop: 1,
            whiteSpace: "nowrap"
          }}>
            Vestige
          </span>
        </button>
        <div className="nav-cluster" style={{ display: "flex", gap: 8, alignItems: "center", overflowX: "auto", maxWidth: "calc(100% - 130px)", flexShrink: 1, minWidth: 0 }}>
          {lenses.length > 0 && <Btn variant="secondary" onClick={() => setView("lenses")} style={{ fontSize: 12, padding: "8px 14px", minHeight: 36, display: "flex", alignItems: "center", gap: 6, flexShrink: 0, whiteSpace: "nowrap" }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
            Lenses ({lenses.length})
          </Btn>}
          {reviewsDue.length > 0 && (
            <button onClick={() => setView("reviews")} aria-label={`${reviewsDue.length} reviews due`} style={{
              background: `${PURPLE}22`, border: `1px solid ${PURPLE}55`,
              color: PURPLE_BRIGHT, fontSize: 12, fontWeight: 700,
              padding: "8px 12px", borderRadius: 8, cursor: "pointer",
              fontFamily: "inherit", WebkitTapHighlightColor: "transparent",
              minHeight: 36, display: "flex", alignItems: "center", gap: 6, flexShrink: 0,
              transition: "all 0.2s"
            }}
            onMouseEnter={e => { e.currentTarget.style.background = `${PURPLE}33`; }}
            onMouseLeave={e => { e.currentTarget.style.background = `${PURPLE}22`; }}
            >
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: PURPLE_BRIGHT, boxShadow: `0 0 6px ${PURPLE_BRIGHT}`, animation: "pulse 2s ease infinite" }} />
              {reviewsDue.length}
            </button>
          )}
          {(() => {
            const reviewIds = new Set(reviewsDue.map(r => r.id));
            const neglected = openLoops.filter(l => !reviewIds.has(l.id));
            if (neglected.length === 0) return null;
            return (
              <button onClick={() => setView("openloops")} aria-label={`${neglected.length} open loops`} title="Decisions you committed to but never closed" style={{
                background: "rgba(249,115,22,0.14)", border: "1px solid rgba(249,115,22,0.4)",
                color: "#f0a060", fontSize: 12, fontWeight: 700,
                padding: "8px 12px", borderRadius: 8, cursor: "pointer",
                fontFamily: "inherit", WebkitTapHighlightColor: "transparent",
                minHeight: 36, display: "flex", alignItems: "center", gap: 6, flexShrink: 0, transition: "all 0.2s"
              }}
              onMouseEnter={e => { e.currentTarget.style.background = "rgba(249,115,22,0.22)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "rgba(249,115,22,0.14)"; }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" opacity="0"/><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
                {neglected.length} open
              </button>
            );
          })()}
          {isCloudConfigured() && (
            <button onClick={() => setShowSync(true)} aria-label="Cloud sync" title={cloudUser ? `Synced as ${cloudUser.email}` : "Sync across devices"} style={{
              background: cloudUser ? `${CYAN}18` : "transparent",
              border: `1px solid ${cloudUser ? CYAN + "55" : "rgba(255,255,255,0.12)"}`,
              color: cloudUser ? CYAN : "#666",
              fontSize: 12, fontWeight: 600, padding: "8px 12px", borderRadius: 8,
              cursor: "pointer", fontFamily: "inherit", WebkitTapHighlightColor: "transparent",
              minHeight: 36, display: "flex", alignItems: "center", gap: 6, transition: "all 0.2s"
            }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>
              </svg>
              {syncState === "syncing" ? "Syncing" : cloudUser ? "Synced" : "Sync"}
            </button>
          )}
          {memory.length > 0 && <Btn variant="secondary" onClick={() => setView("history")} style={{ fontSize: 12, padding: "8px 14px", minHeight: 36, flexShrink: 0, whiteSpace: "nowrap" }}>History ({memory.length})</Btn>}
          {plan === "free" ? (
            <button onClick={() => setShowPlans(true)} title={`${Math.max(0, FREE_MONTHLY_ANALYSES - usage.analyses)} of ${FREE_MONTHLY_ANALYSES} analyses left this month`} style={{
              background: "transparent", border: "1px solid rgba(255,255,255,0.1)",
              color: usage.analyses >= FREE_MONTHLY_ANALYSES ? "#f0a060" : "#777",
              fontSize: 12, fontWeight: 600, padding: "8px 12px", borderRadius: 8, cursor: "pointer",
              fontFamily: "inherit", WebkitTapHighlightColor: "transparent", minHeight: 36,
              display: "flex", alignItems: "center", gap: 7, flexShrink: 0, transition: "all 0.2s"
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.22)"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.1)"; }}
            >
              <span style={{ display: "flex", gap: 3 }}>
                {Array.from({ length: FREE_MONTHLY_ANALYSES }).map((_, i) => (
                  <span key={i} style={{ width: 5, height: 5, borderRadius: "50%", background: i < usage.analyses ? "rgba(255,255,255,0.12)" : PURPLE_BRIGHT, transition: "all 0.3s" }} />
                ))}
              </span>
              {Math.max(0, FREE_MONTHLY_ANALYSES - usage.analyses)} left
            </button>
          ) : (
            <button onClick={() => setShowPlans(true)} title="Vestige Pro" style={{
              background: "rgba(212,180,131,0.1)", border: "1px solid rgba(212,180,131,0.35)",
              color: "#d4b483", fontSize: 11, fontWeight: 700, letterSpacing: 1, padding: "8px 12px",
              borderRadius: 8, cursor: "pointer", fontFamily: "inherit", WebkitTapHighlightColor: "transparent",
              minHeight: 36, display: "flex", alignItems: "center", gap: 5, flexShrink: 0
            }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2l2.4 7.4H22l-6 4.6 2.3 7.4-6.3-4.6L5.7 21l2.3-7.4-6-4.6h7.6z"/></svg>
              PRO
            </button>
          )}
          {view !== "landing" && <Btn variant="primary" onClick={() => goAnalyse()} style={{ fontSize: 12, padding: "8px 16px", minHeight: 36, flexShrink: 0 }}>New</Btn>}
        </div>
      </nav>

      <div aria-live="polite" aria-atomic="true" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0,0,0,0)", whiteSpace: "nowrap" }}>{stage}</div>
      <Toast msg={toast} />
      {showSync && (
        <SyncModal
          user={cloudUser}
          syncState={syncState}
          onClose={() => setShowSync(false)}
          onAuthed={u => { setCloudUser(u); if (!u) setSyncState("local"); }}
          showToast={showToast}
        />
      )}

      {shareTarget && (
        <ShareModal target={shareTarget} onClose={() => setShareTarget(null)} showToast={showToast} />
      )}

      {showAuthGate && (
        <AuthGate
          onClose={() => setShowAuthGate(false)}
          onAuthed={u => { setCloudUser(u); setShowAuthGate(false); }}
          showToast={showToast}
        />
      )}

      {showPaywall && (
        <Paywall
          memory={memory}
          usage={usage}
          onClose={() => setShowPaywall(false)}
          onUpgrade={() => { setShowPaywall(false); setShowPlans(true); }}
        />
      )}

      {showPlans && (
        <PlanModal
          plan={plan}
          usage={usage}
          onClose={() => setShowPlans(false)}
          onUpgrade={async () => {
            // PAYMENT INTEGRATION POINT: this is where Stripe Checkout opens.
            // On a real successful payment, the webhook/return flips the plan.
            // The entitlement mechanic below is real, enforced, and cloud-synced.
            await setPlanStore("pro"); setPlan("pro");
            setShowPlans(false);
            showToast("You're on Pro — analyse freely");
          }}
          onDowngrade={async () => { await setPlanStore("free"); setPlan("free"); showToast("Switched to Free"); }}
        />
      )}

      {/* LANDING */}
      {view === "landing" && (
        <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", animation: "fadeUp 0.4s ease", paddingTop: "calc(96px + var(--safe-top))", touchAction: "pan-y", overflowX: "hidden" }}>

          <div style={{ maxWidth: 480, width: "100%", padding: "0 24px 100px", textAlign: "left", position: "relative" }}>

            {/* Ambient background orbs */}
            <div style={{ position: "absolute", top: 40, left: -60, width: 300, height: 300, borderRadius: "50%", background: `radial-gradient(circle, ${PURPLE}22 0%, transparent 70%)`, filter: "blur(40px)", animation: "ambientFloat 18s ease-in-out infinite", pointerEvents: "none", zIndex: 0 }} />
            <div style={{ position: "absolute", top: 200, right: -80, width: 280, height: 280, borderRadius: "50%", background: `radial-gradient(circle, ${CYAN}11 0%, transparent 70%)`, filter: "blur(50px)", animation: "ambientFloat 22s ease-in-out infinite reverse", pointerEvents: "none", zIndex: 0 }} />

            <div style={{ position: "relative", zIndex: 1 }}>

              {/* First-visit hint card — mockup style (cyan eyebrow, X top-right) */}
              {showIntro && (
                <div className="v-glass" style={{
                  borderRadius: 2,
                  padding: "16px",
                  marginBottom: 32,
                  position: "relative",
                  animation: "fadeUp 0.6s ease 0.05s both"
                }}>
                  <button onClick={dismissIntro} aria-label="Dismiss intro" style={{
                    position: "absolute", top: 14, right: 14,
                    background: "transparent", border: "none", color: "rgba(255,255,255,0.4)",
                    cursor: "pointer", padding: 0, lineHeight: 0,
                    WebkitTapHighlightColor: "transparent",
                    transition: "color 0.2s"
                  }}
                  onMouseEnter={e => e.currentTarget.style.color = "#fff"}
                  onMouseLeave={e => e.currentTarget.style.color = "rgba(255,255,255,0.4)"}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                  <div style={{ fontSize: 10, color: CYAN, letterSpacing: "0.2em", fontWeight: 500, textTransform: "uppercase", marginBottom: 8 }}>First time here?</div>
                  <p style={{ fontSize: 14, color: "rgba(255,255,255,0.8)", lineHeight: 1.6, margin: 0, fontWeight: 300, paddingRight: 24 }}>
                    Describe a decision. Vestige will tell you where it breaks, not why it works.
                  </p>
                </div>
              )}

              {/* Headline — mockup serif, left-aligned */}
              <h1 style={{
                fontFamily: "'Instrument Serif', Georgia, serif",
                fontSize: "clamp(44px, 14vw, 56px)",
                fontWeight: 400,
                lineHeight: 0.95,
                letterSpacing: "-0.02em",
                marginBottom: 32,
                color: "#fff",
                animation: "fadeUp 0.7s ease .1s both"
              }}>
                Stop wasting time thinking about why you're{" "}
                <span style={{
                  fontStyle: "italic",
                  paddingRight: 8,
                  background: "linear-gradient(135deg, #9B7FD4 0%, #5ED4D4 50%, #9B7FD4 100%)",
                  backgroundSize: "200% auto",
                  WebkitBackgroundClip: "text",
                  backgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                  color: "transparent",
                  animation: "shimmer 6s linear infinite"
                }}>right.</span>
              </h1>

              <p style={{
                fontSize: 15,
                color: "rgba(255,255,255,0.6)",
                lineHeight: 1.6,
                marginBottom: 48,
                fontWeight: 300,
                maxWidth: 290,
                animation: "fadeUp 0.7s ease .2s both"
              }}>
                Vestige <span style={{ color: "#fff", fontWeight: 500 }}>assumes you're wrong</span> and finds out where. Three adversarial agents. A brittleness score. A verdict with no hedging.
              </p>

              {/* Index — three items as a vertical list (serif number, circular icon, heading, hairline dividers) */}
              <div style={{ marginBottom: 48 }}>
                {[
                  { num: "01", color: PURPLE_BRIGHT, label: "Three agents attack from different angles", icon: (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/>
                      <line x1="8" y1="7.5" x2="10.5" y2="16"/><line x1="16" y1="7.5" x2="13.5" y2="16"/><line x1="8" y1="6" x2="16" y2="6"/>
                    </svg>
                  ) },
                  { num: "02", color: CYAN, label: "A brittleness score reveals structural risk", icon: (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 2 L4 6 V12 C4 16.5 7.5 20.5 12 22 C16.5 20.5 20 16.5 20 12 V6 Z"/>
                      <path d="M9 11 L11 13 L15 9" />
                    </svg>
                  ) },
                  { num: "03", color: "rgba(255,255,255,0.7)", label: "A verdict that doesn't soften the truth", icon: (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 12 L9 6 L21 18" /><path d="M14 11 L21 4" /><line x1="3" y1="22" x2="12" y2="22"/>
                    </svg>
                  ) },
                ].map(({ num, color, label, icon }, i) => (
                  <div key={num} style={{
                    display: "flex", gap: 20,
                    animation: `fadeUp 0.6s ease ${0.25 + i * 0.1}s both`
                  }}>
                    <div style={{ paddingTop: 4 }}>
                      <span style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 18, color: "rgba(255,255,255,0.3)" }}>{num}</span>
                    </div>
                    <div style={{
                      flex: 1,
                      paddingBottom: i < 2 ? 24 : 0,
                      borderBottom: i < 2 ? "1px solid rgba(255,255,255,0.05)" : "none",
                      marginBottom: i < 2 ? 24 : 0
                    }}>
                      <div style={{
                        width: 32, height: 32, borderRadius: "50%",
                        background: "rgba(255,255,255,0.05)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        marginBottom: 16, color
                      }}>{icon}</div>
                      <h3 style={{ fontSize: 15, color: "rgba(255,255,255,0.9)", lineHeight: 1.35, margin: 0, fontWeight: 400 }}>{label}</h3>
                    </div>
                  </div>
                ))}
              </div>

              {/* Input */}
              <div style={{ animation: "fadeUp 0.7s ease .55s both", marginBottom: 24 }}>
                <DecisionInput value={input} onChange={setInput} onSubmit={run} placeholder="Describe what you're about to commit to. The stakes, the context, what's pulling you toward it." />
              </div>

              {/* Examples */}
              <p className="v-eyebrow" style={{ color: "rgba(255,255,255,0.3)", margin: "32px 0 14px", animation: "fadeUp 0.7s ease .6s both" }}>Or run one of these</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, animation: "fadeUp 0.7s ease .65s both" }}>
                {examples.map((ex, i) => (
                  <button key={i} onClick={() => goAnalyse(ex)} style={{
                    background: "rgba(13,13,22,0.6)",
                    backdropFilter: "blur(10px)",
                    WebkitBackdropFilter: "blur(10px)",
                    border: "1px solid rgba(255,255,255,0.06)",
                    color: "#444", fontSize: 13.5, fontWeight: 400,
                    padding: "15px 20px", borderRadius: 2, cursor: "pointer",
                    fontFamily: "inherit", textAlign: "left",
                    transition: "all 0.25s", lineHeight: 1.5,
                    WebkitTapHighlightColor: "transparent", minHeight: 48
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = "rgba(18,18,28,0.8)"; e.currentTarget.style.borderColor = "rgba(124,92,191,0.25)"; e.currentTarget.style.color = "#888"; e.currentTarget.style.transform = "translateX(4px)"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "rgba(13,13,22,0.6)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.06)"; e.currentTarget.style.color = "#444"; e.currentTarget.style.transform = "translateX(0)"; }}
                  onPointerDown={e => e.currentTarget.style.opacity = "0.7"}
                  onPointerUp={e => e.currentTarget.style.opacity = "1"}
                  >{ex}</button>
                ))}
              </div>

              {/* Version badge */}
              <div className="v-version">Vestige · v1.0</div>
            </div>
          </div>
        </div>
      )}

      {/* ANALYSE */}
      {view === "analyse" && (
        <div style={{ maxWidth: 680, margin: "0 auto", padding: "124px 24px 80px", animation: "fadeUp 0.4s ease" }}>
          <div style={{ fontSize: 10, color: PURPLE_BRIGHT, letterSpacing: 4, fontWeight: 600, marginBottom: 10, opacity: 0.7 }}>NEW ANALYSIS</div>
          <h2 style={{
            fontFamily: "'Instrument Serif', Georgia, serif",
            fontSize: "clamp(34px, 5vw, 44px)", fontWeight: 400,
            letterSpacing: "-0.02em", marginBottom: 12, color: "#fff",
            lineHeight: 1.1
          }}>What are you about to do?</h2>
          <p style={{ fontSize: 15, color: "#555", marginBottom: 18, lineHeight: 1.7 }}>
            Don't sanitise it. The more honest you are, the harder Vestige can push back.
          </p>
          <button onClick={() => setView("compare")} style={{
            background: "transparent", border: `1px solid ${CYAN}33`, color: CYAN,
            fontSize: 11, fontWeight: 600, letterSpacing: 1.5,
            padding: "8px 14px", borderRadius: 8, cursor: "pointer",
            fontFamily: "inherit", WebkitTapHighlightColor: "transparent",
            marginBottom: 28, display: "inline-flex", alignItems: "center", gap: 6,
            transition: "all 0.2s"
          }}
          onMouseEnter={e => { e.currentTarget.style.background = `${CYAN}11`; }}
          onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
            </svg>
            COMPARE TWO OPTIONS
          </button>
          {!calibration && !showCalibration && (
            <button onClick={() => setShowCalibration(true)} style={{
              background: "transparent", border: `1px solid ${CYAN}33`, color: CYAN,
              fontSize: 11, fontWeight: 600, letterSpacing: 1.5,
              padding: "8px 14px", borderRadius: 8, cursor: "pointer",
              fontFamily: "inherit", WebkitTapHighlightColor: "transparent",
              marginBottom: 28, marginLeft: 8, display: "inline-flex", alignItems: "center", gap: 6,
              transition: "all 0.2s"
            }}
            onMouseEnter={e => { e.currentTarget.style.background = `${CYAN}11`; }}
            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              CALIBRATE STAKES FIRST
            </button>
          )}
          {calibration && (
            <div style={{
              background: `${CYAN}11`, border: `1px solid ${CYAN}33`,
              borderRadius: 8, padding: "10px 14px", marginBottom: 20,
              fontSize: 11, color: CYAN, display: "flex", alignItems: "center", gap: 10
            }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              Stakes calibrated. Vestige will factor this in.
              <button onClick={() => setCalibration(null)} style={{ marginLeft: "auto", background: "none", border: "none", color: CYAN, fontSize: 11, cursor: "pointer", opacity: 0.6, fontFamily: "inherit", padding: 0 }}>clear</button>
            </div>
          )}
          {parentEntryId && (
            <div style={{
              background: `${PURPLE}11`, border: `1px solid ${PURPLE}33`,
              borderRadius: 8, padding: "10px 14px", marginBottom: 20,
              fontSize: 11, color: PURPLE_BRIGHT, display: "flex", alignItems: "center", gap: 10
            }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12 L21 12"/><polyline points="14 5 21 12 14 19"/></svg>
              Follow-on from: {(memory.find(m => m.id === parentEntryId) || {}).decision?.slice(0, 60)}...
              <button onClick={() => setParentEntryId(null)} style={{ marginLeft: "auto", background: "none", border: "none", color: PURPLE_BRIGHT, fontSize: 11, cursor: "pointer", opacity: 0.6, fontFamily: "inherit", padding: 0 }}>unlink</button>
            </div>
          )}
          {showCalibration && (
            <StakesCalibration
              onContinue={cal => { setCalibration(cal); setShowCalibration(false); }}
              onSkip={() => setShowCalibration(false)}
            />
          )}
          {error && (
            <div style={{
              background: "linear-gradient(135deg, rgba(40,8,8,0.5), rgba(30,8,12,0.4))",
                      border: "1px solid rgba(220,60,60,0.25)",
              borderRadius: 2, padding: "14px 18px",
              marginBottom: 24, fontSize: 13, color: "#e87878",
              lineHeight: 1.6, display: "flex", alignItems: "flex-start", gap: 10
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2, opacity: 0.7 }}>
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <span>{error}</span>
            </div>
          )}
          <DecisionInput value={input} onChange={setInput} onSubmit={run} autoFocus rows={8} placeholder="Describe what you're about to commit to. The stakes, the context, what's pulling you toward it." />
        </div>
      )}

      {/* LOADING */}
      {view === "loading" && (
        <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 36, padding: "0 24px", animation: "fadeUp 0.3s ease", position: "relative" }}>
          {/* Atmospheric backdrop */}
          <div style={{ position: "absolute", inset: 0, background: `radial-gradient(circle at center, ${PURPLE}18 0%, transparent 60%)`, filter: "blur(60px)", pointerEvents: "none" }} />

          {/* Three agent indicators - representing the adversarial agents */}
          <div style={{ display: "flex", gap: 18, position: "relative", zIndex: 1, alignItems: "center" }}>
            {["DEVIL'S ADVOCATE", "PESSIMIST", "BLIND SPOT"].map((label, i) => (
              <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
                <div style={{
                  width: 12, height: 12, borderRadius: "50%",
                  background: `linear-gradient(135deg, ${PURPLE}, ${PURPLE_BRIGHT})`,
                  boxShadow: `0 0 24px ${PURPLE}88, 0 0 8px ${PURPLE_BRIGHT}`,
                  animation: `pulse 1.6s ease infinite`,
                  animationDelay: `${i * 0.25}s`
                }} />
                <span style={{
                  fontSize: 8, color: "#333", letterSpacing: 2.5,
                  fontWeight: 600, animation: `pulse 1.6s ease infinite`,
                  animationDelay: `${i * 0.25}s`
                }}>{label}</span>
              </div>
            ))}
          </div>

          <div style={{
            fontFamily: "'Instrument Serif', Georgia, serif",
            fontSize: 20, color: "#888", fontWeight: 400,
            fontStyle: "italic", textAlign: "center",
            letterSpacing: "-0.01em",
            position: "relative", zIndex: 1
          }}>{stage}</div>
        </div>
      )}

      {/* RESULT */}
      {view === "result" && result && (
        <div style={{ maxWidth: 720, margin: "0 auto", padding: "calc(104px + var(--safe-top)) 20px calc(80px + var(--safe-bottom))", animation: "fadeUp 0.5s ease", position: "relative" }}>
          {/* Page-level atmospheric glow tinted by score colour */}
          {animScore && (
            <div style={{
              position: "fixed", top: -200, left: "50%", transform: "translateX(-50%)",
              width: "120%", height: 600, pointerEvents: "none", zIndex: 0,
              background: `radial-gradient(ellipse 50% 50% at 50% 30%, ${scoreColor(result.brittleness)}11 0%, transparent 70%)`,
              filter: "blur(60px)",
              transition: "opacity 1.5s ease"
            }} />
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, position: "relative", zIndex: 1, flexWrap: "wrap" }}>
            <span style={{ fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace", fontSize: 10, color: PURPLE_BRIGHT, letterSpacing: "0.2em", textTransform: "uppercase", display: "inline-flex", alignItems: "center", gap: 7 }}><span style={{ width: 5, height: 5, borderRadius: "50%", background: scoreColor(result.brittleness), boxShadow: `0 0 8px ${scoreColor(result.brittleness)}` }} />Case Open</span>
            {result.calibrated && (
              <span title="This analysis was tuned to your decision history" style={{
                display: "inline-flex", alignItems: "center", gap: 5,
                fontSize: 9, color: CYAN, letterSpacing: 2, fontWeight: 700,
                padding: "3px 8px", background: `${CYAN}11`, border: `1px solid ${CYAN}33`, borderRadius: 5
              }}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>
                CALIBRATED TO YOU
              </span>
            )}
          </div>
          <ScoreBar brittleness={result.brittleness} animate={animScore} />
          <ReasoningTrace memory={memory} result={result} />
          <AnatomyCard anatomy={result.anatomy} />
          <ArchetypeContext archetype={result.anatomy?.archetype} context={result.anatomy?.archetype_context} />
          <InheritedWarning warnings={result.inheritedWarnings} memory={memory} onOpen={openDecision} />
          <RecalledMemories recalled={recall} onOpen={openDecision} />

          <div style={{ marginBottom: 12 }}>
            <div style={SH}>WHERE IT BREAKS</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {result.failures?.map((f, i) => (
                <FailureCard key={i} f={f} i={i} analysisContext={{ decision: result.anatomy?.decision, stakes: result.anatomy?.stakes, anatomy: result.anatomy, brittleness: result.brittleness, failures: result.failures, verdict: result.verdict }} />
              ))}
            </div>
          </div>

          <div style={{
            borderLeft: `2px solid ${PURPLE}`,
            padding: "4px 0 4px 18px", marginBottom: 24
          }}>
            <div style={{ fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace", fontSize: 9.5, color: PURPLE_BRIGHT, letterSpacing: "0.22em", textTransform: "uppercase", marginBottom: 12 }}>The Verdict</div>
            <p style={{
              fontFamily: "'Instrument Serif', Georgia, serif",
              fontSize: 21, color: "#dcdce4", lineHeight: 1.4,
              margin: 0, fontWeight: 400
            }}>{result.verdict}</p>
          </div>

          {/* Signals - what would change your mind */}
          <SignalsCard signals={result.signals} />

          {/* Commitment - your move */}
          {result.entryId && (
            <CommitmentBlock
              entry={memory.find(m => m.id === result.entryId) || { id: result.entryId, archetype: result.anatomy?.archetype, full: result, commitment: result.commitment }}
              onCommit={data => saveCommitment(result.entryId, data)}
              memory={memory}
              onOpen={openDecision}
            />
          )}

          {/* Follow-up conversation */}
          <FollowUp
            key={result.entryId}
            analysisContext={{ decision: result.anatomy?.decision, stakes: result.anatomy?.stakes, anatomy: result.anatomy, brittleness: result.brittleness, failures: result.failures, verdict: result.verdict }}
            existingThread={memory.find(m => m.id === result.entryId)?.thread || []}
            onAppendMessage={msg => result.entryId && appendToThread(result.entryId, msg)}
            onUpdateBrittleness={score => result.entryId && updateEntryBrittleness(result.entryId, score)}
          />

          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            gap: 12, flexWrap: "wrap", marginTop: 28,
            padding: "20px 0 0", borderTop: "1px solid rgba(255,255,255,0.04)"
          }}>
            <Btn variant="primary" onClick={() => goAnalyse()}>New Analysis</Btn>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <Btn variant="secondary" onClick={() => setShareTarget(result)} style={{ fontSize: 12, padding: "8px 14px", display: "flex", alignItems: "center", gap: 6 }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                Share
              </Btn>
              <button onClick={() => { setInput(result.anatomy?.decision || ""); setView("analyse"); }}
                title="Edit and re-run" aria-label="Edit and re-run"
                style={iconBtn}
                onMouseEnter={e => { e.currentTarget.style.color = "#aaa"; e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
                onMouseLeave={e => { e.currentTarget.style.color = "#444"; e.currentTarget.style.background = "transparent"; }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
              <button onClick={() => exportResult(result)}
                title="Export report" aria-label="Export report"
                style={iconBtn}
                onMouseEnter={e => { e.currentTarget.style.color = "#aaa"; e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
                onMouseLeave={e => { e.currentTarget.style.color = "#444"; e.currentTarget.style.background = "transparent"; }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              </button>
              <button onClick={() => shareResult(result)}
                title="Share" aria-label="Share"
                style={iconBtn}
                onMouseEnter={e => { e.currentTarget.style.color = "#aaa"; e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
                onMouseLeave={e => { e.currentTarget.style.color = "#444"; e.currentTarget.style.background = "transparent"; }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
              </button>
              <button onClick={() => result.entryId && followOnFrom({ id: result.entryId, decision: result.anatomy?.decision })}
                title="Follow-on decision" aria-label="Follow-on decision"
                style={iconBtn}
                onMouseEnter={e => { e.currentTarget.style.color = "#aaa"; e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
                onMouseLeave={e => { e.currentTarget.style.color = "#444"; e.currentTarget.style.background = "transparent"; }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12 L21 12"/><polyline points="14 5 21 12 14 19"/></svg>
              </button>
              <button onClick={() => setView("history")}
                title="View history" aria-label="View history"
                style={iconBtn}
                onMouseEnter={e => { e.currentTarget.style.color = "#aaa"; e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
                onMouseLeave={e => { e.currentTarget.style.color = "#444"; e.currentTarget.style.background = "transparent"; }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* HISTORY */}
      {view === "history" && (
        <div style={{ maxWidth: 680, margin: "0 auto", padding: "calc(104px + var(--safe-top)) 20px calc(80px + var(--safe-bottom))", animation: "fadeUp 0.4s ease" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 36 }}>
            <div>
              <div style={{ fontSize: 10, color: PURPLE_BRIGHT, letterSpacing: 4, fontWeight: 600, marginBottom: 10, opacity: 0.7 }}>MEMORY</div>
              <h2 style={{
                fontFamily: "'Instrument Serif', Georgia, serif",
                fontSize: "clamp(34px, 5vw, 44px)", fontWeight: 400,
                letterSpacing: "-0.02em", color: "#fff", marginBottom: 8,
                lineHeight: 1.1
              }}>History</h2>
              <p style={{ fontSize: 13, color: "#444", letterSpacing: "0.02em" }}>{memory.length} decision{memory.length !== 1 ? "s" : ""} retained</p>
              {memory.length >= 1 && (
                <button onClick={() => setView("landscape")} style={{
                  marginTop: 14, marginRight: 8, background: "transparent",
                  border: `1px solid ${PURPLE_BRIGHT}44`, color: PURPLE_BRIGHT,
                  fontSize: 11, fontWeight: 600, letterSpacing: 1.5,
                  padding: "8px 14px", borderRadius: 8, cursor: "pointer",
                  fontFamily: "inherit", WebkitTapHighlightColor: "transparent",
                  transition: "all 0.2s", display: "inline-flex", alignItems: "center", gap: 6
                }}
                onMouseEnter={e => { e.currentTarget.style.background = `${PURPLE_BRIGHT}11`; }}
                onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="4" y1="20" x2="4" y2="12"/><line x1="10" y1="20" x2="10" y2="8"/><line x1="16" y1="20" x2="16" y2="14"/><line x1="22" y1="20" x2="22" y2="16"/>
                  </svg>
                  MEMORY LANDSCAPE
                </button>
              )}
              {memory.length >= 3 && (
                <>
                  <button onClick={() => setView("insights")} style={{
                    marginTop: 14, background: "transparent",
                    border: `1px solid ${CYAN}44`, color: CYAN,
                    fontSize: 11, fontWeight: 600, letterSpacing: 1.5,
                    padding: "8px 14px", borderRadius: 8, cursor: "pointer",
                    fontFamily: "inherit", WebkitTapHighlightColor: "transparent",
                    transition: "all 0.2s", display: "inline-flex", alignItems: "center", gap: 6,
                    marginRight: 8
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = `${CYAN}11`; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    </svg>
                    DISCOVER INSIGHTS
                  </button>
                  <button onClick={() => { fetchPatterns(); setView("patterns"); }} style={{
                    marginTop: 14, background: "transparent",
                    border: `1px solid ${PURPLE}44`, color: PURPLE_BRIGHT,
                    fontSize: 11, fontWeight: 600, letterSpacing: 1.5,
                    padding: "8px 14px", borderRadius: 8, cursor: "pointer",
                    fontFamily: "inherit", WebkitTapHighlightColor: "transparent",
                    transition: "all 0.2s", display: "inline-flex", alignItems: "center", gap: 6
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = `${PURPLE}11`; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="10"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/>
                    </svg>
                    ANALYSE PATTERNS
                  </button>
                </>
              )}
            </div>
            {memory.length > 0 && !confirmClear && <Btn variant="danger" onClick={() => setConfirmClear(true)} style={{ fontSize: 12, padding: "8px 14px", whiteSpace: "nowrap", flexShrink: 0 }}>Clear all</Btn>}
          </div>
          {confirmClear && <InlineConfirm message="This will permanently delete all analysis history." onConfirm={() => { setMemory([]); cloudClearAll(); setConfirmClear(false); }} onCancel={() => setConfirmClear(false)} />}

          {memory.length === 0 ? (
            <div style={{ textAlign: "center", padding: "100px 20px" }}>
              {/* Empty state mark - faded V */}
              <svg width="64" height="64" viewBox="0 0 32 32" fill="none" style={{ margin: "0 auto 28px", opacity: 0.15 }}>
                <path d="M3 5 L16 27 L29 5" stroke={PURPLE_BRIGHT} strokeWidth="3" strokeLinecap="square" strokeLinejoin="miter" fill="none" />
                <circle cx="16" cy="16" r="3" fill={PURPLE_BRIGHT} />
              </svg>
              <p style={{
                fontFamily: "'Instrument Serif', Georgia, serif",
                fontSize: 22, color: "#444", marginBottom: 10,
                fontWeight: 400, fontStyle: "italic"
              }}>No analyses yet</p>
              <p style={{ fontSize: 13, color: "#2a2a3a", marginBottom: 32, lineHeight: 1.6 }}>
                Your decision history will live here.<br />
                Every analysis. Every verdict. Decaying naturally over time.
              </p>
              <Btn variant="primary" onClick={() => goAnalyse()}>Run your first analysis</Btn>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[...memory].reverse().map((e, idx) => (
                <div key={e.id} onClick={() => openDecision(e)}
                  className={e.retention === "compress" ? "decay-compress" : ""}
                  style={{
                    background: e.retention === "compress"
                      ? "linear-gradient(135deg, rgba(10,10,18,0.4), rgba(12,10,20,0.3))"
                      : e.retention === "partial"
                      ? "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)"
                      : "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)",
                                  WebkitBackdropFilter: "blur(14px)",
                    border: e.retention === "compress"
                      ? "1px dashed rgba(255,255,255,0.04)"
                      : "1px solid rgba(255,255,255,0.05)",
                    borderRadius: 2, padding: "18px 20px",
                    cursor: "pointer", transition: "all 0.25s",
                    WebkitTapHighlightColor: "transparent",
                    opacity: e.retention === "compress" ? 0.55 : e.retention === "partial" ? 0.85 : 1,
                    filter: e.retention === "compress" ? "saturate(0.4)" : "none"
                  }}
                  onMouseEnter={ev => { ev.currentTarget.style.background = "linear-gradient(135deg, rgba(18,16,28,0.8), rgba(20,16,32,0.6))"; ev.currentTarget.style.borderColor = "rgba(124,92,191,0.2)"; ev.currentTarget.style.transform = "translateX(2px)"; }}
                  onMouseLeave={ev => { ev.currentTarget.style.background = "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)"; ev.currentTarget.style.borderColor = "rgba(255,255,255,0.05)"; ev.currentTarget.style.transform = "translateX(0)"; }}
                  onPointerDown={ev => ev.currentTarget.style.opacity = "0.7"}
                  onPointerUp={ev => ev.currentTarget.style.opacity = "1"}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 14, marginBottom: 8 }}>
                    <span style={{ fontSize: 13, color: e.retention === "compress" ? "#2a2a3a" : "#555", lineHeight: 1.5, flex: 1, fontStyle: e.retention === "compress" ? "italic" : "normal" }}>
                      {e.summary || e.decision}
                    </span>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", flexShrink: 0, gap: 2 }}>
                      <span style={{ fontSize: 22, fontWeight: 800, color: e.retention === "compress" ? "#2a2a3a" : scoreColor(e.currentBrittleness || e.brittleness), letterSpacing: "-0.03em" }}>
                        {e.currentBrittleness || e.brittleness}
                      </span>
                      {e.currentBrittleness && e.currentBrittleness !== e.brittleness && (
                        <span style={{ fontSize: 9, color: "#444", letterSpacing: 1 }}>
                          was {e.brittleness}
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontSize: 11, color: "#1e1e28" }}>{new Date(e.timestamp).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</span>
                    {e.stakes && <span style={{ fontSize: 11, color: "#1e1e28" }}>· {e.stakes}</span>}
                    {e.thread && e.thread.filter(m => m.type === "message" || m.type === "vestige_reply").length > 0 && (
                      <span style={{ fontSize: 11, color: PURPLE_BRIGHT, opacity: 0.7, display: "flex", alignItems: "center", gap: 4 }}>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                        {e.thread.filter(m => m.type === "message" || m.type === "vestige_reply").length}
                      </span>
                    )}
                    {e.parentId && (
                      <span style={{ fontSize: 11, color: CYAN, opacity: 0.6 }}>· follow-on</span>
                    )}
                    <span style={{ marginLeft: "auto" }}>
                      <RetentionBadge retention={e.retention} importance={e.importance} strength={e.strength} accessCount={e.accessCount} fresh={idx === 0} />
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* DETAIL */}
      {view === "detail" && selected && (
        <div {...detailSwipe} style={{ maxWidth: 720, margin: "0 auto", padding: "100px 20px 80px", animation: "fadeUp 0.4s ease" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
            <button onClick={() => setView("history")} style={{
              background: "transparent", border: "1px solid rgba(255,255,255,0.06)",
              color: "#666", fontSize: 12, fontWeight: 500,
              padding: "8px 14px", borderRadius: 8, cursor: "pointer",
              fontFamily: "inherit", WebkitTapHighlightColor: "transparent",
              display: "flex", alignItems: "center", gap: 6,
              transition: "all 0.2s"
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.15)"; e.currentTarget.style.color = "#aaa"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.06)"; e.currentTarget.style.color = "#666"; }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
              History
            </button>
            <div style={{ display: "flex", gap: 8 }}>
              {selected.full && selected.thread && selected.thread.filter(m => m.type === "message" || m.type === "vestige_reply").length >= 2 && (
                <button onClick={() => fetchThreadAnalysis(selected)} disabled={threadLoading} style={{
                  background: threadAnalysis && threadAnalysisEntryId === selected.id ? `${PURPLE_BRIGHT}22` : "transparent",
                  border: `1px solid ${PURPLE_BRIGHT}44`, color: PURPLE_BRIGHT,
                  fontSize: 12, fontWeight: 600, padding: "8px 14px", borderRadius: 8,
                  cursor: threadLoading ? "wait" : "pointer", fontFamily: "inherit",
                  WebkitTapHighlightColor: "transparent",
                  transition: "all 0.2s", display: "flex", alignItems: "center", gap: 6,
                  opacity: threadLoading ? 0.6 : 1
                }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                  Analyse thread
                </button>
              )}
              {selected.full && lenses.length > 0 && (
                <button onClick={() => setLensApplicationTarget(selected)} style={{
                  background: "transparent", border: `1px solid ${CYAN}44`, color: CYAN,
                  fontSize: 12, fontWeight: 600, padding: "8px 14px", borderRadius: 8,
                  cursor: "pointer", fontFamily: "inherit", WebkitTapHighlightColor: "transparent",
                  transition: "all 0.2s", display: "flex", alignItems: "center", gap: 6
                }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
                  Apply lens
                </button>
              )}
              {selected.full && (
                <button onClick={() => followOnFrom(selected)} style={{
                  background: "transparent", border: `1px solid ${CYAN}44`, color: CYAN,
                  fontSize: 12, fontWeight: 600, padding: "8px 14px", borderRadius: 8,
                  cursor: "pointer", fontFamily: "inherit", WebkitTapHighlightColor: "transparent",
                  transition: "all 0.2s", display: "flex", alignItems: "center", gap: 6
                }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12 L21 12"/><polyline points="14 5 21 12 14 19"/></svg>
                  Follow-on
                </button>
              )}
              {selected.full && !selected.postMortem && !showPostMortem && (
                <button onClick={() => setShowPostMortem(true)} style={{
                  background: `${PURPLE}22`, border: `1px solid ${PURPLE}55`, color: PURPLE_BRIGHT,
                  fontSize: 12, fontWeight: 600, padding: "8px 14px", borderRadius: 8,
                  cursor: "pointer", fontFamily: "inherit", WebkitTapHighlightColor: "transparent",
                  transition: "all 0.2s"
                }}>Post-mortem</button>
              )}
              {selected.full && <Btn variant="secondary" onClick={() => exportResult(selected.full)} style={{ fontSize: 12, padding: "8px 14px" }}>Export</Btn>}
              {selected.full && <Btn variant="secondary" onClick={() => setShareTarget({ ...selected.full, timestamp: selected.timestamp })} style={{ fontSize: 12, padding: "8px 14px" }}>Share</Btn>}
            </div>
          </div>

          {showPostMortem && selected.full && (
            <PostMortemPrompt
              entry={selected}
              onSubmit={pm => savePostMortem(selected.id, pm)}
              onSkip={() => setShowPostMortem(false)}
            />
          )}

          {selected.postMortem && (
            <div style={{
              background: "linear-gradient(135deg, rgba(34,197,94,0.06), rgba(124,92,191,0.04))",
              border: "1px solid rgba(34,197,94,0.18)",
              borderRadius: 2, padding: "18px 20px", marginBottom: 20
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <div style={{ fontSize: 10, color: "#22c55e", letterSpacing: 4, fontWeight: 600, opacity: 0.8 }}>POST-MORTEM RECORDED</div>
                <div style={{ display: "flex", gap: 2 }}>
                  {[1,2,3,4,5].map(n => (
                    <div key={n} style={{ width: 6, height: 6, borderRadius: "50%", background: n <= selected.postMortem.accuracy ? PURPLE_BRIGHT : "rgba(255,255,255,0.08)" }} />
                  ))}
                </div>
              </div>
              <div style={{ fontSize: 13, color: "#aaa", marginBottom: 6 }}>
                <span style={{ color: "#666" }}>Outcome:</span> {({
                  proceeded_good: "Proceeded · Good outcome",
                  proceeded_bad: "Proceeded · Bad outcome",
                  modified: "Modified the plan",
                  abandoned: "Abandoned"
                })[selected.postMortem.outcome] || selected.postMortem.outcome}
              </div>
              <div style={{ fontSize: 13, color: "#aaa", marginBottom: selected.postMortem.notes ? 10 : 0 }}>
                <span style={{ color: "#666" }}>Flagged risk triggered:</span> {selected.postMortem.triggered ? "Yes" : "No"}
              </div>
              {typeof selected.postMortem.hindsightGap === "number" && Math.abs(selected.postMortem.hindsightGap) >= 8 && (
                <div style={{ fontSize: 12.5, color: "#8a8a95", marginTop: 10, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.04)", lineHeight: 1.6 }}>
                  <span style={{ color: CYAN, opacity: 0.8 }}>Hindsight:</span> at review you remembered this as {selected.postMortem.recalledBrittleness}; it was scored {selected.brittleness} — your memory ran {selected.postMortem.hindsightGap > 0 ? "high" : "low"} by {Math.abs(selected.postMortem.hindsightGap)}.
                </div>
              )}
              {selected.postMortem.notes && (
                <p style={{ fontSize: 12, color: "#777", lineHeight: 1.7, margin: "10px 0 0", paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.04)", fontStyle: "italic" }}>{selected.postMortem.notes}</p>
              )}
            </div>
          )}

          {!selected.full ? (
            <div style={{ textAlign: "center", padding: "60px 20px" }}>
              <div style={{ fontSize: 10, color: "#1e1e2e", letterSpacing: 4, marginBottom: 24 }}>MEMORY COMPRESSED</div>
              <p style={{ fontSize: 14, color: "#2a2a3a", marginBottom: 12, lineHeight: 1.6 }}>The episode has faded. This is what remains.</p>
              <p style={{ fontSize: 13, color: "#1a1a28", lineHeight: 1.7, fontStyle: "italic" }}>{selected.summary}</p>
              {selected.lesson && (
                <div style={{ maxWidth: 420, margin: "24px auto 0", padding: "14px 18px", background: `${CYAN}0a`, border: `1px solid ${CYAN}22`, borderRadius: 2 }}>
                  <div style={{ fontSize: 9, color: CYAN, letterSpacing: 3, fontWeight: 600, marginBottom: 8, opacity: 0.7 }}>LESSON RETAINED</div>
                  <p style={{ fontSize: 13, color: "#7fb8b8", lineHeight: 1.6, fontStyle: "italic", margin: 0 }}>{selected.lesson}</p>
                </div>
              )}
              <p style={{ fontSize: 11, color: "#141420", marginTop: 24, lineHeight: 1.6 }}>Low-importance traces fade over time.</p>
              <div style={{ marginTop: 16 }}>
                <Btn variant="secondary" onClick={() => { reinforceEntry(selected.id); showToast("Trace reinforced"); }}>Revisit to strengthen</Btn>
              </div>
              {(() => {
                const pushbacks = (selected.thread || []).filter(m => m.type === "message" || m.type === "vestige_reply");
                if (pushbacks.length === 0) return null;
                return (
                  <div style={{ maxWidth: 560, margin: "32px auto 0", textAlign: "left" }}>
                    <div style={{ fontSize: 9, color: PURPLE_BRIGHT, letterSpacing: 3, fontWeight: 600, marginBottom: 12, opacity: 0.6, textAlign: "center" }}>
                      CONVERSATION PRESERVED · {pushbacks.filter(m => m.role !== "vestige").length} pushback{pushbacks.filter(m => m.role !== "vestige").length !== 1 ? "s" : ""}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {pushbacks.map((m, i) => (
                        <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: m.role === "vestige" ? "flex-start" : "flex-end" }}>
                          <div style={{
                            maxWidth: "85%",
                            background: m.role === "vestige" ? "rgba(15,15,24,0.6)" : `${PURPLE}1a`,
                            border: `1px solid ${m.role === "vestige" ? "rgba(255,255,255,0.05)" : PURPLE + "22"}`,
                            borderRadius: m.role === "vestige" ? "12px 12px 12px 3px" : "12px 12px 3px 12px",
                            padding: "10px 14px"
                          }}>
                            <p style={{ fontSize: 12.5, color: m.role === "vestige" ? "#555" : "#888", lineHeight: 1.65, margin: 0 }}>{m.content}</p>
                          </div>
                          {m.timestamp && <span style={{ fontSize: 9, color: "#1a1a28", marginTop: 3, padding: "0 4px" }}>{new Date(m.timestamp).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </div>
          ) : selected.full ? (
            <>
              {(selected.parentId || (selected.relatedIds && selected.relatedIds.length > 0)) && (
                <div style={{
                  background: "linear-gradient(135deg, rgba(94,212,212,0.04), rgba(13,13,22,0.5))",
                  border: "1px solid rgba(94,212,212,0.12)",
                  borderRadius: 2, padding: "12px 16px", marginBottom: 16
                }}>
                  <div style={{ fontSize: 9, color: CYAN, letterSpacing: 3, fontWeight: 600, marginBottom: 8, opacity: 0.7 }}>DECISION LINEAGE</div>
                  {selected.parentId && (() => {
                    const parent = memory.find(m => m.id === selected.parentId);
                    if (!parent) return null;
                    return (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: selected.relatedIds?.length ? 6 : 0 }}>
                        <span style={{ fontSize: 10, color: "#444", letterSpacing: 1, fontWeight: 600, flexShrink: 0 }}>FROM:</span>
                        <button onClick={() => { setSelected(parent); window.scrollTo({ top: 0 }); }} style={{
                          background: "none", border: "none", color: "#888", fontSize: 12, cursor: "pointer",
                          fontFamily: "inherit", padding: 0, textAlign: "left", lineHeight: 1.4
                        }}
                        onMouseEnter={e => e.currentTarget.style.color = CYAN}
                        onMouseLeave={e => e.currentTarget.style.color = "#888"}
                        >{parent.decision}</button>
                      </div>
                    );
                  })()}
                  {selected.relatedIds && selected.relatedIds.length > 0 && (
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                      <span style={{ fontSize: 10, color: "#444", letterSpacing: 1, fontWeight: 600, flexShrink: 0, paddingTop: 2 }}>LED TO:</span>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        {selected.relatedIds.map(rid => {
                          const related = memory.find(m => m.id === rid);
                          if (!related) return null;
                          return (
                            <button key={rid} onClick={() => { setSelected(related); window.scrollTo({ top: 0 }); }} style={{
                              background: "none", border: "none", color: "#888", fontSize: 12, cursor: "pointer",
                              fontFamily: "inherit", padding: 0, textAlign: "left", lineHeight: 1.4
                            }}
                            onMouseEnter={e => e.currentTarget.style.color = CYAN}
                            onMouseLeave={e => e.currentTarget.style.color = "#888"}
                            >{related.decision}</button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
              <ScoreBar brittleness={selected.brittleness} animate={true} />
              <ReasoningTrace memory={memory} result={{ ...selected.full, entryId: selected.id }} />
              <AnatomyCard anatomy={selected.full.anatomy} />
              <ArchetypeContext archetype={selected.full.anatomy?.archetype} context={selected.full.anatomy?.archetype_context} />
              <InheritedWarning warnings={selected.full.inheritedWarnings} memory={memory} onOpen={openDecision} />
              <div style={{ marginBottom: 12 }}>
                <div style={SH}>WHERE IT BREAKS</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {selected.full.failures?.map((f, i) => (
                    <FailureCard key={i} f={f} i={i} analysisContext={{ decision: selected.full.anatomy?.decision, stakes: selected.full.anatomy?.stakes, anatomy: selected.full.anatomy, brittleness: selected.brittleness, failures: selected.full.failures, verdict: selected.verdict }} />
                  ))}
                </div>
              </div>
              <div style={{
                background: "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)",
                backdropFilter: "blur(20px)",
                WebkitBackdropFilter: "blur(20px)",
                border: "1px solid rgba(255,255,255,0.06)",
                borderLeft: `2px solid ${PURPLE}77`,
                borderRadius: 2, padding: "26px 24px"
              }}>
                <div style={{ fontSize: 10, color: PURPLE_BRIGHT, letterSpacing: 5, fontWeight: 600, marginBottom: 16, opacity: 0.7 }}>THE VERDICT</div>
                <p style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 17, color: "#999", lineHeight: 1.7, margin: 0, fontStyle: "italic", fontWeight: 400 }}>{selected.verdict}</p>
              </div>

              {selected.full?.signals && <SignalsCard signals={selected.full.signals} />}

              <CommitmentBlock
                entry={selected}
                onCommit={data => saveCommitment(selected.id, data)}
                memory={memory}
                onOpen={openDecision}
              />

              {/* Thread analysis (when triggered) */}
              {(threadAnalysis || threadLoading) && threadAnalysisEntryId === selected.id && (
                <ThreadAnalysisCard
                  analysis={threadAnalysis}
                  loading={threadLoading}
                  onRefresh={() => fetchThreadAnalysis(selected)}
                />
              )}

              {/* Continue the conversation */}
              <FollowUp
                key={selected.id}
                analysisContext={{
                  decision: selected.full.anatomy?.decision,
                  stakes: selected.full.anatomy?.stakes,
                  anatomy: selected.full.anatomy,
                  brittleness: selected.currentBrittleness || selected.brittleness,
                  failures: selected.full.failures,
                  verdict: selected.verdict
                }}
                existingThread={selected.thread || []}
                onAppendMessage={msg => appendToThread(selected.id, msg)}
                onUpdateBrittleness={score => updateEntryBrittleness(selected.id, score)}
              />

              {/* Brittleness evolution timeline if score has changed */}
              {selected.currentBrittleness && selected.currentBrittleness !== selected.brittleness && (
                <div style={{
                  background: "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)",
                              border: "1px solid rgba(255,255,255,0.06)",
                  borderRadius: 2, padding: "14px 18px", marginTop: 12
                }}>
                  <div style={{ fontSize: 9, color: PURPLE_BRIGHT, letterSpacing: 3, fontWeight: 600, marginBottom: 8, opacity: 0.7 }}>BRITTLENESS EVOLUTION</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ fontSize: 18, fontWeight: 800, color: scoreColor(selected.brittleness), opacity: 0.5, textDecoration: "line-through" }}>{selected.brittleness}</span>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                    <span style={{ fontSize: 22, fontWeight: 800, color: scoreColor(selected.currentBrittleness) }}>{selected.currentBrittleness}</span>
                    <span style={{ fontSize: 11, color: "#444", marginLeft: "auto" }}>
                      {selected.currentBrittleness < selected.brittleness ? `Risk reduced by ${selected.brittleness - selected.currentBrittleness}` : `Risk increased by ${selected.currentBrittleness - selected.brittleness}`}
                    </span>
                  </div>
                </div>
              )}
            </>
          ) : null}
        </div>
      )}

      {/* PATTERNS */}
      {view === "patterns" && (
        <div style={{ maxWidth: 720, margin: "0 auto", padding: "calc(104px + var(--safe-top)) 20px calc(80px + var(--safe-bottom))", animation: "fadeUp 0.4s ease" }}>
          <div style={{ marginBottom: 28 }}>
            <Btn variant="ghost" onClick={() => setView("history")} style={{ padding: "8px 0", fontSize: 13, marginBottom: 16 }}>← Back to History</Btn>
            <div style={{ fontSize: 10, color: PURPLE_BRIGHT, letterSpacing: 4, fontWeight: 600, marginBottom: 10, opacity: 0.7 }}>BEHAVIOURAL ANALYSIS</div>
            <h2 style={{
              fontFamily: "'Instrument Serif', Georgia, serif",
              fontSize: "clamp(34px, 5vw, 44px)", fontWeight: 400,
              letterSpacing: "-0.02em", color: "#fff", marginBottom: 8, lineHeight: 1.1
            }}>How you decide</h2>
            <p style={{ fontSize: 13, color: "#444", letterSpacing: "0.02em" }}>Patterns across {memory.length} decisions in your memory</p>
          </div>
          <div className="v-hairline" style={{ marginBottom: 28, opacity: 0.6 }} />

          {patternsLoading && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: "80px 20px" }}>
              <div style={{ width: 32, height: 32, borderRadius: "50%", border: `2px solid ${PURPLE}22`, borderTopColor: PURPLE, animation: "spin 0.9s linear infinite" }} />
              <p style={{ fontSize: 13, color: "#444", fontStyle: "italic" }}>Reading your decision history...</p>
            </div>
          )}

          {!patternsLoading && patterns && (
            <>
              {patterns.summary && (
                <div style={{
                  background: "linear-gradient(135deg, rgba(124,92,191,0.08), rgba(94,212,212,0.04))",
                  border: "1px solid rgba(124,92,191,0.2)",
                  borderRadius: 2, padding: "22px 22px", marginBottom: 20
                }}>
                  <div style={{ fontSize: 10, color: PURPLE_BRIGHT, letterSpacing: 4, fontWeight: 600, marginBottom: 12, opacity: 0.8 }}>YOUR DECISION SIGNATURE</div>
                  <p style={{ fontSize: 14, color: "#aaa", lineHeight: 1.75, margin: 0, fontStyle: "italic" }}>{patterns.summary}</p>
                </div>
              )}

              {patterns.calibration && (patterns.calibration.vestige_accuracy || patterns.calibration.risk_strike_rate || patterns.calibration.commitment_pattern) && (
                <div style={{
                  background: "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)",
                              border: "1px solid rgba(255,255,255,0.06)",
                  borderRadius: 2, padding: "20px 22px", marginBottom: 20
                }}>
                  <div style={{ fontSize: 10, color: CYAN, letterSpacing: 4, fontWeight: 600, marginBottom: 16, opacity: 0.8 }}>CALIBRATION</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 16 }}>
                    {patterns.calibration.vestige_accuracy && (
                      <div>
                        <div style={{ fontSize: 9, color: "#444", letterSpacing: 2, fontWeight: 600, marginBottom: 6 }}>VESTIGE ACCURACY</div>
                        <div style={{ fontSize: 24, fontWeight: 800, color: "#fff", letterSpacing: "-0.02em" }}>
                          {Number(patterns.calibration.vestige_accuracy).toFixed(1)}<span style={{ fontSize: 12, color: "#444", fontWeight: 500 }}>/5</span>
                        </div>
                      </div>
                    )}
                    {patterns.calibration.risk_strike_rate !== null && patterns.calibration.risk_strike_rate !== undefined && (
                      <div>
                        <div style={{ fontSize: 9, color: "#444", letterSpacing: 2, fontWeight: 600, marginBottom: 6 }}>RISKS THAT TRIGGERED</div>
                        <div style={{ fontSize: 24, fontWeight: 800, color: "#fff", letterSpacing: "-0.02em" }}>
                          {typeof patterns.calibration.risk_strike_rate === "number"
                            ? patterns.calibration.risk_strike_rate + "%"
                            : patterns.calibration.risk_strike_rate}
                        </div>
                      </div>
                    )}
                    {patterns.calibration.commitment_pattern && (
                      <div>
                        <div style={{ fontSize: 9, color: "#444", letterSpacing: 2, fontWeight: 600, marginBottom: 6 }}>USUAL MOVE</div>
                        <div style={{ fontSize: 18, fontWeight: 700, color: "#bbb", letterSpacing: "-0.01em", textTransform: "capitalize" }}>
                          {patterns.calibration.commitment_pattern}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {patterns.patterns && patterns.patterns.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {patterns.patterns.map((p, i) => {
                    const sevColor = p.severity === "high" ? "#ef4444" : p.severity === "medium" ? "#f97316" : PURPLE_BRIGHT;
                    return (
                      <div key={i} style={{
                        background: "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)",
                                          border: "1px solid rgba(255,255,255,0.06)",
                        borderLeft: `2px solid ${sevColor}66`,
                        borderRadius: 2, padding: "18px 20px"
                      }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 8 }}>
                          <div style={{ fontSize: 14, fontWeight: 600, color: "#bbb", flex: 1 }}>{p.title}</div>
                          <div style={{ fontSize: 9, color: sevColor, letterSpacing: 2, fontWeight: 700, padding: "3px 8px", background: `${sevColor}11`, borderRadius: 4 }}>
                            {(p.severity || "low").toUpperCase()}
                          </div>
                        </div>
                        <p style={{ fontSize: 13, color: "#666", lineHeight: 1.7, margin: 0 }}>{p.description}</p>
                        {p.evidence_count && (
                          <div style={{ fontSize: 10, color: "#333", marginTop: 10, letterSpacing: 1 }}>
                            Evidenced in {p.evidence_count} decision{p.evidence_count !== 1 ? "s" : ""}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ textAlign: "center", padding: "40px 20px" }}>
                  <p style={{ fontSize: 13, color: "#444", lineHeight: 1.6 }}>No clear patterns yet. Run more analyses for sharper insight.</p>
                </div>
              )}

              <div style={{ marginTop: 24, display: "flex", justifyContent: "center" }}>
                <Btn variant="secondary" onClick={fetchPatterns} style={{ fontSize: 12 }}>Re-analyse</Btn>
              </div>
            </>
          )}
        </div>
      )}

      {/* COMPARE */}
      {view === "compare" && (
        <div style={{ maxWidth: 920, margin: "0 auto", padding: "calc(104px + var(--safe-top)) 20px calc(80px + var(--safe-bottom))", animation: "fadeUp 0.4s ease" }}>
          <div style={{ marginBottom: 28 }}>
            <Btn variant="ghost" onClick={() => { setView("analyse"); setCompareResult(null); }} style={{ padding: "8px 0", fontSize: 13, marginBottom: 16 }}>← Back</Btn>
            <div style={{ fontSize: 10, color: CYAN, letterSpacing: 4, fontWeight: 600, marginBottom: 10, opacity: 0.7 }}>COMPARISON MODE</div>
            <h2 style={{
              fontFamily: "'Instrument Serif', Georgia, serif",
              fontSize: "clamp(34px, 5vw, 44px)", fontWeight: 400,
              letterSpacing: "-0.02em", color: "#fff", marginBottom: 8, lineHeight: 1.1
            }}>Two paths.</h2>
            <p style={{ fontSize: 13, color: "#444", letterSpacing: "0.02em" }}>Describe both options. Vestige scores them side by side.</p>
          </div>
          <div className="v-hairline" style={{ marginBottom: 28, opacity: 0.6 }} />

          {!compareResult && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, marginBottom: 20 }}>
              <div>
                <div style={{ fontSize: 10, color: CYAN, letterSpacing: 3, fontWeight: 600, marginBottom: 10, opacity: 0.7 }}>OPTION A</div>
                <textarea
                  value={compareA} onChange={e => setCompareA(e.target.value)}
                  placeholder="Describe option A..."
                  rows={6} maxLength={MAX_CHARS}
                  style={{
                    width: "100%", background: "rgba(13,13,22,0.7)",
                                  border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 2, padding: "16px 18px",
                    color: "#ddd", fontSize: 15, lineHeight: 1.7,
                    resize: "none", fontFamily: "inherit"
                  }}
                />
              </div>
              <div>
                <div style={{ fontSize: 10, color: PURPLE_BRIGHT, letterSpacing: 3, fontWeight: 600, marginBottom: 10, opacity: 0.7 }}>OPTION B</div>
                <textarea
                  value={compareB} onChange={e => setCompareB(e.target.value)}
                  placeholder="Describe option B..."
                  rows={6} maxLength={MAX_CHARS}
                  style={{
                    width: "100%", background: "rgba(13,13,22,0.7)",
                                  border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 2, padding: "16px 18px",
                    color: "#ddd", fontSize: 15, lineHeight: 1.7,
                    resize: "none", fontFamily: "inherit"
                  }}
                />
              </div>
            </div>
          )}

          {!compareResult && (
            <div style={{ display: "flex", justifyContent: "center", marginTop: 8 }}>
              <Btn variant="primary" onClick={runCompare} disabled={!compareA.trim() || !compareB.trim() || compareLoading}>
                {compareLoading ? "Comparing..." : "Compare options"}
              </Btn>
            </div>
          )}

          {compareLoading && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: "80px 20px" }}>
              <div style={{ width: 32, height: 32, borderRadius: "50%", border: `2px solid ${PURPLE}22`, borderTopColor: PURPLE, animation: "spin 0.9s linear infinite" }} />
              <p style={{ fontSize: 13, color: "#444", fontStyle: "italic" }}>Running both analyses...</p>
            </div>
          )}

          {compareResult && !compareLoading && (
            <>
              {/* Side by side scores */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14, marginBottom: 20 }}>
                {[
                  { opt: compareResult.optionA, accent: CYAN, label: "OPTION A" },
                  { opt: compareResult.optionB, accent: PURPLE_BRIGHT, label: "OPTION B" }
                ].map((o, i) => {
                  const col = scoreColor(o.opt.brittleness);
                  return (
                    <div key={i} style={{
                      background: "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)",
                      backdropFilter: "blur(20px)",
                      border: `1px solid ${o.accent}33`,
                      borderTop: `2px solid ${o.accent}88`,
                      borderRadius: 2, padding: "22px 22px"
                    }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
                        <div style={{ fontSize: 9, color: o.accent, letterSpacing: 3, fontWeight: 700, opacity: 0.85 }}>{o.label}</div>
                        <div style={{ fontSize: 32, fontWeight: 900, color: col, lineHeight: 1, letterSpacing: "-0.04em" }}>
                          {o.opt.brittleness}<span style={{ fontSize: 13, color: "#2a2a3a", fontWeight: 500 }}>/100</span>
                        </div>
                      </div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "#bbb", marginBottom: 14, lineHeight: 1.4 }}>{o.opt.label}</div>
                      <div style={{ marginBottom: 12 }}>
                        <div style={{ fontSize: 9, color: "#444", letterSpacing: 2, fontWeight: 600, marginBottom: 6 }}>PRIMARY RISK</div>
                        <p style={{ fontSize: 12.5, color: "#666", lineHeight: 1.65, margin: 0 }}>{o.opt.primary_risk}</p>
                      </div>
                      {o.opt.strengths && o.opt.strengths.length > 0 && (
                        <div style={{ marginBottom: 12 }}>
                          <div style={{ fontSize: 9, color: "#22c55e", letterSpacing: 2, fontWeight: 600, marginBottom: 6, opacity: 0.8 }}>STRENGTHS</div>
                          <p style={{ fontSize: 12, color: "#7a9a82", lineHeight: 1.6, margin: 0 }}>{o.opt.strengths.join(" · ")}</p>
                        </div>
                      )}
                      <div>
                        <div style={{ fontSize: 9, color: "#444", letterSpacing: 2, fontWeight: 600, marginBottom: 6 }}>KEY TRADE-OFF</div>
                        <p style={{ fontSize: 12, color: "#666", lineHeight: 1.6, margin: 0, fontStyle: "italic" }}>{o.opt.key_tradeoff}</p>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Divergence */}
              {compareResult.divergence && (
                <div style={{
                  background: "linear-gradient(135deg, rgba(94,212,212,0.05), rgba(124,92,191,0.04))",
                  border: "1px solid rgba(94,212,212,0.15)",
                  borderRadius: 2, padding: "18px 20px", marginBottom: 12
                }}>
                  <div style={{ fontSize: 10, color: CYAN, letterSpacing: 4, fontWeight: 600, marginBottom: 10, opacity: 0.8 }}>WHERE THEY DIVERGE</div>
                  <p style={{ fontSize: 13.5, color: "#888", lineHeight: 1.75, margin: 0 }}>{compareResult.divergence}</p>
                </div>
              )}

              {/* Recommendation */}
              <div style={{
                background: "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)",
                backdropFilter: "blur(20px)",
                border: "1px solid rgba(255,255,255,0.06)",
                borderLeft: `2px solid ${PURPLE}88`,
                borderRadius: 2, padding: "24px 22px", marginBottom: 20
              }}>
                <div style={{ fontSize: 10, color: PURPLE_BRIGHT, letterSpacing: 4, fontWeight: 600, marginBottom: 12, opacity: 0.8 }}>RECOMMENDATION</div>
                <p style={{
                  fontFamily: "'Instrument Serif', Georgia, serif",
                  fontSize: 18, color: "#bbb", lineHeight: 1.7,
                  margin: 0, fontWeight: 400, fontStyle: "italic"
                }}>{compareResult.recommendation}</p>
              </div>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
                <Btn variant="secondary" onClick={() => { setCompareResult(null); }}>Edit options</Btn>
                <Btn variant="ghost" onClick={() => { setCompareA(""); setCompareB(""); setCompareResult(null); }}>Start over</Btn>
              </div>
            </>
          )}
        </div>
      )}

      {/* REVIEWS */}
      {/* OPEN LOOPS — decisions committed to and never closed */}
      {view === "openloops" && (
        <div style={{ maxWidth: 720, margin: "0 auto", padding: "calc(104px + var(--safe-top)) 20px calc(80px + var(--safe-bottom))", animation: "fadeUp 0.4s ease" }}>
          <div style={{ marginBottom: 24 }}>
            <Btn variant="ghost" onClick={() => setView("history")} style={{ padding: "8px 0", fontSize: 13, marginBottom: 16 }}>← Back</Btn>
            <div style={{ fontSize: 10, color: "#f0a060", letterSpacing: 4, fontWeight: 600, marginBottom: 10, opacity: 0.8 }}>OPEN LOOPS</div>
            <h2 style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: "clamp(32px, 5vw, 42px)", fontWeight: 400, letterSpacing: "-0.02em", color: "#fff", marginBottom: 8, lineHeight: 1.1 }}>What you never closed.</h2>
            <p style={{ fontSize: 13.5, color: "#666", letterSpacing: "0.01em", lineHeight: 1.6, maxWidth: 560 }}>
              You decided these. They've played out. You never told Vestige how — so you learned nothing from them, and the rest of the system stays blind to them.
            </p>
          </div>

          {/* The follow-through mirror */}
          {followThrough && (
            <div style={{
              background: "linear-gradient(135deg, rgba(249,115,22,0.07), rgba(124,92,191,0.03))",
              border: "1px solid rgba(249,115,22,0.22)", borderLeft: "2px solid #f0a060",
              borderRadius: 2, padding: "18px 20px", marginBottom: 24
            }}>
              <div style={{ fontSize: 10, color: "#f0a060", letterSpacing: 3, fontWeight: 600, marginBottom: 10, opacity: 0.85 }}>YOUR FOLLOW-THROUGH</div>
              <p style={{ fontSize: 13.5, color: "#bbb", lineHeight: 1.7, margin: "0 0 10px" }}>{followThrough.label}</p>
              {followThrough.bias && (
                <p style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 16, color: "#e0b090", lineHeight: 1.65, margin: "0 0 10px", fontStyle: "italic" }}>{followThrough.bias}</p>
              )}
              <div style={{ display: "flex", gap: 16, marginTop: 12 }}>
                {[
                  { n: followThrough.closed, l: "CLOSED", c: "#6ab88a" },
                  { n: followThrough.open, l: "OPEN", c: "#f0a060" },
                  { n: `${Math.round(followThrough.closeRate * 100)}%`, l: "CLOSE RATE", c: "#9a9aa5" }
                ].map(s => (
                  <div key={s.l}>
                    <div style={{ fontSize: 22, fontWeight: 800, color: s.c, letterSpacing: "-0.02em", lineHeight: 1 }}>{s.n}</div>
                    <div style={{ fontSize: 8.5, color: "#555", letterSpacing: 1.5, fontWeight: 600, marginTop: 4 }}>{s.l}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {openLoops.length === 0 ? (
            <div style={{ textAlign: "center", padding: "50px 20px" }}>
              <p style={{ fontSize: 14, color: "#444", lineHeight: 1.6, marginBottom: 8 }}>No open loops. Every decision you've committed to has been closed.</p>
              <p style={{ fontSize: 12, color: "#333", lineHeight: 1.6 }}>That's rare discipline — it's what makes the calibration sharp.</p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {openLoops.map(e => {
                const moveLabels = { proceed: "Proceeded", modify: "Modified", abandon: "Abandoned", waiting: "Held" };
                const moveColors = { proceed: "#22c55e", modify: PURPLE_BRIGHT, abandon: "#ef4444", waiting: "#f97316" };
                return (
                  <div key={e.id} onClick={() => { openDecision(e); setShowPostMortem(true); }} style={{
                    background: "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)",
                                  border: "1px solid rgba(249,115,22,0.16)", borderLeft: `2px solid #f0a06088`,
                    borderRadius: 2, padding: "18px 20px", cursor: "pointer", transition: "all 0.25s",
                    WebkitTapHighlightColor: "transparent"
                  }}
                  onMouseEnter={ev => { ev.currentTarget.style.borderColor = "rgba(249,115,22,0.35)"; ev.currentTarget.style.transform = "translateY(-1px)"; }}
                  onMouseLeave={ev => { ev.currentTarget.style.borderColor = "rgba(249,115,22,0.16)"; ev.currentTarget.style.transform = "translateY(0)"; }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 10 }}>
                      <span style={{ fontSize: 13.5, color: "#bbb", lineHeight: 1.5, flex: 1, fontWeight: 500 }}>{e.decision || e.summary}</span>
                      <span style={{ fontSize: 20, fontWeight: 800, color: scoreColor(e.currentBrittleness || e.brittleness), flexShrink: 0, letterSpacing: "-0.02em" }}>{e.currentBrittleness || e.brittleness}</span>
                    </div>
                    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                      {e.commitment?.move && <span style={{ fontSize: 11, color: moveColors[e.commitment.move], fontWeight: 600 }}>{moveLabels[e.commitment.move]}</span>}
                      <span style={{ fontSize: 11, color: "#2a2a3a" }}>·</span>
                      <span style={{ fontSize: 11, color: "#f0a060", opacity: 0.85 }}>{e.ageDays} days open, no post-mortem</span>
                      <span style={{ marginLeft: "auto", fontSize: 10, color: "#f0a060", letterSpacing: 1.5, fontWeight: 600, opacity: 0.7 }}>CLOSE IT →</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {view === "reviews" && (
        <div style={{ maxWidth: 720, margin: "0 auto", padding: "calc(104px + var(--safe-top)) 20px calc(80px + var(--safe-bottom))", animation: "fadeUp 0.4s ease" }}>
          <div style={{ marginBottom: 28 }}>
            <Btn variant="ghost" onClick={() => setView("history")} style={{ padding: "8px 0", fontSize: 13, marginBottom: 16 }}>← Back</Btn>
            <div style={{ fontSize: 10, color: PURPLE_BRIGHT, letterSpacing: 4, fontWeight: 600, marginBottom: 10, opacity: 0.7 }}>DUE FOR REVIEW</div>
            <h2 style={{
              fontFamily: "'Instrument Serif', Georgia, serif",
              fontSize: "clamp(34px, 5vw, 44px)", fontWeight: 400,
              letterSpacing: "-0.02em", color: "#fff", marginBottom: 8, lineHeight: 1.1
            }}>Time to look back.</h2>
            <p style={{ fontSize: 13, color: "#444", letterSpacing: "0.02em" }}>{reviewsDue.length} decision{reviewsDue.length !== 1 ? "s" : ""} you committed to are ready for post-mortem</p>
          </div>

          {reviewsDue.length === 0 ? (
            <div style={{ textAlign: "center", padding: "60px 20px" }}>
              <p style={{ fontSize: 14, color: "#444", lineHeight: 1.6, marginBottom: 8 }}>Nothing due for review.</p>
              <p style={{ fontSize: 12, color: "#333", lineHeight: 1.6 }}>Decisions appear here when their review date arrives.</p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {reviewsDue.map(e => {
                const overdue = e.daysFromNow < 0;
                const today = e.daysFromNow === 0;
                const moveLabels = { proceed: "Proceeded", modify: "Modified", abandon: "Abandoned", waiting: "Held" };
                const moveColors = { proceed: "#22c55e", modify: PURPLE_BRIGHT, abandon: "#ef4444", waiting: "#f97316" };
                const dueLabel = overdue ? `${Math.abs(e.daysFromNow)} day${Math.abs(e.daysFromNow) !== 1 ? "s" : ""} overdue` : today ? "Due today" : `Due in ${e.daysFromNow} day${e.daysFromNow !== 1 ? "s" : ""}`;
                const dueColor = overdue ? "#ef4444" : today ? "#f97316" : PURPLE_BRIGHT;
                return (
                  <div key={e.id} onClick={() => { setSelected(e); setShowPostMortem(true); setView("detail"); }} style={{
                    background: "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)",
                                  border: `1px solid ${overdue ? "rgba(239,68,68,0.2)" : "rgba(255,255,255,0.06)"}`,
                    borderLeft: `2px solid ${dueColor}88`,
                    borderRadius: 2, padding: "18px 20px",
                    cursor: "pointer", transition: "all 0.25s",
                    WebkitTapHighlightColor: "transparent"
                  }}
                  onMouseEnter={ev => { ev.currentTarget.style.borderColor = "rgba(255,255,255,0.12)"; ev.currentTarget.style.transform = "translateY(-1px)"; }}
                  onMouseLeave={ev => { ev.currentTarget.style.borderColor = overdue ? "rgba(239,68,68,0.2)" : "rgba(255,255,255,0.06)"; ev.currentTarget.style.transform = "translateY(0)"; }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 10 }}>
                      <span style={{ fontSize: 13.5, color: "#bbb", lineHeight: 1.5, flex: 1, fontWeight: 500 }}>{e.decision}</span>
                      <span style={{ fontSize: 10, color: dueColor, letterSpacing: 1.5, fontWeight: 700, padding: "3px 8px", background: `${dueColor}11`, borderRadius: 4, whiteSpace: "nowrap", flexShrink: 0 }}>
                        {dueLabel.toUpperCase()}
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                      <span style={{ fontSize: 11, color: moveColors[e.commitment.move], fontWeight: 600 }}>{moveLabels[e.commitment.move]}</span>
                      <span style={{ fontSize: 11, color: "#2a2a3a" }}>·</span>
                      <span style={{ fontSize: 11, color: "#444" }}>Committed {new Date(e.commitment.committedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
                      <span style={{ marginLeft: "auto", fontSize: 10, color: PURPLE_BRIGHT, letterSpacing: 1.5, fontWeight: 600, opacity: 0.7 }}>
                        START POST-MORTEM →
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* SIMULATION */}
      {view === "simulation" && (
        <div style={{ maxWidth: 920, margin: "0 auto", padding: "calc(104px + var(--safe-top)) 20px calc(80px + var(--safe-bottom))", animation: "fadeUp 0.4s ease" }}>
          <div style={{ marginBottom: 28 }}>
            <Btn variant="ghost" onClick={() => { setView("analyse"); setSimulationResults([]); }} style={{ padding: "8px 0", fontSize: 13, marginBottom: 16 }}>← Back</Btn>
            <div style={{ fontSize: 10, color: PURPLE_BRIGHT, letterSpacing: 4, fontWeight: 600, marginBottom: 10, opacity: 0.7 }}>STRATEGIC SIMULATION</div>
            <h2 style={{
              fontFamily: "'Instrument Serif', Georgia, serif",
              fontSize: "clamp(34px, 5vw, 44px)", fontWeight: 400,
              letterSpacing: "-0.02em", color: "#fff", marginBottom: 8, lineHeight: 1.1
            }}>Imagine alternate futures.</h2>
            <p style={{ fontSize: 13, color: "#444", letterSpacing: "0.02em" }}>Describe a decision and key scenarios. Vestige will simulate how they could unfold.</p>
          </div>

          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 10, color: CYAN, letterSpacing: 3, fontWeight: 600, marginBottom: 10, opacity: 0.7 }}>DECISION</div>
            <textarea
              value={simulationDecision} onChange={e => setSimulationDecision(e.target.value)}
              placeholder="Describe the decision or strategy you want to simulate..."
              rows={3} maxLength={MAX_CHARS}
              style={{
                width: "100%", background: "rgba(13,13,22,0.7)",
                          border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 2, padding: "16px 18px",
                color: "#ddd", fontSize: 15, lineHeight: 1.7,
                resize: "none", fontFamily: "inherit"
              }}
            />
          </div>

          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 10, color: CYAN, letterSpacing: 3, fontWeight: 600, marginBottom: 10, opacity: 0.7 }}>KEY CONTEXT</div>
            <textarea
              value={simulationContext} onChange={e => setSimulationContext(e.target.value)}
              placeholder="Provide any relevant context about your business, market, customers, etc..."
              rows={4} maxLength={MAX_CHARS}
              style={{
                width: "100%", background: "rgba(13,13,22,0.7)",
                          border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 2, padding: "16px 18px",
                color: "#ddd", fontSize: 15, lineHeight: 1.7,
                resize: "none", fontFamily: "inherit"
              }}
            />
          </div>

          <div style={{ fontSize: 10, color: PURPLE_BRIGHT, letterSpacing: 3, fontWeight: 600, marginBottom: 12, opacity: 0.7 }}>SCENARIOS TO SIMULATE</div>
          {[0,1,2].map(i => (
            <div key={i} style={{ marginBottom: 12 }}>
              <textarea
                value={simulationScenarios[i]}
                onChange={e => setSimulationScenarios(prev => prev.map((s,j) => j === i ? e.target.value : s))}
                placeholder={`Scenario ${i+1}`}
                rows={2} maxLength={MAX_CHARS}
                style={{
                  width: "100%", background: "rgba(0,0,0,0.3)", 
                  border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10,
                  padding: "12px 14px", color: "#ccc", fontSize: 14, lineHeight: 1.6,
                  resize: "none", fontFamily: "inherit"
                }}
              />
            </div>
          ))}

          <div style={{ display: "flex", justifyContent: "center", marginTop: 20 }}>
            <Btn variant="primary" onClick={runSimulation} disabled={simulationLoading}>
              {simulationLoading ? "Simulating..." : "Run simulations"}
            </Btn>
          </div>

          {simulationLoading && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: "80px 20px" }}>
              <div style={{ width: 32, height: 32, borderRadius: "50%", border: `2px solid ${PURPLE}22`, borderTopColor: PURPLE, animation: "spin 0.9s linear infinite" }} />
              <p style={{ fontSize: 13, color: "#444", fontStyle: "italic" }}>Generating scenario narratives...</p>
            </div>
          )}

          {simulationResults.length > 0 && (
            <div style={{ marginTop: 40 }}>
              {simulationResults.map((result, i) => (
                <div key={i} style={{
                  background: "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)",
                  backdropFilter: "blur(20px)",
                  border: `1px solid ${PURPLE}33`,
                  borderRadius: 2, padding: "24px 22px", marginBottom: 32
                }}>
                  <div style={{ fontSize: 10, color: PURPLE_BRIGHT, letterSpacing: 4, fontWeight: 600, marginBottom: 12, opacity: 0.8 }}>{result.prompt.toUpperCase()}</div>
                  
                  <div style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 16, color: "#aaa", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
                    {result.story}
                  </div>

                  <div style={{ marginTop: 20 }}>
                    <div style={{ fontSize: 9, color: CYAN, letterSpacing: 3, fontWeight: 600, marginBottom: 10, opacity: 0.7 }}>KEY EVENTS</div>
                    <ol style={{ padding: "0 0 0 20px", margin: 0 }}>
                      {result.key_events.map((event, j) => (
                        <li key={j} style={{ fontSize: 13, color: "#666", lineHeight: 1.6, marginBottom: 6 }}>{event}</li>
                      ))}
                    </ol>
                  </div>

                  <div style={{ marginTop: 16, fontSize: 13, color: "#777", lineHeight: 1.7, fontStyle: "italic", borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 16 }}>
                    Final State: {result.final_state}
                  </div>
                </div>
              ))}
              <div style={{ display: "flex", justifyContent: "center", marginTop: 20 }}>
                <Btn variant="ghost" onClick={() => setSimulationResults([])}>Clear results</Btn>
              </div>
            </div>
          )}
        </div>
      )}

      {/* EVOLUTION — how you're changing as a decision-maker */}
      {view === "evolution" && (() => {
        const ev = computeEvolution(memory, now);
        const shiftMeta = {
          risk:          { label: "RISK APPETITE",   icon: "M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" },
          boldness:      { label: "BOLDNESS",        icon: "M13 2 3 14h7l-1 8 10-12h-7l1-8z" },
          followthrough: { label: "FOLLOW-THROUGH",  icon: "M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4 12 14.01l-3-3" },
          selfknowledge: { label: "SELF-KNOWLEDGE",  icon: "M3 3v5h5M3.05 13A9 9 0 1 0 6 5.3L3 8M12 7v5l4 2" },
          outcomes:      { label: "OUTCOMES",        icon: "M3 3v18h18M18.7 8l-5.1 5.2-2.8-2.7L7 14.3" }
        };
        const dirColor = (k, dir) => {
          // "up" is positive for followthrough/selfknowledge/outcomes; ambiguous for risk/boldness.
          if (k === "followthrough" || k === "selfknowledge" || k === "outcomes") return dir === "up" ? "#6ab88a" : "#ef8a6a";
          return dir === "up" ? "#f0a060" : "#7fa8d4"; // risk/boldness: up=amber (more exposure), down=calm blue
        };
        return (
          <div style={{ maxWidth: 720, margin: "0 auto", padding: "calc(104px + var(--safe-top)) 20px calc(80px + var(--safe-bottom))", animation: "fadeUp 0.4s ease" }}>
            <div style={{ marginBottom: 28 }}>
              <Btn variant="ghost" onClick={() => setView("landscape")} style={{ padding: "8px 0", fontSize: 13, marginBottom: 16 }}>← Landscape</Btn>
              <div style={{ fontSize: 10, color: PURPLE_BRIGHT, letterSpacing: 4, fontWeight: 600, marginBottom: 10, opacity: 0.7 }}>HOW YOU'RE CHANGING</div>
              <h2 style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: "clamp(32px, 5vw, 44px)", fontWeight: 400, letterSpacing: "-0.02em", color: "#fff", marginBottom: 10, lineHeight: 1.1 }}>Your trajectory.</h2>
              <p style={{ fontSize: 13.5, color: "#666", letterSpacing: "0.01em", lineHeight: 1.6, maxWidth: 560 }}>
                Vestige split your record into your earlier self and your recent self, and measured what actually moved. Only real, sizeable shifts appear here — the rest is noise, and stays silent.
              </p>
            </div>

            {ev.status === "insufficient" && (
              <div style={{ textAlign: "center", padding: "50px 24px", background: "rgba(13,13,22,0.5)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 2 }}>
                <p style={{ fontSize: 14, color: "#888", lineHeight: 1.7, marginBottom: 8 }}>Not enough history yet to see a trajectory.</p>
                <p style={{ fontSize: 12.5, color: "#555", lineHeight: 1.6 }}>You have {ev.count} analysed decision{ev.count !== 1 ? "s" : ""}{ev.spanDays != null ? ` over ${ev.spanDays} days` : ""}. Evolution needs at least {ev.needed}, spanning a month or more, so the comparison between your past and present self means something.</p>
              </div>
            )}

            {ev.status === "stable" && (
              <div style={{ textAlign: "center", padding: "50px 24px", background: "rgba(13,13,22,0.5)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 2 }}>
                <p style={{ fontSize: 14, color: "#999", lineHeight: 1.7, marginBottom: 8 }}>You've held remarkably steady.</p>
                <p style={{ fontSize: 12.5, color: "#555", lineHeight: 1.6 }}>Across {ev.count} decisions spanning {ev.spanDays} days, none of your patterns — risk, boldness, follow-through, self-knowledge, outcomes — have shifted enough to call a real change. Consistency isn't nothing.</p>
              </div>
            )}

            {ev.status === "ok" && (
              <>
                <div style={{
                  background: "linear-gradient(135deg, rgba(124,92,191,0.1), rgba(94,212,212,0.04))",
                  border: `1px solid ${PURPLE}33`, borderRadius: 2, padding: "22px 22px", marginBottom: 24
                }}>
                  <div style={{ fontSize: 9.5, color: PURPLE_BRIGHT, letterSpacing: 3, fontWeight: 700, marginBottom: 10, opacity: 0.85 }}>THE SHIFT THAT MATTERS</div>
                  <p style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 20, color: "#e8e0f0", lineHeight: 1.5, margin: 0, fontStyle: "italic" }}>{ev.summary}</p>
                  <p style={{ fontSize: 11, color: "#555", margin: "14px 0 0", letterSpacing: 0.3 }}>Comparing your earliest {ev.earlierCount} decisions against your most recent {ev.recentCount}, across {ev.spanDays} days.</p>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {ev.shifts.map((s, i) => {
                    const meta = shiftMeta[s.key]; const col = dirColor(s.key, s.dir);
                    return (
                      <div key={i} style={{
                        background: "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)",
                        border: "1px solid rgba(255,255,255,0.06)", borderLeft: `2px solid ${col}`,
                        borderRadius: 2, padding: "16px 18px", display: "flex", gap: 14, alignItems: "flex-start"
                      }}>
                        <div style={{ width: 34, height: 34, borderRadius: 9, background: `${col}1a`, border: `1px solid ${col}33`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={col} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={meta.icon}/></svg>
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                            <span style={{ fontSize: 9.5, color: col, letterSpacing: 2, fontWeight: 700, opacity: 0.9 }}>{meta.label}</span>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={col} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: s.dir === "down" ? "rotate(180deg)" : "none", opacity: 0.7 }}><path d="M12 19V5M5 12l7-7 7 7"/></svg>
                          </div>
                          <p style={{ fontSize: 13, color: "#bbb", lineHeight: 1.6, margin: 0 }}>{s.text}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <p style={{ fontSize: 11, color: "#444", lineHeight: 1.6, margin: "20px 0 0", textAlign: "center", fontStyle: "italic" }}>
                  A trajectory is not a verdict. It's the record noticing what you might not — direction, not destiny.
                </p>
              </>
            )}
          </div>
        );
      })()}

      {/* MEMORY LANDSCAPE — decay made legible */}
      {view === "landscape" && (() => {
        const sorted = [...memory].sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0));
        const vivid    = sorted.filter(e => e.retention === "full");
        const fading   = sorted.filter(e => e.retention === "partial");
        const faint     = sorted.filter(e => e.retention === "compress");
        const withLesson = memory.filter(e => e.lesson);
        const clusters = detectResidueClusters(memory);
        const hindsight = computeHindsightProfile(memory);
        const followThroughLS = computeFollowThrough(memory, now);
        const calibration = computeCalibration(memory);
        const principles = derivePrinciples(memory, now);
        // Bar height encodes recall strength; opacity too. This is the editorial
        // judgment of decay, drawn.
        const Bar = ({ e }) => {
          const s = e.strength ?? (e.retention === "full" ? 0.8 : e.retention === "partial" ? 0.4 : 0.12);
          const col = e.retention === "full" ? "#22c55e" : e.retention === "partial" ? PURPLE_BRIGHT : "#555";
          const h = 20 + Math.round(s * 92);
          return (
            <button onClick={() => openDecision(e)} title={`${e.decision || e.summary} · recall ${(s * 100).toFixed(0)}%`} style={{
              flex: "0 0 auto", width: 30, height: 120, display: "flex", flexDirection: "column",
              justifyContent: "flex-end", alignItems: "center", background: "none", border: "none",
              cursor: "pointer", padding: 0, WebkitTapHighlightColor: "transparent"
            }}>
              <div style={{
                width: "100%", height: h, borderRadius: "5px 5px 0 0",
                background: `linear-gradient(180deg, ${col}, ${col}44)`,
                opacity: 0.35 + s * 0.65,
                boxShadow: e.retention === "full" ? `0 0 14px ${col}66` : "none",
                transition: "all 0.4s ease"
              }} />
            </button>
          );
        };
        return (
          <div style={{ maxWidth: 760, margin: "0 auto", padding: "calc(104px + var(--safe-top)) 20px calc(80px + var(--safe-bottom))", animation: "fadeUp 0.4s ease" }}>
            <Btn variant="ghost" onClick={() => setView("history")} style={{ padding: "8px 0", fontSize: 13, marginBottom: 16 }}>← Back to History</Btn>
            <div style={{ fontSize: 10, color: PURPLE_BRIGHT, letterSpacing: 4, fontWeight: 600, marginBottom: 10, opacity: 0.7 }}>MEMORY LANDSCAPE</div>
            <h2 style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: "clamp(32px, 5vw, 42px)", fontWeight: 400, letterSpacing: "-0.02em", color: "#fff", marginBottom: 10, lineHeight: 1.1 }}>What's surviving.</h2>
            <p style={{ fontSize: 14, color: "#666", lineHeight: 1.7, marginBottom: 8, maxWidth: 560 }}>
              Vestige doesn't keep everything. It lets decisions decay — so what stays bright is what mattered, by stakes or because you kept returning to it. This is that judgment, drawn.
            </p>

            {memory.filter(e => typeof e.brittleness === "number").length >= 8 && (
              <button onClick={() => setView("evolution")} style={{
                display: "inline-flex", alignItems: "center", gap: 8, marginTop: 6,
                background: "linear-gradient(135deg, rgba(124,92,191,0.14), rgba(94,212,212,0.06))",
                border: `1px solid ${PURPLE}44`, color: "#cbb8e8", fontSize: 12, fontWeight: 600,
                padding: "10px 16px", borderRadius: 10, cursor: "pointer", fontFamily: "inherit",
                WebkitTapHighlightColor: "transparent", transition: "all 0.2s"
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = `${PURPLE}88`; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = `${PURPLE}44`; }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>
                See how you're changing →
              </button>
            )}

            {/* The landscape itself */}
            <div style={{
              background: "linear-gradient(180deg, rgba(124,92,191,0.04), rgba(8,8,13,0))",
              border: "1px solid rgba(255,255,255,0.05)", borderRadius: 2,
              padding: "28px 18px 18px", marginTop: 24, marginBottom: 28, overflowX: "auto"
            }} className="h-scroll">
              <div style={{ display: "flex", gap: 6, alignItems: "flex-end", minHeight: 120 }}>
                {sorted.map(e => <Bar key={e.id} e={e} />)}
              </div>
              <div style={{ height: 1, background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent)", margin: "8px 0 14px" }} />
              <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 10, color: "#555", letterSpacing: 1 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: "#22c55e", opacity: 0.9 }} /> VIVID {vivid.length}</span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: PURPLE_BRIGHT, opacity: 0.6 }} /> FADING {fading.length}</span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: "#555", opacity: 0.4 }} /> FAINT {faint.length}</span>
              </div>
            </div>

            {/* What survived, in words */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 28 }}>
              {[
                { label: "STILL VIVID", n: vivid.length, col: "#22c55e", sub: "held by stakes or reinforcement" },
                { label: "FADING", n: fading.length, col: PURPLE_BRIGHT, sub: "slipping toward compression" },
                { label: "FADED TO RESIDUE", n: faint.length, col: "#555", sub: "episode gone, gist remains" },
              ].map(s => (
                <div key={s.label} style={{ background: "rgba(13,13,22,0.6)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 2, padding: "16px 18px" }}>
                  <div style={{ fontSize: 28, fontWeight: 800, color: s.col, letterSpacing: "-0.03em", lineHeight: 1 }}>{s.n}</div>
                  <div style={{ fontSize: 9, color: s.col, letterSpacing: 2, fontWeight: 600, margin: "8px 0 4px", opacity: 0.8 }}>{s.label}</div>
                  <div style={{ fontSize: 11, color: "#555", lineHeight: 1.5 }}>{s.sub}</div>
                </div>
              ))}
            </div>

            {/* Principles — the crystallised top tier of memory */}
            {principles.length > 0 && (
              <div style={{ marginBottom: 28 }}>
                <div style={{ fontSize: 10, color: "#d4b483", letterSpacing: 3, fontWeight: 600, marginBottom: 6, opacity: 0.9 }}>PRINCIPLES YOU'VE EARNED</div>
                <p style={{ fontSize: 12.5, color: "#555", lineHeight: 1.6, marginBottom: 16, maxWidth: 560 }}>
                  The top of the hierarchy: lessons that recurred and held across several of your own resolved decisions. Earned, not asserted — with the evidence, and any exceptions.
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {principles.map((p, i) => (
                    <div key={i} style={{
                      background: "linear-gradient(135deg, rgba(212,180,131,0.07), rgba(124,92,191,0.03))",
                      border: "1px solid rgba(212,180,131,0.25)", borderLeft: "2px solid #d4b483",
                      borderRadius: 2, padding: "18px 20px"
                    }}>
                      <p style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 17, color: "#d8c9a8", lineHeight: 1.5, margin: "0 0 12px", fontStyle: "italic" }}>{p.statement}</p>
                      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center", marginBottom: p.members.length ? 10 : 0 }}>
                        <span style={{ fontSize: 10, color: "#9a8a6a", letterSpacing: 1, fontWeight: 600 }}>VALIDATED {p.supportCount}×</span>
                        {p.timeSpanDays > 0 && <span style={{ fontSize: 10, color: "#6a6a55" }}>over {p.timeSpanDays} days</span>}
                        {p.exceptions > 0 && <span style={{ fontSize: 10, color: "#a07a5a" }}>· {p.exceptions} exception{p.exceptions !== 1 ? "s" : ""}, so not absolute</span>}
                      </div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {p.members.slice(0, 6).map(m => (
                          <button key={m.id} onClick={() => openDecision(m)} style={{
                            background: "rgba(0,0,0,0.22)", border: "1px solid rgba(212,180,131,0.15)",
                            borderRadius: 6, padding: "5px 10px", cursor: "pointer", fontFamily: "inherit",
                            fontSize: 10.5, color: "#8a7a5a", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
                          }}>{(m.decision || m.summary || "").slice(0, 32)}</button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Hindsight profile — how the user's own memory distorts (un-promptable) */}
            {hindsight && (
              <div style={{
                background: "linear-gradient(135deg, rgba(94,212,212,0.06), rgba(124,92,191,0.04))",
                border: `1px solid ${CYAN}2a`, borderLeft: `2px solid ${CYAN}88`,
                borderRadius: 2, padding: "18px 20px", marginBottom: 20
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={CYAN} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.8 }}>
                    <path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/>
                  </svg>
                  <div style={{ fontSize: 10, color: CYAN, letterSpacing: 3, fontWeight: 600, opacity: 0.8 }}>HOW YOUR MEMORY DISTORTS</div>
                </div>
                <p style={{ fontSize: 13.5, color: "#aab", lineHeight: 1.7, margin: "0 0 10px" }}>{hindsight.label}</p>
                <p style={{ fontSize: 11, color: "#556", lineHeight: 1.6, margin: 0 }}>
                  Measured across {hindsight.count} post-mortems, by comparing what you recalled against the prediction Vestige recorded at the time. Your biological memory rewrote those; Vestige's didn't.
                </p>
              </div>
            )}

            {/* Follow-through mirror — what you avoid looking at (un-promptable) */}
            {followThroughLS && (followThroughLS.bias || followThroughLS.open >= 3) && (
              <div style={{
                background: "linear-gradient(135deg, rgba(249,115,22,0.06), rgba(124,92,191,0.03))",
                border: "1px solid rgba(249,115,22,0.2)", borderLeft: "2px solid #f0a060",
                borderRadius: 2, padding: "18px 20px", marginBottom: 20
              }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
                  <div style={{ fontSize: 10, color: "#f0a060", letterSpacing: 3, fontWeight: 600, opacity: 0.85 }}>WHAT YOU AVOID LOOKING AT</div>
                  <button onClick={() => setView("openloops")} style={{ background: "none", border: "none", color: "#f0a060", fontSize: 11, cursor: "pointer", fontFamily: "inherit", opacity: 0.8, padding: 0 }}>{followThroughLS.open} open →</button>
                </div>
                <p style={{ fontSize: 13.5, color: "#bbb", lineHeight: 1.7, margin: 0 }}>{followThroughLS.bias || followThroughLS.label}</p>
              </div>
            )}

            {/* Self-calibration — is Vestige any good, for you? (the third mirror) */}
            {calibration.status === "ok" && (() => {
              const tone = calibration.discrimination === "strong" ? "#6ab88a"
                : calibration.discrimination === "moderate" ? "#9ab87a"
                : calibration.discrimination === "weak" ? "#9a9aa5" : "#ef8a6a";
              return (
                <div style={{
                  background: `linear-gradient(135deg, ${tone}12, rgba(124,92,191,0.03))`,
                  border: `1px solid ${tone}33`, borderLeft: `2px solid ${tone}`,
                  borderRadius: 2, padding: "18px 20px", marginBottom: 20
                }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
                    <div style={{ fontSize: 10, color: tone, letterSpacing: 3, fontWeight: 600, opacity: 0.9 }}>IS VESTIGE ANY GOOD — FOR YOU?</div>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                      <span style={{ fontSize: 18, fontWeight: 800, color: tone, letterSpacing: "-0.02em" }}>{calibration.auc100}%</span>
                      <span style={{ fontSize: 9, color: "#555", letterSpacing: 1 }}>RANK ACCURACY</span>
                    </div>
                  </div>
                  <p style={{ fontSize: 13.5, color: "#bbb", lineHeight: 1.7, margin: 0 }}>{calibration.signal}</p>
                  {calibration.biasLabel && (
                    <p style={{ fontSize: 12.5, color: "#888", lineHeight: 1.65, margin: "8px 0 0" }}>{calibration.biasLabel}</p>
                  )}
                  <p style={{ fontSize: 10.5, color: "#555", lineHeight: 1.5, margin: "10px 0 0" }}>
                    Measured on {calibration.resolved} resolved decisions — its original score against whether the risk it flagged actually materialised. Reported, never used to quietly rewrite the score.
                  </p>
                </div>
              );
            })()}
            {calibration.status === "insufficient" && memory.filter(e => e.postMortem).length >= 3 && (
              <div style={{ background: "rgba(13,13,22,0.5)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 2, padding: "16px 20px", marginBottom: 20 }}>
                <div style={{ fontSize: 10, color: "#666", letterSpacing: 3, fontWeight: 600, marginBottom: 8 }}>IS VESTIGE ANY GOOD — FOR YOU?</div>
                <p style={{ fontSize: 12.5, color: "#555", lineHeight: 1.6, margin: 0 }}>
                  Not enough resolved outcomes yet to judge the instrument honestly ({calibration.resolved} of {calibration.needed}, with at least two that broke and two that didn't). Close more loops and Vestige will measure whether its own scores have actually predicted your outcomes.
                </p>
              </div>
            )}

            {/* The residue — what forgetting left behind */}
            {withLesson.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10, color: CYAN, letterSpacing: 3, fontWeight: 600, marginBottom: 6, opacity: 0.7 }}>WHAT FORGETTING LEFT BEHIND</div>
                <p style={{ fontSize: 12.5, color: "#555", lineHeight: 1.6, marginBottom: 16, maxWidth: 560 }}>
                  As episodes fade, their lessons remain. These are the residues — the part of each decision worth surviving it.
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {withLesson.map(e => (
                    <button key={e.id} onClick={() => openDecision(e)} style={{
                      textAlign: "left", background: "rgba(94,212,212,0.04)", border: `1px solid ${CYAN}1f`,
                      borderLeft: `2px solid ${CYAN}66`, borderRadius: 10, padding: "12px 15px",
                      cursor: "pointer", fontFamily: "inherit", transition: "all 0.2s",
                      display: "flex", flexDirection: "column", gap: 4, opacity: e.retention === "compress" ? 0.7 : 1
                    }}
                    onMouseEnter={ev => ev.currentTarget.style.borderLeftColor = CYAN}
                    onMouseLeave={ev => ev.currentTarget.style.borderLeftColor = `${CYAN}66`}
                    >
                      <span style={{ fontSize: 12.5, color: "#7fb8b8", lineHeight: 1.55, fontStyle: "italic" }}>{e.lesson}</span>
                      <span style={{ fontSize: 10, color: "#3a3a4a" }}>{(e.decision || e.summary || "").slice(0, 70)} · {new Date(e.timestamp).toLocaleDateString("en-GB", { month: "short", year: "numeric" })}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Emergent clusters — only shown when the maths genuinely finds them */}
            {clusters.length > 0 && (
              <div style={{ marginBottom: 28 }}>
                <div style={{ fontSize: 10, color: PURPLE_BRIGHT, letterSpacing: 3, fontWeight: 600, marginBottom: 6, opacity: 0.8 }}>SHAPES IN WHAT SURVIVED</div>
                <p style={{ fontSize: 12.5, color: "#555", lineHeight: 1.6, marginBottom: 16, maxWidth: 560 }}>
                  Patterns that only appear once forgetting has done its work — visible because these traces survived together, not in any single decision.
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {clusters.map((c, i) => (
                    <div key={i} style={{
                      background: "linear-gradient(135deg, rgba(124,92,191,0.07), rgba(94,212,212,0.03))",
                      border: `1px solid ${PURPLE}33`, borderLeft: `2px solid ${PURPLE_BRIGHT}88`,
                      borderRadius: 2, padding: "16px 18px"
                    }}>
                      <div style={{ fontSize: 9, color: PURPLE_BRIGHT, letterSpacing: 2, fontWeight: 700, marginBottom: 8, opacity: 0.7 }}>
                        {c.kind === "archetype" ? "RECURRING DECISION TYPE" : c.kind === "failure_mode" ? "RECURRING FAILURE MODE" : "RECURRING OUTCOME"} · {c.members.length} TRACES
                      </div>
                      <p style={{ fontSize: 13.5, color: "#bbb", lineHeight: 1.65, margin: "0 0 10px" }}>{c.fact}</p>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {c.members.slice(0, 6).map(m => (
                          <button key={m.id} onClick={() => openDecision(m)} style={{
                            background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.06)",
                            borderRadius: 6, padding: "5px 10px", cursor: "pointer", fontFamily: "inherit",
                            fontSize: 10.5, color: "#777", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
                          }}>{(m.decision || m.summary || "").slice(0, 32)}</button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {clusters.length === 0 && memory.length >= 4 && (
              <p style={{ fontSize: 12, color: "#3a3a4a", lineHeight: 1.7, fontStyle: "italic", textAlign: "center", padding: "8px 0 20px", maxWidth: 520, margin: "0 auto" }}>
                Nothing has yet survived in a shared shape. Vestige won't invent a pattern to seem clever — when one genuinely emerges from what you keep and what fades, it'll appear here.
              </p>
            )}

            {withLesson.length === 0 && (
              <p style={{ fontSize: 12.5, color: "#3a3a4a", lineHeight: 1.7, fontStyle: "italic", textAlign: "center", padding: "20px 0" }}>
                No residue yet. Lessons form when you log a post-mortem — they're what survives after a decision fades.
              </p>
            )}
          </div>
        );
      })()}

      {/* INSIGHTS */}
      {view === "insights" && (
        <div style={{ maxWidth: 720, margin: "0 auto", padding: "calc(104px + var(--safe-top)) 20px calc(80px + var(--safe-bottom))", animation: "fadeUp 0.4s ease" }}>
          <div style={{ marginBottom: 28 }}>
            <Btn variant="ghost" onClick={() => setView("history")} style={{ padding: "8px 0", fontSize: 13, marginBottom: 16 }}>← Back to History</Btn>
            <div style={{ fontSize: 10, color: CYAN, letterSpacing: 4, fontWeight: 600, marginBottom: 10, opacity: 0.7 }}>META-ANALYSIS</div>
            <h2 style={{
              fontFamily: "'Instrument Serif', Georgia, serif",
              fontSize: "clamp(34px, 5vw, 44px)", fontWeight: 400,
              letterSpacing: "-0.02em", color: "#fff", marginBottom: 8, lineHeight: 1.1
            }}>What you're missing.</h2>
            <p style={{ fontSize: 13, color: "#444", letterSpacing: "0.02em" }}>High-level patterns across {memory.length} decisions in your memory</p>
          </div>

          {!insights && !insightsLoading && (
            <div style={{ textAlign: "center", padding: "60px 20px" }}>
              <p style={{ fontSize: 14, color: "#aaa", marginBottom: 20, lineHeight: 1.6 }}>
                Vestige can scan your decision history to surface patterns you might not see yourself — recurring blind spots, persistent biases, process anti-patterns that correlate with worse outcomes.
              </p>
              <Btn variant="primary" onClick={generateInsights} disabled={memory.length < 3}>
                {memory.length < 3 ? "Need 3+ decisions" : "Generate insights"}
              </Btn>
            </div>
          )}

          {insightsLoading && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: "80px 20px" }}>
              <div style={{ width: 32, height: 32, borderRadius: "50%", border: `2px solid ${CYAN}22`, borderTopColor: CYAN, animation: "spin 0.9s linear infinite" }} />
              <p style={{ fontSize: 13, color: "#444", fontStyle: "italic" }}>Analysing your decision patterns...</p>
            </div>
          )}

          {insights && insights.length > 0 && (
            <>
              <div style={{
                background: "linear-gradient(135deg, rgba(94,212,212,0.06), rgba(124,92,191,0.04))",
                border: "1px solid rgba(94,212,212,0.15)",
                borderRadius: 2, padding: "18px 20px", marginBottom: 20
              }}>
                <div style={{ fontSize: 10, color: CYAN, letterSpacing: 3, fontWeight: 600, marginBottom: 8, opacity: 0.8 }}>CONTEXT</div>
                <p style={{ fontSize: 13, color: "#888", lineHeight: 1.6, margin: 0 }}>
                  These insights are based on your {memory.length} decisions in memory. The more you analyse and follow up on decisions, the sharper these patterns become.
                </p>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                {insights.map((insight, i) => (
                  <InsightCard key={i} insight={insight} index={i} />
                ))}
              </div>

              <div style={{ display: "flex", justifyContent: "center", gap: 10, marginTop: 24 }}>
                <Btn variant="secondary" onClick={generateInsights}>Re-generate</Btn>
                <Btn variant="ghost" onClick={() => setInsights(null)}>Clear</Btn>
              </div>
            </>
          )}

          {insights && insights.length === 0 && !insightsLoading && (
            <div style={{ textAlign: "center", padding: "40px 20px" }}>
              <p style={{ fontSize: 13, color: "#666", lineHeight: 1.6 }}>
                No clear patterns yet. Insights improve as you build more decision history and follow up with post-mortems.
              </p>
            </div>
          )}
        </div>
      )}

      {/* LENSES */}
      {view === "lenses" && (
        <div style={{ maxWidth: 720, margin: "0 auto", padding: "calc(104px + var(--safe-top)) 20px calc(80px + var(--safe-bottom))", animation: "fadeUp 0.4s ease" }}>
          <div style={{ marginBottom: 28 }}>
            <Btn variant="ghost" onClick={() => { setView("analyse"); setShowCreateLens(false); }} style={{ padding: "8px 0", fontSize: 13, marginBottom: 16 }}>← Back</Btn>
            <div style={{ fontSize: 10, color: CYAN, letterSpacing: 4, fontWeight: 600, marginBottom: 10, opacity: 0.7 }}>ANALYTICAL LENSES</div>
            <h2 style={{
              fontFamily: "'Instrument Serif', Georgia, serif",
              fontSize: "clamp(34px, 5vw, 44px)", fontWeight: 400,
              letterSpacing: "-0.02em", color: "#fff", marginBottom: 8, lineHeight: 1.1
            }}>Your frameworks.</h2>
            <p style={{ fontSize: 13, color: "#444", letterSpacing: "0.02em" }}>Custom analytical lenses to stress-test decisions</p>
          </div>

          {!showCreateLens ? (
            <>
              {lenses.length > 0 && (
                <div style={{ marginBottom: 24 }}>
                  <div style={{ fontSize: 10, color: PURPLE_BRIGHT, letterSpacing: 3, fontWeight: 600, marginBottom: 12, opacity: 0.7 }}>SAVED LENSES ({lenses.length})</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                    {lenses.map((lens, i) => (
                      <LensCard key={lens.id} lens={lens} onDelete={deleteLens} />
                    ))}
                  </div>
                </div>
              )}
              <div style={{ textAlign: "center", padding: "20px 0" }}>
                <Btn variant="primary" onClick={() => setShowCreateLens(true)}>Create new lens</Btn>
              </div>
            </>
          ) : (
            <div style={{
              background: "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)",
              backdropFilter: "blur(20px)",
              border: `1px solid ${CYAN}33`,
              borderRadius: 2, padding: "24px 22px", marginBottom: 20
            }}>
              <h3 style={{ fontSize: 16, color: "#bbb", marginBottom: 20, fontWeight: 600 }}>New Lens</h3>

              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 10, color: "#888", letterSpacing: 2, fontWeight: 600, marginBottom: 8 }}>LENS NAME</div>
                <input
                  type="text"
                  value={newLensName}
                  onChange={e => setNewLensName(e.target.value)}
                  placeholder="e.g., Regulatory Risk Assessment, Customer Impact, Team Readiness"
                  style={{
                    width: "100%", background: "rgba(0,0,0,0.25)",
                    border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10,
                    padding: "12px 14px", color: "#ccc", fontSize: 13, lineHeight: 1.6,
                    fontFamily: "inherit"
                  }}
                />
              </div>

              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 10, color: "#888", letterSpacing: 2, fontWeight: 600, marginBottom: 8 }}>CORE QUESTION</div>
                <textarea
                  value={newLensPrompt}
                  onChange={e => setNewLensPrompt(e.target.value)}
                  placeholder="What question does this lens answer? e.g., 'What are the regulatory risks if we proceed?'"
                  rows={2}
                  style={{
                    width: "100%", background: "rgba(0,0,0,0.25)",
                    border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10,
                    padding: "12px 14px", color: "#ccc", fontSize: 13, lineHeight: 1.6,
                    resize: "none", fontFamily: "inherit"
                  }}
                />
              </div>

              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 10, color: "#888", letterSpacing: 2, fontWeight: 600, marginBottom: 8 }}>INSTRUCTIONS</div>
                <textarea
                  value={newLensInstructions}
                  onChange={e => setNewLensInstructions(e.target.value)}
                  placeholder="How should Vestige apply this lens? What should it focus on? Any specific frameworks or models to use?"
                  rows={3}
                  style={{
                    width: "100%", background: "rgba(0,0,0,0.25)",
                    border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10,
                    padding: "12px 14px", color: "#ccc", fontSize: 13, lineHeight: 1.6,
                    resize: "none", fontFamily: "inherit"
                  }}
                />
              </div>

              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 10, color: "#888", letterSpacing: 2, fontWeight: 600, marginBottom: 8 }}>EXAMPLES (OPTIONAL)</div>
                <textarea
                  value={newLensExamples}
                  onChange={e => setNewLensExamples(e.target.value)}
                  placeholder="Examples of how this lens has been applied before, or example frameworks to reference..."
                  rows={2}
                  style={{
                    width: "100%", background: "rgba(0,0,0,0.25)",
                    border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10,
                    padding: "12px 14px", color: "#ccc", fontSize: 13, lineHeight: 1.6,
                    resize: "none", fontFamily: "inherit"
                  }}
                />
              </div>

              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <Btn variant="ghost" onClick={() => setShowCreateLens(false)}>Cancel</Btn>
                <Btn 
                  variant="primary" 
                  onClick={() => {
                    if (!newLensName || !newLensPrompt || !newLensInstructions) {
                      showToast("Fill in name, question, and instructions");
                      return;
                    }
                    saveLensToLibrary({
                      name: newLensName,
                      prompt: newLensPrompt,
                      instructions: newLensInstructions,
                      examples: newLensExamples
                    });
                  }}
                  disabled={!newLensName || !newLensPrompt || !newLensInstructions}
                >
                  Save lens
                </Btn>
              </div>
            </div>
          )}

          {lensResults && (
            <div style={{
              background: "linear-gradient(135deg, rgba(94,212,212,0.04), rgba(13,13,22,0.5))",
              border: "1px solid rgba(94,212,212,0.15)",
              borderRadius: 2, padding: "24px 22px", marginTop: 24
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <h3 style={{ fontSize: 14, color: CYAN, margin: 0, fontWeight: 600 }}>{lensResults.lens_name} Results</h3>
                <button onClick={() => setLensResults(null)} style={{
                  background: "none", border: "none", color: "#444", fontSize: 11,
                  cursor: "pointer", fontFamily: "inherit", padding: 0
                }}>Close</button>
              </div>

              <p style={{ fontSize: 13.5, color: "#888", lineHeight: 1.75, margin: "0 0 16px" }}>
                {lensResults.analysis}
              </p>

              {lensResults.key_findings && lensResults.key_findings.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 9, color: CYAN, letterSpacing: 2, fontWeight: 600, marginBottom: 10, opacity: 0.7 }}>KEY FINDINGS</div>
                  <ul style={{ padding: "0 0 0 20px", margin: 0 }}>
                    {lensResults.key_findings.map((f, i) => (
                      <li key={i} style={{ fontSize: 12, color: "#777", lineHeight: 1.6, marginBottom: 6 }}>{f}</li>
                    ))}
                  </ul>
                </div>
              )}

              {lensResults.recommendations && (
                <div style={{
                  background: `${CYAN}08`,
                  border: `1px solid ${CYAN}22`,
                  borderRadius: 10, padding: "14px 16px"
                }}>
                  <div style={{ fontSize: 9, color: CYAN, letterSpacing: 2, fontWeight: 600, marginBottom: 8, opacity: 0.7 }}>NEXT STEPS</div>
                  <p style={{ fontSize: 12, color: "#888", lineHeight: 1.6, margin: 0 }}>{lensResults.recommendations}</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* FOOTER */}
      {view !== "loading" && (
        <div style={{
          textAlign: "center", padding: "48px 24px 32px",
          borderTop: "1px solid rgba(255,255,255,0.04)",
          marginTop: 48,
          position: "relative", zIndex: 1
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginBottom: 8 }}>
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none" style={{ opacity: 0.45 }}>
              <path d="M3 5 L16 27 L29 5" stroke={PURPLE_BRIGHT} strokeWidth="3" strokeLinecap="square" strokeLinejoin="miter" fill="none" />
              <circle cx="16" cy="16" r="3" fill={PURPLE_BRIGHT} />
            </svg>
            <div style={{
              fontFamily: "'Instrument Serif', Georgia, serif",
              fontSize: 14, color: "#3a3a4a", fontWeight: 400,
              letterSpacing: "-0.01em"
            }}>Vestige</div>
          </div>
          <div style={{ fontSize: 9, color: "#1e1e28", letterSpacing: 5, fontWeight: 600 }}>
            DECISION INTELLIGENCE
          </div>
        </div>
      )}
    </div>
  );
}

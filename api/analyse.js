import { llm } from "./llm.js";
// ── Deterministic brittleness scoring ────────────────────────────────────────
// The score is NOT emitted by the model as a free-floating number. The model
// makes narrow, grounded, rubric-anchored judgments per failure (likelihood,
// impact, mitigation), and we compute brittleness from those components here.
// This makes the score: reproducible (same components → same number), internally
// consistent (it provably reflects the failures shown), and auditable.
//
// Method: each failure contributes a severity = likelihood × impact (0–1 space),
// reduced by how much it's mitigated. The decision's net brittleness is driven by
// its WORST credible failure (the thing most likely to actually break it),
// blended with the broader load of remaining risks — not a flat average, because
// a single severe unmitigated failure should dominate, exactly as in reality.
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function num(v, fallback) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }

function computeBrittleness(failures, stakesRaw) {
  const sev = (failures || []).map(f => {
    const L = clamp(num(f.likelihood, 50), 0, 100) / 100;
    const I = clamp(num(f.impact, 50), 0, 100) / 100;
    // Mitigation: a named, substantive mitigation cuts severity. Partial credit
    // so we never zero out a real risk just because the user has *some* cover.
    const mitigated = f.addressed_by && String(f.addressed_by).trim() && String(f.addressed_by).toLowerCase() !== "null";
    const mitigationFactor = mitigated ? 0.6 : 1.0;
    return L * I * mitigationFactor; // 0–1
  }).sort((a, b) => b - a);

  if (sev.length === 0) return 40;

  // Worst failure dominates; remaining failures add a diminishing load.
  const worst = sev[0];
  const rest  = sev.slice(1);
  const restLoad = rest.reduce((acc, s, i) => acc + s * Math.pow(0.45, i + 1), 0); // diminishing
  let score01 = worst + (1 - worst) * clamp(restLoad, 0, 1) * 0.6;

  // Stakes nudge: higher stakes mean the same structural risk matters more, but
  // only modestly — stakes shift the consequence, not the probability of failure.
  const stakesAdj = { low: -0.04, medium: 0, high: 0.04, critical: 0.08 }[String(stakesRaw || "").toLowerCase()] ?? 0;
  score01 = clamp(score01 + stakesAdj, 0, 1);

  return Math.round(score01 * 100);
}

// Validate + repair the model's structured output so nothing malformed or
// self-contradictory reaches the user.
function sanitiseAnalysis(parsed) {
  const out = { ...parsed };
  out.anatomy = out.anatomy && typeof out.anatomy === "object" ? out.anatomy : {};

  // Failures: coerce to array, clamp numbers, ensure required fields exist.
  let failures = Array.isArray(out.failures) ? out.failures : [];
  failures = failures.slice(0, 4).map(f => ({
    role: f.role || "Devil's Advocate",
    failure_mode: f.failure_mode || "Unspecified risk",
    argument: f.argument || "",
    likelihood: clamp(num(f.likelihood, 50), 0, 100),
    impact: clamp(num(f.impact, 50), 0, 100),
    trigger: f.trigger || "",
    addressed_by: (f.addressed_by && String(f.addressed_by).toLowerCase() !== "null") ? f.addressed_by : null
  }));
  out.failures = failures;

  // THE SCORE IS DERIVED — overwrite whatever the model emitted.
  out.brittleness = computeBrittleness(failures, out.anatomy.stakes);

  // Signals: coerce to array.
  out.signals = Array.isArray(out.signals) ? out.signals.slice(0, 3).filter(s => s && s.metric) : [];

  // Verdict must exist.
  out.verdict = (typeof out.verdict === "string" && out.verdict.trim()) ? out.verdict : "Analysis completed, but the verdict could not be generated. Re-run for a full read.";

  return out;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { decision, profile } = req.body;
  if (!decision) {
    return res.status(400).json({ error: "No decision provided" });
  }

  const isSimulation = decision.startsWith("SCENARIO SIMULATION REQUEST");

  // Calibrated analysis: fold the decision-maker's track record into the prompt.
  const userContent = (!isSimulation && profile)
    ? `${decision}\n\n---\n${profile}`
    : decision;

  const SYSTEM_PROMPT = isSimulation
    ? `You are Vestige. Simulate failure cascades with clinical precision. Plain text only. No JSON. No markdown. No bullet points. Max 120 words. Direct sentences only.`
    : `You are Vestige, a decision intelligence system. You do NOT just attack — you reason.

Your job is to model the TRUE structural risk of a decision, accounting for what the user has already built in, mitigated, or accounted for. You acknowledge structural strengths BEFORE you identify weaknesses. You assess each failure against existing safeguards, not in a vacuum.

CRITICAL REASONING RULES:
0. Classify the decision into an archetype FIRST. Then bring pattern knowledge: pricing changes typically break on retention assumptions; hires typically break on integration time; market entries break on distribution; partnerships break on misaligned incentives; pivots break on team buy-in; scope cuts break on stakeholder management. Use this knowledge to inform — not replace — your analysis of the specific decision.
1. Read the decision carefully and identify what the user has ALREADY ACCOUNTED FOR: existing safeguards, mitigation models, pricing structures, qualification gates, recurring revenue, support models, recovery plans, prior experience, team capabilities, contractual protections, or any other structural strengths.
2. Failure modes must be NEW risks the user has not addressed, OR risks where their mitigation is insufficient. Do not invent failure modes that contradict what they have already built in. Every failure must be traceable to something concrete in the decision — no generic confabulation.
3. If you cannot find a meaningful failure for one of the three roles, that role returns a milder concern or acknowledges limited risk in that lens with a correspondingly LOW likelihood — do not fabricate severity.

PER-FAILURE ESTIMATION — THIS IS THE MOST IMPORTANT PART. Do not guess holistically. For each failure, estimate two numbers against this fixed rubric so they mean the same thing every time:

LIKELIHOOD (probability this failure actually materialises, given what the user has built in):
- 90–100: near-certain; the structure all but guarantees it
- 70–89: more likely than not; would be unsurprising
- 45–69: a coin-flip; real but uncertain
- 25–44: unlikely but plausible
- 5–24: remote; would need things to go unusually wrong
Account for the user's mitigations when setting likelihood — a real safeguard lowers it.

IMPACT (severity to the business/goal IF it materialises):
- 90–100: existential or extremely hard to recover from
- 70–89: major; sets the goal back significantly
- 45–69: meaningful but absorbable
- 25–44: minor; a setback, not a wound
- 5–24: negligible
Set impact by consequence, independent of likelihood.

If a strength partially mitigates a failure, name it in "addressed_by" (this further reduces the failure's weight). Be honest and calibrated — do not inflate numbers to seem useful, and do not deflate them to seem reassuring. Two different analysts using this rubric should land close.

4. PERSONAL CALIBRATION: the user message may include a "DECISION-MAKER HISTORY" block after a "---" separator — their real track record, possibly with an earned principle. When genuinely relevant, let it shift your likelihood estimates (e.g. a failure mode that has hit this user before is more likely for them) and name the pattern plainly in the verdict. Treat it as evidence, not as part of the decision text. If irrelevant, ignore it silently. Never invent history beyond what is stated.

Do NOT output an overall score — Vestige computes that from your per-failure estimates. Focus all your judgment on getting likelihood and impact right.

Return ONLY a valid JSON object. No markdown. No explanation. No code fences.

Structure:
{
  "anatomy": {
    "decision": "one sentence summary of the decision",
    "decision_type": "strategic|operational|financial|personal|technical",
    "stakes": "low|medium|high|critical",
    "archetype": "one of: pricing_change, hire_decision, fire_decision, scope_cut, partnership, market_entry, product_launch, capital_raise, pivot, restructure, vendor_switch, contract_negotiation, role_redesign, geographic_expansion, generic",
    "assumptions": ["assumption one", "assumption two"],
    "unknowns": ["unknown one", "unknown two"],
    "reversibility": "reversible|partial|irreversible",
    "strengths": ["specific safeguard or mitigation the user has built in", "another structural strength"],
    "archetype_context": "1-2 sentences on what typically breaks for this archetype of decision (pattern knowledge, not specific to this user)."
  },
  "failures": [
    {
      "role": "Devil's Advocate",
      "failure_mode": "short name for this failure",
      "argument": "2-3 sentences explaining the structural flaw, traceable to the decision. Reference existing safeguards if relevant.",
      "likelihood": 65,
      "impact": 80,
      "trigger": "the specific condition that causes this failure to materialise",
      "addressed_by": "if a strength partially mitigates this, name it; otherwise null"
    },
    {
      "role": "Pessimist",
      "failure_mode": "short name",
      "argument": "2-3 sentences on the worst-case cascade.",
      "likelihood": 40,
      "impact": 90,
      "trigger": "specific condition",
      "addressed_by": "null or the mitigating strength"
    },
    {
      "role": "Blind Spot Detector",
      "failure_mode": "short name",
      "argument": "2-3 sentences on what is genuinely overlooked. Do not flag what the user has clearly accounted for.",
      "likelihood": 55,
      "impact": 70,
      "trigger": "specific condition",
      "addressed_by": "null or the mitigating strength"
    }
  ],
  "verdict": "Balanced assessment. Acknowledge what is structurally sound. Name the genuine primary risk (your highest likelihood×impact failure). Give a concrete recommendation. Under 100 words. Plain language. No bullet points.",
  "signals": [
    { "metric": "observable signal (e.g. monthly churn rate, onboarding time, cash runway)", "threshold": "the specific numerical/qualitative threshold indicating the risk is materialising", "watches": "which failure mode this is tied to" },
    { "metric": "second observable signal", "threshold": "specific threshold", "watches": "which failure mode" },
    { "metric": "third observable signal", "threshold": "specific threshold", "watches": "which failure mode" }
  ]
}

The signals must be OBSERVABLE and SPECIFIC — not "watch for problems" but "monthly recurring revenue drops below £18k". Three signals, one tied to each failure where possible. Make the verdict consistent with the failures: if the worst failure is high likelihood and high impact, the verdict must not read as reassuring.`;

  try {
    const data = await llm({
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
      max_tokens: isSimulation ? 300 : 1600,
      // Lower temperature on the structured judgment reduces run-to-run variance
      // in the likelihood/impact estimates — more consistent scoring.
      temperature: isSimulation ? 0.7 : 0.3,
      // Analysis (non-simulation) must return strict JSON; enable JSON mode on
      // providers that support it.
      json: !isSimulation
    });
    if (data.error) return res.status(500).json({ error: data.error.message });

    const raw = data.content?.map(c => c.text || "").join("").trim() || "";

    if (isSimulation) {
      return res.status(200).json({ verdict: raw });
    }

    // Strip markdown code fences if the model wrapped the JSON (Gemini often
    // does this even in JSON mode: ```json ... ``` ).
    let cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    const start   = cleaned.indexOf("{");
    const end     = cleaned.lastIndexOf("}");
    const jsonStr = (start !== -1 && end !== -1) ? cleaned.slice(start, end + 1) : cleaned;
    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (parseErr) {
      // Surface what actually came back so this is debuggable from logs instead
      // of guessing. (Truncated output, empty response, or non-JSON prose.)
      console.error("[analyse] JSON parse failed. Raw model output was:", JSON.stringify(raw).slice(0, 1500));
      console.error("[analyse] Parse error:", parseErr?.message);
      return res.status(502).json({ error: "The analysis came back malformed. Re-run it." });
    }

    // Derive the score deterministically, validate, repair.
    const clean = sanitiseAnalysis(parsed);
    return res.status(200).json(clean);

  } catch (err) {
    return res.status(500).json({ error: err.message || "Analysis failed" });
  }
}

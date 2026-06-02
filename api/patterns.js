import { llm } from "./llm.js";
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { decisions } = req.body;
  if (!decisions || !Array.isArray(decisions) || decisions.length < 3) {
    return res.status(400).json({ error: "Need at least 3 decisions for pattern analysis" });
  }

  const SYSTEM = `You are Vestige, analysing a user's decision history for behavioural patterns. You look for recurring blind spots, biases, and tendencies across their decisions — including comparing their commitments against actual outcomes.

You have access to:
- The decision itself, archetype, stakes, brittleness score, failure modes
- Their COMMITMENT (what move they chose: proceed, modify, waiting, abandon)
- Their POST-MORTEM (what actually happened, did the flagged risk trigger, how accurate Vestige was)

This is calibration data. Use it.

Return ONLY a valid JSON object. No markdown. No code fences.

Structure:
{
  "patterns": [
    {
      "title": "short name for the pattern (e.g. 'Proceeds on high-brittleness decisions')",
      "description": "1-2 sentences explaining the pattern. Reference outcomes where possible (e.g. 'On 4 of 5 high-brittleness analyses, you proceeded anyway — and the flagged risk triggered in 3 of those').",
      "evidence_count": 3,
      "severity": "low|medium|high"
    }
  ],
  "calibration": {
    "vestige_accuracy": "If post-mortem data exists, the average accuracy score (1-5). Otherwise null.",
    "risk_strike_rate": "If post-mortem data exists, what % of flagged risks actually triggered. Otherwise null.",
    "commitment_pattern": "Most common commitment move across their decisions (proceed|modify|waiting|abandon), or null."
  },
  "summary": "One paragraph on this user's decision-making signature. What kind of decision-maker are they? Where do they consistently miscalibrate? What is their characteristic strength? If calibration data exists, weave in how their judgment compares to Vestige's read. Under 100 words. Plain language."
}

CRITICAL RULES:
1. Identify 2-4 patterns maximum. Quality over quantity.
2. Each pattern must be evidenced by multiple decisions. Don't fabricate.
3. PRIORITISE patterns that use commitment + post-mortem data when available — those are the highest-signal insights (e.g. "you proceed on high-risk decisions and they break", "you abandon decisions Vestige scored as structurally sound").
4. Look for: commitment vs brittleness correlation, post-mortem triggers vs Vestige predictions, archetype concentration, recurring failure mode types, stakes calibration.
5. Be specific and direct. Not vague summaries but concrete observations with numbers.
6. If calibration data is missing or insufficient, say so honestly in the summary.
7. Return null for any calibration field where data doesn't support a real answer.`;

  try {
        const data = await llm({
      system: SYSTEM,
      messages: [{ role: "user", content: `Analyse these ${decisions.length} decisions for patterns:

${JSON.stringify(decisions, null, 2)}` }],
      max_tokens: 1000,
      json: true
    });

    if (data.error) return res.status(500).json({ error: data.error.message });

    const raw = data.content?.map(c => c.text || "").join("").trim() || "";
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    const jsonStr = (start !== -1 && end !== -1) ? raw.slice(start, end + 1) : raw;
    const parsed = JSON.parse(jsonStr);
    return res.status(200).json(parsed);

  } catch (err) {
    return res.status(500).json({ error: err.message || "Pattern analysis failed" });
  }
}

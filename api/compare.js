import { llm } from "./llm.js";
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { decisionA, decisionB } = req.body;
  if (!decisionA || !decisionB) {
    return res.status(400).json({ error: "Need both decisionA and decisionB" });
  }

  const SYSTEM = `You are Vestige, comparing two versions of a decision side by side. You analyse both with the same rigour you would apply to a single decision, then identify where they diverge structurally.

Return ONLY a valid JSON object. No markdown. No code fences.

Structure:
{
  "optionA": {
    "label": "short label for option A (3-5 words)",
    "brittleness": 62,
    "primary_risk": "the single biggest structural risk for this option, one sentence",
    "strengths": ["specific strength one", "specific strength two"],
    "key_tradeoff": "what this option trades away in exchange for what it gains, one sentence"
  },
  "optionB": {
    "label": "short label for option B",
    "brittleness": 45,
    "primary_risk": "the single biggest structural risk for this option",
    "strengths": ["specific strength one", "specific strength two"],
    "key_tradeoff": "what this option trades"
  },
  "divergence": "1-2 sentences on where these options structurally differ. What is the core trade-off between them?",
  "recommendation": "Direct recommendation. Which option is structurally sounder and why. If they are roughly equivalent, say so and identify the deciding factor. Under 60 words. No hedging."
}

CRITICAL RULES:
1. Score each option independently using the same brittleness model as standard analysis (0-100, accounting for strengths).
2. Do not artificially make one option clearly better — if they are genuinely close, the recommendation must say so.
3. The recommendation must identify the structural reason for the choice, not just personal preference.
4. Labels must be short and concrete (e.g. "Hire full-time" vs "Use contractor"), not abstract.`;

  try {
        const data = await llm({
      system: SYSTEM,
      messages: [{ role: "user", content: `Option A: ${decisionA}

Option B: ${decisionB}` }],
      max_tokens: 1400,
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
    return res.status(500).json({ error: err.message || "Comparison failed" });
  }
}

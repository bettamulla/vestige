import { llm } from "./llm.js";
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { history } = req.body;
  if (!history || !Array.isArray(history) || history.length === 0) {
    return res.status(400).json({ error: "Missing or invalid history array" });
  }

  const MAX_TOKENS = 2000;
  const MAX_INSIGHTS = 4;

  const SYSTEM = `You are Vestige, an AI assistant that generates strategic insights and recommendations by analyzing a user's decision-making history. 

Given an array of the user's past decisions (including analyses, outcomes, and reflections), look for high-level patterns, tendencies, and areas for improvement in their decision-making process and outcomes over time.

Aim to generate a small number (3-4) of high-value, actionable insights that the user might not have noticed themselves. For each insight, provide:
- A clear, one-sentence statement of the insight
- A short (30-50 word) elaboration with specific examples from their history
- Actionable suggestions for how they might address this in future decisions

Examples of potential insights:
- Identifying persistent cognitive biases or blindspots in their analyses
- Noticing patterns in the types of decisions that tend to go well vs poorly for them
- Surfacing recurring stakeholder tensions or org dynamics that often derail their initiatives
- Highlighting subtle assumptions they often make that don't hold up in practice
- Spotting process anti-patterns (like skipping key steps) that correlate with worse outcomes

Favor insights that are:
- Non-obvious (patterns or connections the user might not see themselves)
- Constructive and actionable (can be used to concretely improve future decisions)
- Grounded in specifics from their actual history (not just generic advice)
- High-level and cross-cutting (not just about a single decision in isolation)

Do NOT simply summarize their decisions or restate the overall metrics. The goal is to provide novel, emergent insights from analyzing their decision-making in aggregate.

Return your insights in the following format:

{
  "insights": [
    {
      "headline": "One-sentence statement of the insight",
      "details": "30-50 word elaboration with specific examples from their history",
      "recommendation": "Actionable suggestion for how they might address this going forward"
    },
    {
      "headline": "...",
      "details": "...", 
      "recommendation": "..."
    }
  ]
}

The array should contain at most ${MAX_INSIGHTS} insight objects. If there aren't enough meaningful insights to generate, return fewer.

Only return the JSON object, with no other text, markdown, or code blocks before or after it.`;

  try {
    // Prepare history data for the prompt
    const serializedHistory = history.map(entry => `DECISION: ${entry.decision}
ARCHETYPE: ${entry.archetype}
STAKEHOLDERS: ${entry.stakeholders || '(not specified)'}
ORIGINAL SCORE: ${entry.brittleness}
CONVERSATION DEPTH: ${entry.thread.length} messages
OUTCOME: ${entry.postMortem ? `${entry.postMortem.outcome} (Vestige accuracy: ${entry.postMortem.accuracy}/5, risk triggered: ${entry.postMortem.triggered})` : '(no post-mortem)'}
KEY REFLECTION: ${entry.postMortem?.notes || '(none)'}
---
`).join('\n');

    const prompt = `Analyze the following decision history to generate high-level insights and recommendations for this user:

${serializedHistory}`;

    const data = await llm({
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
      max_tokens: MAX_TOKENS,
      json: true
    });
    if (data.error) return res.status(500).json({ error: data.error.message });

    const rawOutput = data.content?.map(c => c.text || "").join("").trim() || "";

    // Parse entire output as JSON to extract the insights array
    const parsedResponse = JSON.parse(rawOutput);
    const insights = parsedResponse.insights;

    return res.status(200).json({ insights });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Insight generation failed" });
  }
}

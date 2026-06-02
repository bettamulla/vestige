import { llm } from "./llm.js";
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { decision, context, lens } = req.body;
  if (!decision || !lens) {
    return res.status(400).json({ error: "Missing decision or lens" });
  }

  const MAX_TOKENS = 1500;

  // Lens is an object with: { name, prompt, instructions, examples }
  const { name, prompt, instructions, examples } = lens;

  const SYSTEM = `You are Vestige, applying a user-defined analytical lens to a decision.

The user has created a custom analytical framework called "${name}".

Here is the framework:
PROMPT: ${prompt}

INSTRUCTIONS: ${instructions}

${examples ? `EXAMPLES:\n${examples}\n` : ""}

Your job is to apply this framework to the decision and context provided, and return a structured analysis that directly addresses the lens's core question or framework.

The analysis should be:
- Grounded in the specific decision and context (not generic advice)
- Focused on answering the lens's core prompt
- Concrete and actionable
- 200-400 words

Return your analysis in this format:

{
  "lens_name": "${name}",
  "analysis": "Your detailed analysis applying the lens to the decision",
  "key_findings": [
    "Finding 1 that directly answers the lens prompt",
    "Finding 2",
    "Finding 3"
  ],
  "recommendations": "Actionable next steps based on this lens"
}

Return only the JSON object, with no other text or markdown.`;

  try {
    const userPrompt = `DECISION:
${decision}

${context ? `CONTEXT:\n${context}\n` : ""}

Now apply the "${name}" lens to this decision.`;

        const data = await llm({
      system: SYSTEM,
      messages: [{ role: "user", content: userPrompt }],
      max_tokens: MAX_TOKENS,
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
    console.error(err);
    return res.status(500).json({ error: err.message || "Lens analysis failed" });
  }
}

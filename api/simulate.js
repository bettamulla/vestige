import { llm } from "./llm.js";
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { decision, context, simulations } = req.body;
  if (!decision || !context || !Array.isArray(simulations) || simulations.length === 0) {
    return res.status(400).json({ error: "Missing required fields: decision, context, simulations" });
  }

  const MAX_TOKENS = 2000;

  const SYSTEM = `You are Vestige, a strategic simulation engine. Your job is to generate detailed, realistic narratives of how different scenarios could plausibly unfold over time, given a specific decision and context.

The user will provide:
- The decision or strategy under consideration 
- Key context about their business, market, customers, etc.
- A set of 1-3 simulation prompts describing scenarios they want you to flesh out

For each simulation prompt, generate a rich, causally coherent story of how that scenario could play out over a realistic timeline. Focus on:
- Key events and turning points
- Moves by major actors (competitors, regulators, customers, etc.) 
- Second and third-order effects
- Realistic human and market responses
- Potential end states (good and bad)

Anchor your stories in the provided context, but feel free to imagine plausible details and developments beyond what's explicitly given. The goal is vividness and plausibility, not just reciting facts.

Bring in relevant knowledge from your training where appropriate to add color and texture (industry benchmarks, historical analogies, academic frameworks, etc.) but always filter it through the lens of the user's specific situation.

For each story, write in the style of a strategic narrative or future history, not a dry bullet point list. Use concrete prose, dialogue, and scene-setting to make it feel real and visceral. Aim for 200-400 words per story.

Return your outputs as an array of story objects, using this format:

[
  {
    "prompt": "User's original prompt",
    "story": "Your generated story here, formatted as a single string with paragraph breaks",
    "key_events": [
      "Event 1 summarizing a key turning point in the narrative",
      "Event 2 etc."
    ],
    "final_state": "Brief description of the end state this story reaches"
  },
  { "prompt": "...", "story": "...", "key_events": [...], "final_state": "..." },
  { "prompt": "...", "story": "...", "key_events": [...], "final_state": "..." }
]

Do not return any other text, markdown, or code blocks outside the JSON array. The array should be the entire contents of your response.`;

  try {
    const prompt = `DECISION: ${decision}

CONTEXT:
${context}

SIMULATIONS:
${simulations.join("\n")}`;

        const data = await llm({
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
      max_tokens: MAX_TOKENS,
      json: true
    });

    if (data.error) return res.status(500).json({ error: data.error.message });

    const raw = data.content?.map(c => c.text || "").join("").trim() || "";

    // Parse the entire response as JSON - the model should return only a valid JSON array
    const parsed = JSON.parse(raw);

    return res.status(200).json({ simulations: parsed });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Simulation failed" });
  }
}

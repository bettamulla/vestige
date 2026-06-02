import { llm } from "./llm.js";
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { entry } = req.body;
  if (!entry || !entry.thread || entry.thread.length < 2) {
    return res.status(400).json({ error: "Need a decision with thread history" });
  }

  const SYSTEM = `You are Vestige, analysing a single decision's full conversation thread. You are looking at one decision the user is working through — the original analysis, all follow-up questions they asked, all your replies, and how the brittleness score has evolved.

Your job is to surface what the conversation itself reveals: where the user's thinking shifted, what questions they keep circling, what they haven't asked but should, where Vestige's view changed and why.

Return ONLY a valid JSON object. No markdown. No code fences.

Structure:
{
  "thread_signature": "One paragraph describing how this conversation has unfolded. What is the user actually wrestling with? Where is their thinking centred? Have they engaged deeply or stayed surface-level? Under 80 words.",
  "shifts": [
    {
      "type": "score_shift|reframe|new_consideration|risk_resolved",
      "description": "What changed and why",
      "magnitude": "low|medium|high"
    }
  ],
  "unresolved": [
    "A risk or question that came up but was not fully addressed in the conversation",
    "Another unresolved thread"
  ],
  "blind_spots": [
    "Something the user has not asked about but should, given what they have discussed"
  ],
  "convergence": {
    "status": "converging|diverging|stuck",
    "explanation": "Are they moving toward clarity, opening new fronts of doubt, or going in circles? One sentence."
  },
  "next_question": "The single most useful follow-up question the user should ask Vestige next, given where the conversation is. One sentence, direct."
}

CRITICAL RULES:
1. Be specific and grounded in what actually appears in the thread. Do not fabricate shifts or unresolved items.
2. If the thread is short or surface-level, say so honestly in the thread_signature. Empty arrays are fine.
3. shifts should be 0-4 entries, only including genuine moments of change.
4. unresolved should be 0-3 entries, only real loose ends.
5. blind_spots should be 0-2 entries, things the user is clearly not seeing.
6. The next_question should be the question that would unlock the most clarity given the conversation so far.`;

  const threadText = (entry.thread || []).map(m => {
    if (m.type === "decision") return `[USER - INITIAL DECISION]\n${m.content}`;
    if (m.type === "analysis") return `[VESTIGE - INITIAL VERDICT, brittleness ${m.brittleness}/100]\n${m.verdict}`;
    if (m.type === "message") return `[USER]\n${m.content}`;
    if (m.type === "vestige_reply") {
      const scoreNote = m.updatedScore ? ` (Updated risk: ${m.updatedScore}/100)` : "";
      return `[VESTIGE]${scoreNote}\n${m.content}`;
    }
    return "";
  }).filter(Boolean).join("\n\n");

  const contextPayload = `DECISION ARCHETYPE: ${entry.archetype || "generic"}
STAKES: ${entry.stakes || "unknown"}
ORIGINAL BRITTLENESS: ${entry.brittleness}/100
CURRENT BRITTLENESS: ${entry.currentBrittleness || entry.brittleness}/100
${entry.commitment ? `COMMITMENT: ${entry.commitment.move}` : "NO COMMITMENT YET"}

FULL CONVERSATION THREAD:

${threadText}`;

  try {
        const data = await llm({
      system: SYSTEM,
      messages: [{ role: "user", content: contextPayload }],
      max_tokens: 1200,
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
    return res.status(500).json({ error: err.message || "Thread analysis failed" });
  }
}

import { llm } from "./llm.js";
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { context, messages } = req.body;
  if (!context || !messages) return res.status(400).json({ error: "Missing context or messages" });

  // Enhanced system prompt — follow-up must reason, not just attack further
  const FOLLOWUP_SYSTEM = `${context}

CRITICAL FOLLOW-UP RULES:
1. When the user provides NEW INFORMATION that addresses a previously flagged risk (e.g. "we already have a retainer model", "we built in a qualification step", "we have a support phase"), you MUST acknowledge it directly.
2. State which previously flagged failure mode this resolves or partially resolves.
3. Estimate the NEW brittleness score after accounting for this mitigation. If risk drops, say so. Use the format: "Updated risk: X/100" at the end of your reply.
4. DO NOT invent new failure modes just to maintain a contrarian stance. If the user has genuinely addressed the risks, acknowledge convergence.
5. If a follow-up reveals the original analysis was incomplete (missing context the user has now provided), state that the original score was based on incomplete information.
6. You can still push back on weak reasoning — but push back honestly, not reflexively.
7. Maximum 3 sentences plus the Updated risk line if applicable. No hedging.
8. You are an advisor with integrity, not a contrarian by default.`;

  try {
        const data = await llm({
      system: FOLLOWUP_SYSTEM,
      messages: messages,
      max_tokens: 2048
    });

    if (data.error) return res.status(500).json({ error: data.error.message });

    let reply = data.content?.map(c => c.text || "").join("").trim();

    // Safety net: if the model still hit the token ceiling, the reply would end
    // mid-sentence. Rather than show a fragment (which reads as a broken tool),
    // trim back to the last complete sentence — provided that leaves a usable
    // reply (at least a short sentence), otherwise keep what we have.
    if (data.stop_reason === "max_tokens" && reply) {
      const lastStop = Math.max(reply.lastIndexOf(". "), reply.lastIndexOf("! "), reply.lastIndexOf("? "));
      if (lastStop >= 10) reply = reply.slice(0, lastStop + 1);
    }

    // Try to extract updated score from reply
    let updatedScore = null;
    const match = reply.match(/Updated risk:\s*(\d+)\s*\/\s*100/i);
    if (match) updatedScore = parseInt(match[1], 10);

    return res.status(200).json({ reply, updatedScore });

  } catch (err) {
    return res.status(500).json({ error: err.message || "Follow-up failed" });
  }
}

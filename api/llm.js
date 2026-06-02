// ─────────────────────────────────────────────────────────────────────────────
// LLM adapter — lets every route call one function and not care which provider
// is behind it. Anthropic is the default; if no Anthropic key is set but a
// Gemini key is, Gemini is used instead. The point of this file is to ABSORB the
// differences between the two APIs and always hand routes back the SAME shape
// they already parse:  { content: [{ text }], stop_reason, error? }
//
// Provider selection (automatic, by which key exists):
//   • ANTHROPIC_API_KEY present                      → Anthropic
//   • no Anthropic key, GEMINI_API_KEY present       → Gemini
//   • neither                                        → { error } (caught upstream)
//
// Routes call:  const data = await llm({ system, messages, max_tokens,
//                                         temperature, json });  then read
//               data.content[].text exactly as before.
// ─────────────────────────────────────────────────────────────────────────────

const ANTHROPIC_KEY = () => process.env.ANTHROPIC_API_KEY || "";
const GEMINI_KEY    = () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
const GROK_KEY      = () => process.env.GROK_API_KEY || process.env.XAI_API_KEY || "";

export function activeProvider() {
  if (ANTHROPIC_KEY()) return "anthropic";
  if (GEMINI_KEY()) return "gemini";
  if (GROK_KEY()) return "grok";
  return null;
}

// Default model per provider. Gemini's 1.5/2.0 Flash is the cost-efficient peer
// to the Sonnet tier used here; kept overridable via env for flexibility.
const ANTHROPIC_MODEL = () => process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
const GEMINI_MODEL    = () => process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GROK_MODEL      = () => process.env.GROK_MODEL || "grok-3";

// Normalized error in the same shape routes already check (data.error.message).
function errShape(message) {
  return { error: { message }, content: [] };
}

export async function llm({ system, messages, max_tokens = 1024, temperature = 0.7, json = false }) {
  const provider = activeProvider();
  if (!provider) {
    return errShape("No model API key configured. Set ANTHROPIC_API_KEY, GEMINI_API_KEY, or GROK_API_KEY.");
  }
  try {
    if (provider === "anthropic") return await callAnthropic({ system, messages, max_tokens, temperature });
    if (provider === "gemini") return await callGemini({ system, messages, max_tokens, temperature, json });
    return await callGrok({ system, messages, max_tokens, temperature, json });
  } catch (e) {
    return errShape(e?.message || "Model request failed.");
  }
}

// ── Anthropic ─────────────────────────────────────────────────────────────────
// Returns the native shape, which already matches what routes expect.
async function callAnthropic({ system, messages, max_tokens, temperature }) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY(),
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({ model: ANTHROPIC_MODEL(), max_tokens, temperature, system, messages })
  });
  const data = await r.json();
  if (data?.error) return errShape(data.error.message || "Anthropic error");
  // Already { content: [{type,text}], stop_reason } — pass through.
  return data;
}

// ── Gemini ──────────────────────────────────────────────────────────────────
// Translates the Anthropic-style call into Gemini's format, then maps the
// response BACK to { content: [{ text }], stop_reason } so routes are unchanged.
async function callGemini({ system, messages, max_tokens, temperature, json }) {
  // Anthropic messages → Gemini contents. Roles: "user" stays user, "assistant"
  // becomes "model". System prompt rides in systemInstruction.
  const contents = (messages || []).map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: typeof m.content === "string" ? m.content : String(m.content ?? "") }]
  }));

  const body = {
    contents,
    generationConfig: {
      temperature,
      // Gemini 2.5 models can consume part of the budget on internal reasoning
      // before emitting output. Give generous headroom so structured JSON
      // responses don't get truncated (truncation => unparseable => "malformed").
      maxOutputTokens: Math.max(max_tokens, 4096)
    }
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  // When the route wants strict JSON, use Gemini's native JSON mode — far more
  // reliable than hoping the text parses.
  if (json) body.generationConfig.responseMimeType = "application/json";

  const model = GEMINI_MODEL();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(GEMINI_KEY())}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await r.json();

  if (data?.error) return errShape(data.error.message || "Gemini error");

  const cand = data?.candidates?.[0];
  const text = (cand?.content?.parts || []).map(p => p.text || "").join("");
  // Map Gemini finishReason → the stop_reason vocabulary followup.js checks for.
  const stop_reason = cand?.finishReason === "MAX_TOKENS" ? "max_tokens"
    : cand?.finishReason === "STOP" ? "end_turn"
    : (cand?.finishReason || "end_turn").toLowerCase();

  if (!text) return errShape("Gemini returned an empty response.");
  return { content: [{ type: "text", text }], stop_reason };
}

// ── Grok (xAI) ────────────────────────────────────────────────────────────────
// xAI exposes an OpenAI-compatible chat-completions API. Translate the
// Anthropic-style call into that format, then normalize the response back to
// { content: [{ text }], stop_reason } so routes are unchanged.
async function callGrok({ system, messages, max_tokens, temperature, json }) {
  // Anthropic messages → OpenAI messages. System rides as a leading system msg.
  const oaMessages = [];
  if (system) oaMessages.push({ role: "system", content: system });
  for (const m of (messages || [])) {
    oaMessages.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: typeof m.content === "string" ? m.content : String(m.content ?? "")
    });
  }

  const body = {
    model: GROK_MODEL(),
    messages: oaMessages,
    max_tokens,
    temperature
  };
  // xAI supports OpenAI-style JSON mode for routes that require strict JSON.
  if (json) body.response_format = { type: "json_object" };

  const r = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROK_KEY()}`
    },
    body: JSON.stringify(body)
  });
  const data = await r.json();

  if (data?.error) {
    const msg = typeof data.error === "string" ? data.error : (data.error.message || "Grok error");
    return errShape(msg);
  }

  const choice = data?.choices?.[0];
  const text = choice?.message?.content || "";
  // Map OpenAI finish_reason → the stop_reason vocabulary followup.js checks for.
  const stop_reason = choice?.finish_reason === "length" ? "max_tokens"
    : choice?.finish_reason === "stop" ? "end_turn"
    : (choice?.finish_reason || "end_turn").toLowerCase();

  if (!text) return errShape("Grok returned an empty response.");
  return { content: [{ type: "text", text }], stop_reason };
}

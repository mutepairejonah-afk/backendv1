// Everything else that used to live here (translation, summarization,
// moderation, the drafting/review endpoints, etc.) moved to the `ai`
// Supabase Edge Function -- see supabase/functions/ai and
// supabase/functions/_shared/ai.ts, which is a near-verbatim copy of what
// this file used to be in full.
//
// aiChatReply stays here because src/socket.ts calls it directly for the
// realtime "ai:chat" socket event -- that's a tightly-coupled, same-process
// call on the hot path of an existing live connection, not a standalone HTTP
// endpoint, so round-tripping to a separate Supabase Edge Function for every
// message would add a network hop and re-authentication step for no benefit.
//
// Read environment variables when a request is handled. With native ESM,
// imported modules can be evaluated before index.ts calls dotenv.config().
const getOpenRouterApiKey = () => process.env.OPENROUTER_API_KEY;
const getGeminiApiKey = () => process.env.GEMINI_API_KEY;

async function geminiGenerate(prompt: string, system: string | undefined): Promise<string> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error("No GEMINI_API_KEY set");
  const model = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const systemInstruction = system ? { parts: [{ text: system }] } : undefined;
  const body: any = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 600, temperature: 0.7 },
  };
  if (systemInstruction) body.systemInstruction = systemInstruction;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Gemini error (${res.status}): ${errText}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
  if (!text) throw new Error("Gemini returned an empty response");
  return text;
}

const FREE_MODEL = "meta-llama/llama-3.1-8b-instruct";

function getModel(tier: string): string {
  if (tier === "pro") return process.env.OPENROUTER_MODEL_PRO || "deepseek/deepseek-r1";
  if (tier === "premium") return process.env.OPENROUTER_MODEL_PREMIUM || "deepseek/deepseek-r1:free";
  return process.env.OPENROUTER_MODEL_FREE || FREE_MODEL;
}

async function openRouterGenerate(prompt: string, system: string | undefined, tier: string): Promise<string> {
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) throw new Error("No OPENROUTER_API_KEY set");
  const messages: { role: "system" | "user"; content: string }[] = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });
  const model = getModel(tier);
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-Title": "ChatApp AI Assistant",
    },
    body: JSON.stringify({ model, messages, max_tokens: 600 }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    const isAvailabilityIssue = res.status === 402 || res.status === 404 || res.status === 429;
    if (isAvailabilityIssue && model !== FREE_MODEL) {
      console.warn(`[AI] Model "${model}" unavailable (${res.status}), retrying with free model`);
      return openRouterGenerate(prompt, system, "free");
    }
    throw new Error(`OpenRouter error (${res.status}): ${errText}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) throw new Error("OpenRouter returned an empty response");
  return text;
}

export async function aiGenerate(prompt: string, systemInstruction?: string, tier = "free"): Promise<string> {
  if (getGeminiApiKey()) {
    try {
      return await geminiGenerate(prompt, systemInstruction);
    } catch (err: any) {
      console.warn("[AI] Gemini failed, falling back to OpenRouter:", err?.message || err);
    }
  }
  if (getOpenRouterApiKey()) {
    return openRouterGenerate(prompt, systemInstruction, tier);
  }
  throw new Error("No AI API key configured. Set GEMINI_API_KEY or OPENROUTER_API_KEY.");
}

export async function aiChatReply(
  question: string,
  recentMessages: { sender: string; text: string }[],
  tier = "free"
): Promise<string> {
  const system = `You are a helpful AI assistant inside a messaging app called ChatApp. 
Be concise, friendly, and helpful. Keep replies short (1–3 sentences) unless detail is needed.
You have context of the recent conversation to inform your answer.`;
  const contextStr = recentMessages.length
    ? "Recent conversation context:\n" +
      recentMessages.slice(-6).map((m) => `${m.sender}: ${m.text}`).join("\n") + "\n\n"
    : "";
  const prompt = `${contextStr}User question: ${question}`;
  return aiGenerate(prompt, system, tier);
}

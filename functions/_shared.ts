// Shared helpers for Felisberto Cloudflare Pages Functions.
// Files/dirs beginning with "_" are ignored by Pages routing, so this is safe to import.

export interface Env {
  DB: D1Database;
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
}

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

export function preflight(): Response {
  return new Response(null, { headers: CORS });
}

// Accent-insensitive normalisation.
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// Pull the most keyword-dense excerpt out of a long document.
export function extractExcerpt(text: string, terms: string[], maxLength = 800): string {
  const normalizedText = normalizeText(text);
  let bestStart = 0;
  let bestScore = 0;
  for (let i = 0; i < text.length - 300; i += 100) {
    const chunk = normalizedText.substring(i, i + maxLength);
    let score = 0;
    for (const term of terms) if (chunk.includes(term)) score++;
    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
    }
  }
  return text.substring(bestStart, bestStart + maxLength).trim();
}

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Text chat completion via the Gemini API (free tier: gemini-2.5-flash).
export async function geminiChat(
  env: Env,
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  const model = env.GEMINI_MODEL || "gemini-2.5-flash";
  const res = await fetch(`${GEMINI_BASE}/${model}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    const err = new Error(`Gemini ${res.status}: ${txt}`);
    (err as unknown as { status: number }).status = res.status;
    throw err;
  }

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

// Extract text from an inline PDF using Gemini's multimodal input.
export async function geminiExtractPdf(env: Env, base64: string): Promise<string> {
  const model = env.GEMINI_MODEL || "gemini-2.5-flash";
  const res = await fetch(`${GEMINI_BASE}/${model}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                "Extrai TODO o texto deste documento PDF. Retorna APENAS o texto extraído, sem comentários nem formatação adicional. Mantém a estrutura e os parágrafos do original.",
            },
            { inline_data: { mime_type: "application/pdf", data: base64 } },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Gemini PDF ${res.status}: ${txt}`);
  }

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

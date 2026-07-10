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

const EMBED_MODEL = "models/text-embedding-004";

// Split text into overlapping, sentence-aware chunks for embedding.
export function chunkText(text: string, maxChars = 900, overlap = 150): string[] {
  const clean = text.replace(/[ \t]+\n/g, "\n").trim();
  const segments = clean
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let cur = "";
  for (const seg of segments) {
    if (cur.length + seg.length + 1 > maxChars && cur.length > 0) {
      chunks.push(cur.trim());
      const tail = cur.slice(-overlap);
      cur = (tail + " " + seg).trim();
    } else {
      cur = cur ? cur + " " + seg : seg;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());

  // Hard-split any oversized chunk (e.g. a huge run-on segment).
  const out: string[] = [];
  for (const c of chunks) {
    if (c.length <= maxChars * 1.6) out.push(c);
    else for (let i = 0; i < c.length; i += maxChars - overlap) out.push(c.slice(i, i + maxChars));
  }
  return out;
}

// Embed document chunks (batched). taskType RETRIEVAL_DOCUMENT.
export async function geminiEmbedDocs(env: Env, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 100) {
    const batch = texts.slice(i, i + 100);
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${EMBED_MODEL}:batchEmbedContents`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
          requests: batch.map((t) => ({
            model: EMBED_MODEL,
            content: { parts: [{ text: t }] },
            taskType: "RETRIEVAL_DOCUMENT",
          })),
        }),
      }
    );
    if (!res.ok) throw new Error(`Gemini embed ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { embeddings?: { values: number[] }[] };
    for (const e of data.embeddings ?? []) out.push(e.values);
  }
  return out;
}

// Embed a single query string. taskType RETRIEVAL_QUERY.
export async function geminiEmbedQuery(env: Env, text: string): Promise<number[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/${EMBED_MODEL}:embedContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        model: EMBED_MODEL,
        content: { parts: [{ text }] },
        taskType: "RETRIEVAL_QUERY",
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini embed query ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { embedding?: { values: number[] } };
  return data.embedding?.values ?? [];
}

export function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Chunk + embed + store one document. Replaces any existing chunks for it.
export async function indexDocument(
  env: Env,
  doc: { id: string; titulo: string; conteudo: string }
): Promise<number> {
  const chunks = chunkText(doc.conteudo);
  if (chunks.length === 0) return 0;
  const embeddings = await geminiEmbedDocs(env, chunks);

  await env.DB.prepare("DELETE FROM documento_chunks WHERE documento_id = ?").bind(doc.id).run();

  const stmt = env.DB.prepare(
    "INSERT INTO documento_chunks (documento_id, titulo, seq, chunk, embedding) VALUES (?, ?, ?, ?, ?)"
  );
  const bound = chunks.map((c, i) =>
    stmt.bind(doc.id, doc.titulo, i, c, JSON.stringify(embeddings[i] ?? []))
  );
  for (let i = 0; i < bound.length; i += 50) {
    await env.DB.batch(bound.slice(i, i + 50));
  }
  return chunks.length;
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

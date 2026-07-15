// Shared helpers for Felisberto Cloudflare Pages Functions.
// Files/dirs beginning with "_" are ignored by Pages routing, so this is safe to import.

export interface Env {
  DB: D1Database;
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
  /** Admin password. Set as a SECRET in Cloudflare Pages. Never shipped to the browser. */
  ADMIN_PASSWORD?: string;
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

/* ------------------------------------------------------------------ */
/* Admin authentication (HMAC-signed token, verified server-side)      */
/* ------------------------------------------------------------------ */

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return b64url(new Uint8Array(sig));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Create a signed session token valid for `ttlSeconds` (default 8h). */
export async function createAdminToken(env: Env, ttlSeconds = 8 * 3600): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ exp })));
  const sig = await hmac(env.ADMIN_PASSWORD as string, payload);
  return `${payload}.${sig}`;
}

async function verifyAdminToken(env: Env, token: string): Promise<boolean> {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = await hmac(env.ADMIN_PASSWORD as string, payload);
  if (!timingSafeEqual(sig, expected)) return false;
  try {
    const raw = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const { exp } = JSON.parse(raw) as { exp?: number };
    return typeof exp === "number" && exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

/**
 * Guard for admin-only endpoints. Returns a Response to send back when the
 * request is NOT authorised, or null when it is. Fails closed.
 */
export async function requireAdmin(request: Request, env: Env): Promise<Response | null> {
  if (!env.ADMIN_PASSWORD) {
    return json(
      {
        error:
          "ADMIN_PASSWORD não está configurado. Adicione-o como Secret em Cloudflare Pages → Settings → Variables and Secrets e faça novo deploy.",
      },
      503
    );
  }
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token || !(await verifyAdminToken(env, token))) {
    return json({ error: "Não autorizado. Inicie sessão novamente." }, 401);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Text helpers                                                        */
/* ------------------------------------------------------------------ */

// Accent-insensitive normalisation.
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// Portuguese stopwords + generic question words that add noise to lexical scoring.
const STOPWORDS = new Set([
  "como", "para", "por", "uma", "uns", "umas", "que", "qual", "quais", "quando",
  "onde", "porque", "posso", "pode", "podem", "fazer", "faco", "tenho", "ter",
  "sobre", "isto", "isso", "aqui", "ali", "com", "sem", "dos", "das", "nos",
  "nas", "num", "numa", "meu", "minha", "seu", "sua", "este", "esta", "esse",
  "essa", "aos", "the", "and", "preciso", "gostaria", "queria", "obter",
]);

/** Build stopword-filtered, lightly stemmed search terms. */
export function buildTerms(message: string): string[] {
  const base = normalizeText(message)
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  const stems = base.map((term) => {
    if (term.endsWith("coes")) return term.slice(0, -4);
    if (term.endsWith("oes")) return term.slice(0, -3);
    if (term.endsWith("ade")) return term.slice(0, -3);
    if (term.endsWith("ao")) return term.slice(0, -2);
    if (term.endsWith("es")) return term.slice(0, -2);
    if (term.endsWith("s")) return term.slice(0, -1);
    return term;
  });
  return [...new Set([...base, ...stems])];
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

  const out: string[] = [];
  for (const c of chunks) {
    if (c.length <= maxChars * 1.6) out.push(c);
    else for (let i = 0; i < c.length; i += maxChars - overlap) out.push(c.slice(i, i + maxChars));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Gemini                                                              */
/* ------------------------------------------------------------------ */

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const EMBED_MODEL = "models/gemini-embedding-001";

/**
 * Vector size. 768 keeps quality while using ~4x less storage than the 3072
 * default, which matters because every chat request loads all vectors.
 * Changing this REQUIRES a full reindex (old vectors are ignored, see cosineSim).
 */
export const EMBED_DIM = 768;

// Text chat completion via the Gemini API.
export async function geminiChat(
  env: Env,
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  const model = env.GEMINI_MODEL || "gemini-flash-latest";
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

// Embed a batch of texts to be stored (taskType RETRIEVAL_DOCUMENT).
export async function geminiEmbedDocs(env: Env, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 100) {
    const batch = texts.slice(i, i + 100);
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/${EMBED_MODEL}:batchEmbedContents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        requests: batch.map((t) => ({
          model: EMBED_MODEL,
          content: { parts: [{ text: t }] },
          taskType: "RETRIEVAL_DOCUMENT",
          outputDimensionality: EMBED_DIM,
        })),
      }),
    });
    if (!res.ok) throw new Error(`Gemini embed ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { embeddings?: { values: number[] }[] };
    for (const e of data.embeddings ?? []) out.push(e.values);
  }
  return out;
}

// Embed a single query string (taskType RETRIEVAL_QUERY).
export async function geminiEmbedQuery(env: Env, text: string): Promise<number[]> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/${EMBED_MODEL}:embedContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      model: EMBED_MODEL,
      content: { parts: [{ text }] },
      taskType: "RETRIEVAL_QUERY",
      outputDimensionality: EMBED_DIM,
    }),
  });
  if (!res.ok) throw new Error(`Gemini embed query ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { embedding?: { values: number[] } };
  return data.embedding?.values ?? [];
}

/** Cosine similarity. Returns 0 when dimensions differ (stale index). */
export function cosineSim(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function parseEmbedding(raw: string): number[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Hybrid fusion (Reciprocal Rank Fusion)                              */
/* ------------------------------------------------------------------ */

/**
 * Fuse two rankings of the same ids. RRF is rank-based, so it is robust to the
 * different score scales of lexical vs semantic matching.
 */
export function rrfFuse(
  lexical: { id: string; score: number }[],
  semantic: { id: string; score: number }[],
  k = 60
): Map<string, number> {
  const fused = new Map<string, number>();
  const add = (list: { id: string; score: number }[]) => {
    list
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .forEach((x, i) => {
        fused.set(x.id, (fused.get(x.id) ?? 0) + 1 / (k + i + 1));
      });
  };
  add(lexical);
  add(semantic);
  return fused;
}

/* ------------------------------------------------------------------ */
/* Indexing                                                            */
/* ------------------------------------------------------------------ */

// Chunk + embed + store one document. Replaces any existing chunks for it.
export async function indexDocument(
  env: Env,
  doc: { id: string; titulo: string; conteudo: string }
): Promise<number> {
  const chunks = chunkText(doc.conteudo);
  if (chunks.length === 0) return 0;
  // Prefix the title so each chunk carries document context into the vector.
  const embeddings = await geminiEmbedDocs(env, chunks.map((c) => `${doc.titulo}\n\n${c}`));

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

export function faqEmbedText(f: { pergunta: string; resposta: string }): string {
  return `${f.pergunta}\n\n${f.resposta}`.slice(0, 4000);
}

/** Embed and store one FAQ (used on create/update). */
export async function indexFaq(
  env: Env,
  faq: { id: string; pergunta: string; resposta: string }
): Promise<void> {
  const [vec] = await geminiEmbedDocs(env, [faqEmbedText(faq)]);
  await env.DB.prepare(
    "INSERT INTO faq_embeddings (faq_id, embedding, updated_at) VALUES (?, ?, datetime('now')) " +
      "ON CONFLICT(faq_id) DO UPDATE SET embedding = excluded.embedding, updated_at = datetime('now')"
  )
    .bind(faq.id, JSON.stringify(vec ?? []))
    .run();
}

/** Embed and store every FAQ. Returns how many were indexed. */
export async function indexAllFaqs(env: Env): Promise<number> {
  const res = await env.DB.prepare(
    "SELECT id, pergunta, resposta FROM base_conhecimento"
  ).all<{ id: string; pergunta: string; resposta: string }>();
  const faqs = res.results ?? [];
  if (faqs.length === 0) return 0;

  const vectors = await geminiEmbedDocs(env, faqs.map(faqEmbedText));

  const stmt = env.DB.prepare(
    "INSERT INTO faq_embeddings (faq_id, embedding, updated_at) VALUES (?, ?, datetime('now')) " +
      "ON CONFLICT(faq_id) DO UPDATE SET embedding = excluded.embedding, updated_at = datetime('now')"
  );
  const bound = faqs.map((f, i) => stmt.bind(f.id, JSON.stringify(vectors[i] ?? [])));
  for (let i = 0; i < bound.length; i += 50) {
    await env.DB.batch(bound.slice(i, i + 50));
  }
  return faqs.length;
}

// Extract text from an inline PDF using Gemini's multimodal input.
export async function geminiExtractPdf(env: Env, base64: string): Promise<string> {
  const model = env.GEMINI_MODEL || "gemini-flash-latest";
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

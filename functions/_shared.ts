// Shared helpers for Felisberto Cloudflare Pages Functions.
// Files/dirs beginning with "_" are ignored by Pages routing, so this is safe to import.

export interface Env {
  DB: D1Database;
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
  /**
   * Model used for PDF text extraction. Gemini quotas are PER MODEL, so keeping
   * extraction on a different (cheaper, lighter) model means bulk uploads can
   * never starve the chat of its quota.
   */
  GEMINI_EXTRACT_MODEL?: string;
  /** Lighter model used when the primary is out of quota. Has its own quota pool. */
  GEMINI_MODEL_FALLBACK?: string;
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
/* Hashing (duplicate detection)                                       */
/* ------------------------------------------------------------------ */

export async function sha256(data: Uint8Array | string): Promise<string> {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", buf as unknown as BufferSource);
  const out: string[] = [];
  for (const b of new Uint8Array(digest)) out.push(b.toString(16).padStart(2, "0"));
  return out.join("");
}

/**
 * Content fingerprint: whitespace-insensitive, so the same document re-exported
 * or re-saved still matches. Used to spot duplicates uploaded under a different
 * file name.
 */
export function textFingerprint(text: string): string {
  return text.replace(/\s+/g, " ").trim();
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
 * Vector size. 512 balances quality against the Workers free-plan CPU budget
 * (10ms/request). Vectors are stored packed as base64 float32 (~2.7KB each)
 * instead of JSON (~10KB), which makes decoding an order of magnitude cheaper.
 * Changing this REQUIRES a full reindex (old vectors are ignored, see unpackVector).
 */
export const EMBED_DIM = 512;

// Text chat completion. Falls back to the lighter model when out of quota.
export async function geminiChat(
  env: Env,
  systemPrompt: string,
  userMessage: string,
  models?: string[]
): Promise<string> {
  return generateWithChain(env, models ?? chatModelChain(env), {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userMessage }] }],
  });
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** Multi-turn chat completion: the model sees the conversation so far. */
export async function geminiChatHistory(
  env: Env,
  systemPrompt: string,
  history: ChatTurn[],
  userMessage: string
): Promise<string> {
  const contents = [
    ...history.map((t) => ({
      role: t.role === "assistant" ? "model" : "user",
      parts: [{ text: t.content }],
    })),
    { role: "user", parts: [{ text: userMessage }] },
  ];
  return generateWithChain(env, chatModelChain(env), {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
  });
}

/**
 * Turn a follow-up ("e para o segundo semestre?") into a standalone question,
 * so that retrieval has something searchable. Falls back to the raw message.
 */
export async function condenseQuestion(
  env: Env,
  history: ChatTurn[],
  message: string
): Promise<string> {
  if (history.length === 0) return message;
  const convo = history
    .map((t) => `${t.role === "user" ? "Utilizador" : "Assistente"}: ${t.content}`)
    .join("\n");

  const prompt = `Dada a conversa abaixo e a pergunta de seguimento, reescreve a pergunta de seguimento como uma pergunta autónoma e completa em português de Portugal, que faça sentido sozinha e mantenha todos os detalhes relevantes da conversa.

Se a pergunta já for autónoma, devolve-a exatamente como está.

Responde APENAS com a pergunta reescrita, sem aspas nem comentários.

CONVERSA:
${convo}`;

  try {
    // Rewriting a question is a mechanical task: run it on the light model so it
    // never eats into the quota the actual answers need.
    const out = await geminiChat(env, prompt, `Pergunta de seguimento: ${message}`, [
      env.GEMINI_EXTRACT_MODEL || "gemini-3.1-flash-lite",
      ...chatModelChain(env),
    ]);
    const clean = out.trim().replace(/^["']|["']$/g, "");
    // Guard against the model rambling instead of rewriting.
    if (!clean || clean.length > message.length + 260) return message;
    return clean;
  } catch {
    return message;
  }
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
export function cosineSim(a: ArrayLike<number>, b: ArrayLike<number>): number {
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

/** Pack a vector as base64 float32. ~4x smaller than JSON and far cheaper to decode. */
export function packVector(v: ArrayLike<number>): string {
  const f32 = new Float32Array(v);
  const bytes = new Uint8Array(f32.buffer);
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

/** Unpack a base64 float32 vector. Legacy JSON vectors return empty (ignored until reindex). */
export function unpackVector(packed: string | null): Float32Array {
  if (!packed || packed.charCodeAt(0) === 91 /* "[" = legacy JSON */) return new Float32Array(0);
  try {
    const bin = atob(packed);
    if (bin.length % 4 !== 0) return new Float32Array(0);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Float32Array(bytes.buffer);
  } catch {
    return new Float32Array(0);
  }
}

/** Mean of several vectors, used as a coarse "what is this document about" signal. */
export function centroidOf(vectors: number[][]): number[] {
  const dim = vectors[0]?.length ?? 0;
  if (!dim) return [];
  const out = new Array(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) out[i] += v[i];
  for (let i = 0; i < dim; i++) out[i] /= vectors.length;
  return out;
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
    stmt.bind(doc.id, doc.titulo, i, c, packVector(embeddings[i] ?? []))
  );
  for (let i = 0; i < bound.length; i += 50) {
    await env.DB.batch(bound.slice(i, i + 50));
  }

  // Document centroid: lets the chat pick candidate documents without loading
  // every chunk vector, which is what keeps us inside the free CPU budget.
  // Also backfills the text fingerprint so older documents take part in
  // duplicate detection.
  const valid = embeddings.filter((e) => e && e.length);
  const centroid = valid.length ? centroidOf(valid) : [];
  const hashTexto = await sha256(textFingerprint(doc.conteudo));
  await env.DB.prepare("UPDATE documentos SET centroid = ?, hash_texto = ? WHERE id = ?")
    .bind(centroid.length ? packVector(centroid) : null, hashTexto, doc.id)
    .run();

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
    .bind(faq.id, packVector(vec ?? []))
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
  const bound = faqs.map((f, i) => stmt.bind(f.id, packVector(vectors[i] ?? [])));
  for (let i = 0; i < bound.length; i += 50) {
    await env.DB.batch(bound.slice(i, i + 50));
  }
  return faqs.length;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A 429 from Gemini means one of two very different things:
 *  - per-minute limit  -> clears in seconds, worth retrying
 *  - per-day quota     -> only resets at midnight Pacific; retrying just burns
 *                         more of a quota that is already gone
 * Google spells this out in the error body, so we read it instead of guessing.
 */
export function isDailyQuota(body: string): boolean {
  return /PerDay|per day|daily limit|RequestsPerDay/i.test(body);
}

/* ------------------------------------------------------------------ */
/* Model chain with quota-aware fallback                               */
/* ------------------------------------------------------------------ */

/**
 * Remembers which models are out of quota so we don't pay a failed request on
 * every single call. Lives in the isolate's memory: it is a cache, not state —
 * losing it just means we re-probe sooner, which is harmless.
 * We deliberately re-probe (10 min) rather than compute the exact Pacific
 * midnight reset, so the service heals itself whenever quota comes back.
 */
const exhaustedUntil = new Map<string, number>();

function isExhausted(model: string): boolean {
  const until = exhaustedUntil.get(model);
  return until !== undefined && Date.now() < until;
}

function markExhausted(model: string, daily: boolean) {
  exhaustedUntil.set(model, Date.now() + (daily ? 10 * 60_000 : 45_000));
}

/** Primary first, lighter model second. Quotas are per model, so this buys a second pool. */
export function chatModelChain(env: Env): string[] {
  return [
    env.GEMINI_MODEL || "gemini-flash-latest",
    env.GEMINI_MODEL_FALLBACK || "gemini-flash-lite-latest",
  ].filter((m, i, a) => a.indexOf(m) === i);
}

/** Order to actually try: skip known-exhausted, but never end up with nothing. */
function usableChain(models: string[]): string[] {
  const fresh = models.filter((m) => !isExhausted(m));
  return fresh.length ? fresh : models;
}

interface GenResult {
  ok: boolean;
  text?: string;
  status?: number;
  daily?: boolean;
  body?: string;
}

async function callGenerate(env: Env, model: string, payload: unknown): Promise<GenResult> {
  const res = await fetch(`${GEMINI_BASE}/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify(payload),
  });
  if (res.status === 429) {
    const body = await res.text();
    return { ok: false, status: 429, daily: isDailyQuota(body), body };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, body: (await res.text()).slice(0, 300) };
  }
  return { ok: true, text: joinTextParts((await res.json()) as GeminiResponse) };
}

/** Try each model in turn, falling back when one is out of quota. */
async function generateWithChain(env: Env, models: string[], payload: unknown): Promise<string> {
  let sawDaily = false;
  let lastBody = "";
  for (const model of usableChain(models)) {
    const r = await callGenerate(env, model, payload);
    if (r.ok) return r.text ?? "";
    if (r.status === 429) {
      markExhausted(model, !!r.daily);
      sawDaily = sawDaily || !!r.daily;
      lastBody = r.body ?? "";
      continue; // try the next model in the chain
    }
    const err = new Error(`Gemini ${r.status}: ${r.body}`);
    (err as unknown as { status: number }).status = r.status as number;
    throw err;
  }
  const err = new Error(
    sawDaily
      ? `Quota diária esgotada em todos os modelos configurados. ${lastBody.slice(0, 120)}`
      : "Limite de pedidos por minuto atingido em todos os modelos configurados."
  );
  (err as unknown as { status: number }).status = 429;
  throw err;
}

interface GeminiPart { text?: string; thought?: boolean }
interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

/**
 * Join every text part of a response, skipping "thought" parts.
 * Reading only parts[0] is wrong for thinking models: the first part can be a
 * thought (with no text at all), which made extraction return "" at random.
 */
function joinTextParts(data: GeminiResponse): string {
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
}

/**
 * Extract text from an inline PDF using Gemini's multimodal input.
 * Retries on rate limits and on empty responses, and reports the real reason
 * when it gives up (instead of blaming the document).
 */
export async function geminiExtractPdf(env: Env, base64: string): Promise<string> {
  const model = env.GEMINI_EXTRACT_MODEL || "gemini-3.1-flash-lite";
  let lastReason = "resposta vazia";
  let rateLimited = false;
  let daily = false;

  for (let attempt = 0; attempt < 3; attempt++) {
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
        // Long regulations need plenty of output room; without this the model
        // silently truncates and can return nothing at all.
        generationConfig: { maxOutputTokens: 65536, temperature: 0 },
      }),
    });

    // Transient: back off and retry. But a daily quota will not clear, so
    // stop immediately instead of spending three more requests on it.
    if (res.status === 429 || res.status >= 500) {
      const body = await res.text();
      lastReason = `HTTP ${res.status}`;
      if (res.status === 429) {
        rateLimited = true;
        daily = isDailyQuota(body);
        if (daily) break;
      }
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      throw new Error(`Gemini PDF ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    const data = (await res.json()) as GeminiResponse;
    const text = joinTextParts(data);
    if (text.trim()) return text;

    const finish = data.candidates?.[0]?.finishReason;
    const blocked = data.promptFeedback?.blockReason;
    lastReason = blocked ? `bloqueado (${blocked})` : finish ? `finishReason=${finish}` : "resposta vazia";
    // MAX_TOKENS or a blocked prompt will not fix themselves on retry.
    if (finish === "MAX_TOKENS" || blocked) break;
    await sleep(1000);
  }

  const err = new Error(
    daily
      ? "Quota DIÁRIA do Gemini esgotada para a extração. Só reinicia à meia-noite (Pacífico), ~08:00 em Lisboa."
      : rateLimited
        ? "Limite por minuto do Gemini atingido na extração. Aguarde um pouco e tente novamente."
        : `A extração de texto falhou (${lastReason})`
  );
  if (rateLimited) (err as unknown as { status: number }).status = 429;
  throw err;
}

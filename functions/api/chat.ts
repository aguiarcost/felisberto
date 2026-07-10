import {
  Env,
  json,
  preflight,
  normalizeText,
  extractExcerpt,
  geminiChat,
  geminiEmbedQuery,
  cosineSim,
} from "../_shared";

interface FAQ {
  id: string;
  pergunta: string;
  resposta: string;
  email: string | null;
  modelo_email: string | null;
}
interface Doc {
  id: string;
  titulo: string;
  conteudo: string;
}
interface ChunkRow {
  documento_id: string;
  titulo: string;
  seq: number;
  chunk: string;
  embedding: string;
}

// Portuguese stopwords + generic question words that add noise to lexical scoring.
const STOPWORDS = new Set([
  "como", "para", "por", "uma", "uns", "umas", "que", "qual", "quais", "quando",
  "onde", "porque", "posso", "pode", "podem", "fazer", "faco", "tenho", "ter",
  "sobre", "isto", "isso", "aqui", "ali", "com", "sem", "dos", "das", "nos",
  "nas", "num", "numa", "meu", "minha", "seu", "sua", "este", "esta", "esse",
  "essa", "aos", "the", "and", "preciso", "gostaria", "queria", "obter",
]);

function buildTerms(message: string): string[] {
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

// POST /api/chat  { message } -> { resposta, email, modelo_email, sources }
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  try {
    const { message } = (await request.json()) as { message?: string };
    if (!message || typeof message !== "string") {
      return json({ error: "Mensagem inválida" }, 400);
    }

    const kbRes = await env.DB.prepare("SELECT * FROM base_conhecimento").all<FAQ>();
    const knowledgeBase = kbRes.results ?? [];
    const allTerms = buildTerms(message);

    // --- FAQ retrieval (lexical, stopword-filtered) ---
    const relevantFAQs = knowledgeBase
      .map((entry) => {
        const p = normalizeText(entry.pergunta);
        const r = normalizeText(entry.resposta);
        let score = 0;
        for (const term of allTerms) {
          if (p.includes(term)) score += 2;
          if (r.includes(term)) score += 1;
        }
        return { ...entry, score };
      })
      .filter((e) => e.score >= 1)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    // --- Document retrieval: semantic first, lexical fallback ---
    type Passage = { titulo: string; texto: string; score: number };
    let docPassages: Passage[] = [];
    let retrieval: "semantica" | "lexical" | "nenhuma" = "nenhuma";

    const chunkRes = await env.DB.prepare(
      "SELECT documento_id, titulo, seq, chunk, embedding FROM documento_chunks"
    ).all<ChunkRow>();
    const chunks = chunkRes.results ?? [];

    if (chunks.length > 0) {
      try {
        const qVec = await geminiEmbedQuery(env, message);
        if (qVec.length > 0) {
          const scored = chunks
            .map((c) => {
              let emb: number[] = [];
              try {
                emb = JSON.parse(c.embedding);
              } catch {
                emb = [];
              }
              return { titulo: c.titulo, texto: c.chunk, score: cosineSim(qVec, emb) };
            })
            .sort((a, b) => b.score - a.score);

          // Keep the strongest passages above a relevance floor (max 5).
          docPassages = scored.filter((p) => p.score >= 0.55).slice(0, 5);
          if (docPassages.length === 0 && scored.length > 0 && scored[0].score >= 0.4) {
            docPassages = scored.slice(0, 2);
          }
          retrieval = "semantica";
        }
      } catch {
        retrieval = "nenhuma";
      }
    }

    // Fallback to the old lexical excerpt search if semantic yielded nothing.
    if (docPassages.length === 0) {
      const docRes = await env.DB.prepare("SELECT id, titulo, conteudo FROM documentos").all<Doc>();
      const documents = docRes.results ?? [];
      docPassages = documents
        .map((doc) => {
          const t = normalizeText(doc.titulo);
          const c = normalizeText(doc.conteudo);
          let score = 0;
          for (const term of allTerms) {
            if (t.includes(term)) score += 2;
            if (c.includes(term)) score += 1;
          }
          return { titulo: doc.titulo, texto: extractExcerpt(doc.conteudo, allTerms, 800), score };
        })
        .filter((d) => d.score >= 1)
        .sort((a, b) => b.score - a.score)
        .slice(0, 2);
      if (docPassages.length > 0) retrieval = "lexical";
    }

    // --- Build context ---
    let contextText = "";
    if (relevantFAQs.length > 0) {
      contextText +=
        "PERGUNTAS FREQUENTES:\n" +
        relevantFAQs
          .map(
            (e) =>
              `Pergunta: ${e.pergunta}\nResposta: ${e.resposta}${e.email ? `\nEmail: ${e.email}` : ""}`
          )
          .join("\n\n") +
        "\n\n";
    }
    if (docPassages.length > 0) {
      contextText +=
        "EXCERTOS DE DOCUMENTOS:\n" +
        docPassages.map((p) => `Documento: ${p.titulo}\nExcerto: ${p.texto}`).join("\n\n");
    }

    const systemPrompt = `Tu és o Felisberto, o assistente virtual ACSUTA.

O teu objetivo é ajudar utilizadores com informações sobre procedimentos, reservas, pedidos e serviços.

Responde sempre em português de Portugal de forma simpática, profissional e concisa.

Baseia-te sobretudo na informação fornecida abaixo. Se ela não cobrir a pergunta, dá uma resposta geral e indica que o utilizador deve contactar a secretaria da ACSUTA para detalhes. Nunca inventes procedimentos, emails ou links que não constem da informação fornecida.

${contextText ? `INFORMAÇÃO RELEVANTE:\n${contextText}` : "Não foi encontrada informação específica na base de conhecimento para esta pergunta."}`;

    let generatedResponse: string;
    try {
      generatedResponse = await geminiChat(env, systemPrompt, message);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 429)
        return json({ error: "Limite de pedidos excedido. Por favor, aguarde um momento." }, 429);
      throw e;
    }
    if (!generatedResponse) generatedResponse = "Desculpe, não consegui processar a sua pergunta.";

    const bestMatch = relevantFAQs[0];

    // Distinct source documents among the passages used.
    const seen = new Set<string>();
    const sources: { pergunta: string; score: number; type: string }[] = [];
    for (const p of docPassages) {
      if (seen.has(p.titulo)) continue;
      seen.add(p.titulo);
      sources.push({ pergunta: p.titulo, score: Math.round(p.score * 100) / 100, type: "documento" });
    }

    return json({
      resposta: generatedResponse,
      email: bestMatch?.email ?? null,
      modelo_email: bestMatch?.modelo_email ?? null,
      sources,
      retrieval,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Erro interno do servidor" }, 500);
  }
};

export const onRequestOptions: PagesFunction<Env> = async () => preflight();

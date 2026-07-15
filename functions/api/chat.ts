import {
  Env,
  json,
  preflight,
  normalizeText,
  buildTerms,
  extractExcerpt,
  geminiChat,
  geminiEmbedQuery,
  cosineSim,
  parseEmbedding,
  rrfFuse,
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

/** Minimum cosine similarity for a FAQ to be considered "really about" the question. */
const FAQ_CONFIDENCE = 0.65;
/** Minimum cosine similarity for a document passage to be worth showing the model. */
const DOC_FLOOR = 0.5;

// POST /api/chat  { message } -> { resposta, email, modelo_email, sources, retrieval }
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  try {
    const { message } = (await request.json()) as { message?: string };
    if (!message || typeof message !== "string") {
      return json({ error: "Mensagem inválida" }, 400);
    }

    const allTerms = buildTerms(message);
    const normMsg = normalizeText(message).trim().replace(/\s+/g, " ");

    const kbRes = await env.DB.prepare("SELECT * FROM base_conhecimento").all<FAQ>();
    const knowledgeBase = kbRes.results ?? [];

    // --- Exact match short-circuit (dropdown / copied question) ---
    const exactFaq = knowledgeBase.find(
      (f) => normalizeText(f.pergunta).trim().replace(/\s+/g, " ") === normMsg
    );

    // --- Embed the query once; reused for FAQs and documents ---
    let qVec: number[] = [];
    try {
      qVec = await geminiEmbedQuery(env, message);
    } catch {
      qVec = [];
    }

    const lexScore = (haystacks: [string, number][]): number => {
      let s = 0;
      for (const [text, weight] of haystacks) {
        const n = normalizeText(text);
        for (const t of allTerms) if (n.includes(t)) s += weight;
      }
      return s;
    };

    /* ---------------- FAQ retrieval (hybrid) ---------------- */
    const faqSemMap = new Map<string, number>();
    if (qVec.length > 0 && knowledgeBase.length > 0) {
      const embRes = await env.DB.prepare(
        "SELECT faq_id, embedding FROM faq_embeddings"
      ).all<{ faq_id: string; embedding: string }>();
      for (const row of embRes.results ?? []) {
        faqSemMap.set(row.faq_id, cosineSim(qVec, parseEmbedding(row.embedding)));
      }
    }

    const faqLexMap = new Map<string, number>();
    for (const f of knowledgeBase) {
      faqLexMap.set(
        f.id,
        lexScore([
          [f.pergunta, 2],
          [f.resposta, 1],
        ])
      );
    }

    const faqFused = rrfFuse(
      knowledgeBase.map((f) => ({ id: f.id, score: faqLexMap.get(f.id) ?? 0 })),
      knowledgeBase.map((f) => ({ id: f.id, score: faqSemMap.get(f.id) ?? 0 }))
    );

    const rankedFaqs = knowledgeBase
      .map((f) => ({
        ...f,
        fused: faqFused.get(f.id) ?? 0,
        sem: faqSemMap.get(f.id) ?? 0,
        lex: faqLexMap.get(f.id) ?? 0,
      }))
      .filter((f) => f.fused > 0)
      .sort((a, b) => b.fused - a.fused);

    const relevantFAQs = rankedFaqs.slice(0, 3);

    /* ---------------- Document retrieval (hybrid) ---------------- */
    type Passage = { titulo: string; texto: string; sem: number };
    let docPassages: Passage[] = [];
    let retrieval: "semantica" | "lexical" | "nenhuma" = "nenhuma";

    const chunkRes = await env.DB.prepare(
      "SELECT documento_id, titulo, seq, chunk, embedding FROM documento_chunks"
    ).all<ChunkRow>();
    const chunks = chunkRes.results ?? [];

    if (chunks.length > 0 && qVec.length > 0) {
      const keyOf = (c: ChunkRow) => `${c.documento_id}:${c.seq}`;
      const semList = chunks.map((c) => ({
        id: keyOf(c),
        score: cosineSim(qVec, parseEmbedding(c.embedding)),
      }));
      const lexList = chunks.map((c) => ({
        id: keyOf(c),
        score: lexScore([
          [c.titulo, 2],
          [c.chunk, 1],
        ]),
      }));
      const semById = new Map(semList.map((x) => [x.id, x.score]));
      const fused = rrfFuse(lexList, semList);

      const ranked = chunks
        .map((c) => ({
          titulo: c.titulo,
          texto: c.chunk,
          sem: semById.get(keyOf(c)) ?? 0,
          fused: fused.get(keyOf(c)) ?? 0,
        }))
        .filter((c) => c.fused > 0)
        .sort((a, b) => b.fused - a.fused);

      // Keep passages that clear the relevance floor; otherwise take the best two.
      docPassages = ranked.filter((p) => p.sem >= DOC_FLOOR).slice(0, 5);
      if (docPassages.length === 0 && ranked.length > 0 && ranked[0].sem >= 0.4) {
        docPassages = ranked.slice(0, 2);
      }
      if (docPassages.length > 0) retrieval = "semantica";
    }

    // Fallback: old lexical excerpt search when there is no usable vector index.
    if (docPassages.length === 0) {
      const docRes = await env.DB.prepare("SELECT id, titulo, conteudo FROM documentos").all<Doc>();
      const scored = (docRes.results ?? [])
        .map((doc) => ({
          titulo: doc.titulo,
          texto: extractExcerpt(doc.conteudo, allTerms, 800),
          sem: 0,
          lex: lexScore([
            [doc.titulo, 2],
            [doc.conteudo, 1],
          ]),
        }))
        .filter((d) => d.lex >= 1)
        .sort((a, b) => b.lex - a.lex)
        .slice(0, 2);
      if (scored.length > 0) {
        docPassages = scored;
        retrieval = "lexical";
      }
    }

    /* ---------------- Build context ---------------- */
    let contextText = "";
    if (exactFaq) {
      contextText +=
        "RESPOSTA OFICIAL PARA ESTA PERGUNTA (usa-a como base):\n" +
        `Pergunta: ${exactFaq.pergunta}\nResposta: ${exactFaq.resposta}` +
        (exactFaq.email ? `\nEmail: ${exactFaq.email}` : "") +
        "\n\n";
    }
    const otherFaqs = relevantFAQs.filter((f) => f.id !== exactFaq?.id);
    if (otherFaqs.length > 0) {
      contextText +=
        "PERGUNTAS FREQUENTES RELACIONADAS:\n" +
        otherFaqs
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

    /* ---------------- Decide whether to attach an email template ----------------
       Only attach when we are confident the FAQ really matches the question.
       Previously the top lexical hit was always attached, which produced
       unrelated templates (e.g. a room-booking template for an exam question). */
    let bestMatch: (typeof rankedFaqs)[number] | FAQ | null = null;
    if (exactFaq) {
      bestMatch = exactFaq;
    } else {
      const top = rankedFaqs[0];
      if (top && (top.sem >= FAQ_CONFIDENCE || (qVec.length === 0 && top.lex >= 4))) {
        bestMatch = top;
      }
    }

    const seen = new Set<string>();
    const sources: { pergunta: string; score: number; type: string }[] = [];
    for (const p of docPassages) {
      if (seen.has(p.titulo)) continue;
      seen.add(p.titulo);
      sources.push({ pergunta: p.titulo, score: Math.round(p.sem * 100) / 100, type: "documento" });
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

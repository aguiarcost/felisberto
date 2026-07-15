import {
  Env,
  json,
  preflight,
  normalizeText,
  buildTerms,
  extractExcerpt,
  geminiChatHistory,
  condenseQuestion,
  geminiEmbedQuery,
  cosineSim,
  unpackVector,
  rrfFuse,
  type ChatTurn,
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
/** How many previous turns to carry. Keeps prompts small and cheap. */
const HISTORY_TURNS = 6;
/** How many candidate documents to open in stage 2. Bounds CPU per request. */
const TOP_DOCS = 6;

// POST /api/chat  { message, history? } -> { resposta, email, modelo_email, sources, retrieval }
export const onRequestPost: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
  try {
    const body = (await request.json()) as { message?: string; history?: ChatTurn[] };
    const message = body.message;
    if (!message || typeof message !== "string") {
      return json({ error: "Mensagem inválida" }, 400);
    }

    const history: ChatTurn[] = Array.isArray(body.history)
      ? body.history
          .filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
          .slice(-HISTORY_TURNS)
      : [];

    // A follow-up like "e para o segundo semestre?" is meaningless to the search
    // engine on its own, so rewrite it into a standalone question first.
    const searchQuery = await condenseQuestion(env, history, message);

    const allTerms = buildTerms(searchQuery);
    const normMsg = normalizeText(searchQuery).trim().replace(/\s+/g, " ");

    const kbRes = await env.DB.prepare("SELECT * FROM base_conhecimento").all<FAQ>();
    const knowledgeBase = kbRes.results ?? [];

    // --- Exact match short-circuit (dropdown / copied question) ---
    const exactFaq = knowledgeBase.find(
      (f) => normalizeText(f.pergunta).trim().replace(/\s+/g, " ") === normMsg
    );

    // --- Embed the query once; reused for FAQs and documents ---
    let qVec: number[] = [];
    try {
      qVec = await geminiEmbedQuery(env, searchQuery);
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
        faqSemMap.set(row.faq_id, cosineSim(qVec, unpackVector(row.embedding)));
      }
    }

    const faqLexMap = new Map<string, number>();
    for (const f of knowledgeBase) {
      faqLexMap.set(f.id, lexScore([[f.pergunta, 2], [f.resposta, 1]]));
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

    /* ---------------- Document retrieval (two-stage hybrid) ----------------
       Stage 1 picks candidate DOCUMENTS using one centroid vector each, so we
       never load the whole index. Stage 2 loads chunk vectors only for those
       few documents. This keeps CPU flat as the corpus grows, which is what
       the Workers free plan (10ms/request) requires. */
    type Passage = { titulo: string; texto: string; sem: number };
    let docPassages: Passage[] = [];
    let retrieval: "semantica" | "lexical" | "nenhuma" = "nenhuma";

    const docMetaRes = await env.DB.prepare(
      "SELECT id, titulo, centroid FROM documentos"
    ).all<{ id: string; titulo: string; centroid: string | null }>();
    const docMetas = docMetaRes.results ?? [];

    const scoredDocs = docMetas
      .map((d) => ({
        id: d.id,
        sem: qVec.length ? cosineSim(qVec, unpackVector(d.centroid)) : 0,
        lex: lexScore([[d.titulo, 1]]),
      }))
      .sort((a, b) => b.sem + b.lex * 0.05 - (a.sem + a.lex * 0.05));

    // Union of the best semantic matches and any title hit, capped so that the
    // number of chunk vectors we decode stays bounded.
    const candidateIds = [
      ...new Set([
        ...scoredDocs.filter((d) => d.sem > 0).slice(0, TOP_DOCS).map((d) => d.id),
        ...scoredDocs.filter((d) => d.lex > 0).slice(0, 2).map((d) => d.id),
      ]),
    ].slice(0, TOP_DOCS + 2);

    let chunks: ChunkRow[] = [];
    if (candidateIds.length > 0) {
      const ph = candidateIds.map(() => "?").join(",");
      const chunkRes = await env.DB.prepare(
        `SELECT documento_id, titulo, seq, chunk, embedding FROM documento_chunks WHERE documento_id IN (${ph})`
      )
        .bind(...candidateIds)
        .all<ChunkRow>();
      chunks = chunkRes.results ?? [];
    }

    if (chunks.length > 0 && qVec.length > 0) {
      const keyOf = (c: ChunkRow) => `${c.documento_id}:${c.seq}`;
      const semList = chunks.map((c) => ({
        id: keyOf(c),
        score: cosineSim(qVec, unpackVector(c.embedding)),
      }));
      const lexList = chunks.map((c) => ({
        id: keyOf(c),
        score: lexScore([[c.titulo, 2], [c.chunk, 1]]),
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

      docPassages = ranked.filter((p) => p.sem >= DOC_FLOOR).slice(0, 5);
      if (docPassages.length === 0 && ranked.length > 0 && ranked[0].sem >= 0.4) {
        docPassages = ranked.slice(0, 2);
      }
      if (docPassages.length > 0) retrieval = "semantica";
    }

    // Fallback: lexical excerpt search when there is no usable vector index
    // (e.g. right after a dimension change, before a reindex). Bounded to a few
    // documents so it can never blow the CPU budget either.
    if (docPassages.length === 0 && docMetas.length > 0) {
      const fallbackIds = (
        candidateIds.length ? candidateIds : docMetas.slice(0, 5).map((d) => d.id)
      ).slice(0, 5);
      const ph = fallbackIds.map(() => "?").join(",");
      const docRes = await env.DB.prepare(
        `SELECT id, titulo, conteudo FROM documentos WHERE id IN (${ph})`
      )
        .bind(...fallbackIds)
        .all<Doc>();
      const scored = (docRes.results ?? [])
        .map((doc) => ({
          titulo: doc.titulo,
          texto: extractExcerpt(doc.conteudo, allTerms, 800),
          sem: 0,
          lex: lexScore([[doc.titulo, 2], [doc.conteudo, 1]]),
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

Responde sempre em português de Portugal de forma simpática, profissional e concisa. Tens acesso ao histórico da conversa: usa-o para perceber perguntas de seguimento, mas responde sempre à última pergunta do utilizador.

Baseia-te sobretudo na informação fornecida abaixo. Se ela não cobrir a pergunta, dá uma resposta geral e indica que o utilizador deve contactar a secretaria da ACSUTA para detalhes. Nunca inventes procedimentos, emails ou links que não constem da informação fornecida.

${contextText ? `INFORMAÇÃO RELEVANTE:\n${contextText}` : "Não foi encontrada informação específica na base de conhecimento para esta pergunta."}`;

    let generatedResponse: string;
    try {
      generatedResponse = await geminiChatHistory(env, systemPrompt, history, message);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 429)
        return json({ error: "Limite de pedidos excedido. Por favor, aguarde um momento." }, 429);
      throw e;
    }
    if (!generatedResponse) generatedResponse = "Desculpe, não consegui processar a sua pergunta.";

    /* ---------------- Attach email only when confident ---------------- */
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

    /* ---------------- Log the question (never blocks the reply) ----------------
       Stores the question and how retrieval performed, so the admin can see
       which questions are being asked and where the knowledge base falls short.
       No IP, no user identity. */
    const bestFaqScore = rankedFaqs[0]?.sem ?? 0;
    const bestDocScore = docPassages[0]?.sem ?? 0;
    const answered = !!bestMatch || docPassages.length > 0 ? 1 : 0;
    const logPromise = env.DB.prepare(
      `INSERT INTO chat_logs (pergunta, pergunta_pesquisa, retrieval, faq_score, doc_score, faq_match, fontes, respondido)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        message.slice(0, 1000),
        searchQuery === message ? null : searchQuery.slice(0, 1000),
        retrieval,
        Math.round(bestFaqScore * 1000) / 1000,
        Math.round(bestDocScore * 1000) / 1000,
        bestMatch?.pergunta ?? null,
        sources.length ? JSON.stringify(sources.map((s) => s.pergunta)) : null,
        answered
      )
      .run()
      .catch(() => undefined);
    if (typeof waitUntil === "function") waitUntil(logPromise);
    else await logPromise;

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

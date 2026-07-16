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
  isDailyQuota,
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
/** Lexical fallback caps: only used before a reindex, must stay cheap. */
const FALLBACK_DOCS = 4;
const FALLBACK_CHARS = 12000;

// POST /api/chat  { message, history? } -> { resposta, email, modelo_email, sources, retrieval }
export const onRequestPost: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
  try {
    const body = (await request.json()) as { message?: string; history?: ChatTurn[] };
    const message = body.message;
    if (!message || typeof message !== "string") {
      return json({ error: "Mensagem inválida" }, 400);
    }

    const t0 = Date.now();
    const timings: Record<string, number> = {};

    const history: ChatTurn[] = Array.isArray(body.history)
      ? body.history
          .filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
          .slice(-HISTORY_TURNS)
      : [];

    // A follow-up like "e para o segundo semestre?" is meaningless to the search
    // engine on its own, so rewrite it into a standalone question first.
    const tC = Date.now();
    const searchQuery = await condenseQuestion(env, history, message);
    timings.reescrita = Date.now() - tC;

    const allTerms = buildTerms(searchQuery);
    const normMsg = normalizeText(searchQuery).trim().replace(/\s+/g, " ");

    // Embedding and the three independent reads don't depend on each other,
    // so run them together instead of paying for each round trip in sequence.
    const tDb = Date.now();
    const [qVec, kbRes, faqEmbRes, docMetaRes] = await Promise.all([
      geminiEmbedQuery(env, searchQuery).catch(() => [] as number[]),
      env.DB.prepare("SELECT * FROM base_conhecimento").all<FAQ>(),
      env.DB.prepare("SELECT faq_id, embedding FROM faq_embeddings").all<{
        faq_id: string;
        embedding: string;
      }>(),
      env.DB.prepare("SELECT id, titulo, centroid FROM documentos").all<{
        id: string;
        titulo: string;
        centroid: string | null;
      }>(),
    ]);
    timings.pesquisa = Date.now() - tDb;

    const knowledgeBase = kbRes.results ?? [];

    // --- Exact match short-circuit (dropdown / copied question) ---
    const exactFaq = knowledgeBase.find(
      (f) => normalizeText(f.pergunta).trim().replace(/\s+/g, " ") === normMsg
    );

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
      for (const row of faqEmbRes.results ?? []) {
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
    // (e.g. right after a dimension change, before a reindex).
    // Strictly bounded: full-text scanning of large regulations costs several ms
    // of CPU each, and the free plan only gives 10ms per request. We cap both
    // the number of documents and how much of each one we look at.
    if (docPassages.length === 0 && docMetas.length > 0) {
      const fallbackIds = (
        candidateIds.length ? candidateIds : docMetas.map((d) => d.id)
      ).slice(0, FALLBACK_DOCS);
      const ph = fallbackIds.map(() => "?").join(",");
      const docRes = await env.DB.prepare(
        `SELECT id, titulo, SUBSTR(conteudo, 1, ${FALLBACK_CHARS}) AS conteudo FROM documentos WHERE id IN (${ph})`
      )
        .bind(...fallbackIds)
        .all<Doc>();
      const scored = (docRes.results ?? [])
        .map((doc) => {
          // Normalise once and reuse: doing it per-call was the expensive part.
          const nTitulo = normalizeText(doc.titulo);
          const nTexto = normalizeText(doc.conteudo);
          let lex = 0;
          for (const t of allTerms) {
            if (nTitulo.includes(t)) lex += 2;
            if (nTexto.includes(t)) lex += 1;
          }
          return { titulo: doc.titulo, texto: "", sem: 0, lex, conteudo: doc.conteudo };
        })
        .filter((d) => d.lex >= 1)
        .sort((a, b) => b.lex - a.lex)
        .slice(0, 2)
        // Only build excerpts for the two winners, never for every document.
        .map((d) => ({
          titulo: d.titulo,
          texto: extractExcerpt(d.conteudo, allTerms, 800),
          sem: 0,
        }));
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
    const tG = Date.now();
    try {
      generatedResponse = await geminiChatHistory(env, systemPrompt, history, message);
      timings.resposta = Date.now() - tG;
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 503) {
        return json(
          {
            error:
              "O serviço de IA está temporariamente com muita procura. Aguarde alguns segundos e tente novamente.",
          },
          503
        );
      }
      if (status === 429) {
        // Tell the two kinds of 429 apart: waiting 30s vs waiting for the daily reset.
        const msg = e instanceof Error ? e.message : "";
        return json(
          {
            error: isDailyQuota(msg)
              ? "Quota diária do Gemini esgotada. O serviço volta após a meia-noite (Pacífico), cerca das 08:00 em Lisboa."
              : "Muitos pedidos em pouco tempo. Aguarde alguns segundos e tente novamente.",
          },
          429
        );
      }
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

    timings.total = Date.now() - t0;

    return json({
      resposta: generatedResponse,
      email: bestMatch?.email ?? null,
      modelo_email: bestMatch?.modelo_email ?? null,
      sources,
      retrieval,
      timings,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Erro interno do servidor" }, 500);
  }
};

export const onRequestOptions: PagesFunction<Env> = async () => preflight();

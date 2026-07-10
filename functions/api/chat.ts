import { Env, json, preflight, normalizeText, extractExcerpt, geminiChat } from "../_shared";

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

// POST /api/chat  { message } -> { resposta, email, modelo_email, sources }
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  try {
    const { message } = (await request.json()) as { message?: string };
    if (!message || typeof message !== "string") {
      return json({ error: "Mensagem inválida" }, 400);
    }

    const kbRes = await env.DB.prepare("SELECT * FROM base_conhecimento").all<FAQ>();
    const docRes = await env.DB.prepare("SELECT id, titulo, conteudo FROM documentos").all<Doc>();
    const knowledgeBase = kbRes.results ?? [];
    const documents = docRes.results ?? [];

    // Build search terms (with light stemming), matching the original behaviour.
    const searchTerms = normalizeText(message).split(/\s+/).filter((t) => t.length >= 3);
    const stemTerms = searchTerms.map((term) => {
      if (term.endsWith("ade")) return term.slice(0, -3);
      if (term.endsWith("ao")) return term.slice(0, -2);
      if (term.endsWith("es")) return term.slice(0, -2);
      if (term.endsWith("s")) return term.slice(0, -1);
      return term;
    });
    const allTerms = [...new Set([...searchTerms, ...stemTerms])];

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

    const relevantDocs = documents
      .map((doc) => {
        const t = normalizeText(doc.titulo);
        const c = normalizeText(doc.conteudo);
        let score = 0;
        for (const term of allTerms) {
          if (t.includes(term)) score += 2;
          if (c.includes(term)) score += 1;
        }
        return { ...doc, score };
      })
      .filter((d) => d.score >= 1)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);

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
    if (relevantDocs.length > 0) {
      contextText +=
        "DOCUMENTOS:\n" +
        relevantDocs
          .map((d) => `Documento: ${d.titulo}\nExcerto relevante: ${extractExcerpt(d.conteudo, allTerms, 800)}`)
          .join("\n\n");
    }

    const systemPrompt = `Tu és o Felisberto, o assistente virtual ACSUTA.

O teu objetivo é ajudar utilizadores com informações sobre procedimentos, reservas, pedidos e serviços.

Responde sempre em português de Portugal de forma simpática, profissional e concisa.

Se encontrares informação relevante na base de conhecimento, usa-a para responder. Se não encontrares informação específica, podes dar uma resposta geral mas indica que o utilizador deve contactar a secretaria para informações mais detalhadas.

${contextText ? `BASE DE CONHECIMENTO RELEVANTE:\n${contextText}` : "Não foi encontrada informação específica na base de conhecimento para esta pergunta."}`;

    let generatedResponse: string;
    try {
      generatedResponse = await geminiChat(env, systemPrompt, message);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 429) return json({ error: "Limite de pedidos excedido. Por favor, aguarde um momento." }, 429);
      throw e;
    }
    if (!generatedResponse) generatedResponse = "Desculpe, não consegui processar a sua pergunta.";

    const bestMatch = relevantFAQs[0];
    const sources = relevantDocs.map((d) => ({ pergunta: d.titulo, score: d.score, type: "documento" }));

    return json({
      resposta: generatedResponse,
      email: bestMatch?.email ?? null,
      modelo_email: bestMatch?.modelo_email ?? null,
      sources,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Erro interno do servidor" }, 500);
  }
};

export const onRequestOptions: PagesFunction<Env> = async () => preflight();

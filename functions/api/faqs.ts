import { Env, json, preflight } from "../_shared";

interface FAQ {
  id: string;
  pergunta: string;
  resposta: string;
  email: string | null;
  modelo_email: string | null;
  created_at: string;
}

// GET /api/faqs -> { faqs: FAQ[], docsCount: number }
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  try {
    const faqsRes = await env.DB.prepare(
      "SELECT id, pergunta, resposta, email, modelo_email, created_at FROM base_conhecimento ORDER BY created_at ASC"
    ).all<FAQ>();

    const countRes = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM documentos"
    ).first<{ c: number }>();

    return json({
      faqs: faqsRes.results ?? [],
      docsCount: countRes?.c ?? 0,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Erro ao carregar dados" }, 500);
  }
};

export const onRequestOptions: PagesFunction<Env> = async () => preflight();

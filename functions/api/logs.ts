import { Env, json, preflight, requireAdmin } from "../_shared";

interface LogRow {
  id: string;
  pergunta: string;
  pergunta_pesquisa: string | null;
  retrieval: string | null;
  faq_score: number | null;
  doc_score: number | null;
  faq_match: string | null;
  fontes: string | null;
  respondido: number;
  created_at: string;
}

// GET /api/logs?limit=100  [requires admin token]
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;

  try {
    const url = new URL(request.url);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 300);

    const rows = await env.DB.prepare(
      `SELECT id, pergunta, pergunta_pesquisa, retrieval, faq_score, doc_score,
              faq_match, fontes, respondido, created_at
       FROM chat_logs ORDER BY created_at DESC LIMIT ?`
    )
      .bind(limit)
      .all<LogRow>();

    const stats = await env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN respondido = 0 THEN 1 ELSE 0 END) AS sem_fonte,
              SUM(CASE WHEN created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS ultimos_7d
       FROM chat_logs`
    ).first<{ total: number; sem_fonte: number; ultimos_7d: number }>();

    // Questions that found nothing — these are the gaps worth writing FAQs for.
    const gaps = await env.DB.prepare(
      `SELECT pergunta, COUNT(*) AS vezes, MAX(created_at) AS ultima
       FROM chat_logs
       WHERE respondido = 0
       GROUP BY LOWER(pergunta)
       ORDER BY vezes DESC, ultima DESC
       LIMIT 20`
    ).all<{ pergunta: string; vezes: number; ultima: string }>();

    return json({
      logs: rows.results ?? [],
      stats: stats ?? { total: 0, sem_fonte: 0, ultimos_7d: 0 },
      gaps: gaps.results ?? [],
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Erro ao carregar registos" }, 500);
  }
};

export const onRequestOptions: PagesFunction<Env> = async () => preflight();

import { Env, json, preflight, requireAdmin } from "../_shared";

interface DocRow {
  id: string;
  titulo: string;
  tipo_ficheiro: string | null;
  created_at: string;
  tamanho: number;
  chunks: number;
}

// GET /api/docs -> { documents: DocRow[] }
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;

  try {
    const res = await env.DB.prepare(
      `SELECT d.id, d.titulo, d.tipo_ficheiro, d.created_at,
              LENGTH(d.conteudo) AS tamanho,
              (SELECT COUNT(*) FROM documento_chunks c WHERE c.documento_id = d.id) AS chunks
       FROM documentos d
       ORDER BY d.created_at DESC`
    ).all<DocRow>();

    return json({ documents: res.results ?? [] });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Erro ao carregar documentos" }, 500);
  }
};

export const onRequestOptions: PagesFunction<Env> = async () => preflight();

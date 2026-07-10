import { Env, json, preflight, indexDocument } from "../_shared";

interface Doc {
  id: string;
  titulo: string;
  conteudo: string;
}

// POST /api/reindex -> rebuilds semantic index for every document.
export const onRequestPost: PagesFunction<Env> = async ({ env }) => {
  try {
    const docRes = await env.DB.prepare(
      "SELECT id, titulo, conteudo FROM documentos"
    ).all<Doc>();
    const documents = docRes.results ?? [];

    let totalChunks = 0;
    const results: { titulo: string; chunks: number; error?: string }[] = [];

    for (const doc of documents) {
      try {
        const n = await indexDocument(env, doc);
        totalChunks += n;
        results.push({ titulo: doc.titulo, chunks: n });
      } catch (e) {
        results.push({
          titulo: doc.titulo,
          chunks: 0,
          error: e instanceof Error ? e.message : "erro",
        });
      }
    }

    return json({
      success: true,
      documents: documents.length,
      totalChunks,
      results,
    });
  } catch (e) {
    return json({ success: false, error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
};

export const onRequestOptions: PagesFunction<Env> = async () => preflight();

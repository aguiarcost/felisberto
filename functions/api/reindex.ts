import { Env, json, preflight, requireAdmin, indexDocument, indexAllFaqs } from "../_shared";

interface Doc {
  id: string;
  titulo: string;
  conteudo: string;
}

/**
 * Documents processed per call. The Workers free plan allows 50 subrequests per
 * invocation, and each document costs ~4 (embed + delete + insert + update),
 * so we stay well inside it and let the caller loop.
 */
const BATCH = 8;

// POST /api/reindex  { force?: boolean }  [requires admin token]
// Processes a batch of pending documents. Returns `remaining` so the caller
// can keep calling until the whole corpus is indexed.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;

  try {
    const body = (await request.json().catch(() => ({}))) as { force?: boolean };

    // Starting a full rebuild: mark everything as pending and drop FAQ vectors.
    if (body.force) {
      await env.DB.prepare("UPDATE documentos SET estado = 'pendente', erro = NULL").run();
    }

    // FAQs are few and fit in a single embedding call: do them on the first pass.
    let faqs = 0;
    let faqError: string | undefined;
    if (body.force) {
      try {
        faqs = await indexAllFaqs(env);
      } catch (e) {
        faqError = e instanceof Error ? e.message : "erro";
      }
    }

    const pending = await env.DB.prepare(
      "SELECT id, titulo, conteudo FROM documentos WHERE estado != 'concluido' LIMIT ?"
    )
      .bind(BATCH)
      .all<Doc>();
    const docs = pending.results ?? [];

    let totalChunks = 0;
    const results: { titulo: string; chunks: number; error?: string }[] = [];

    for (const doc of docs) {
      try {
        const n = await indexDocument(env, doc);
        totalChunks += n;
        results.push({ titulo: doc.titulo, chunks: n });
        await env.DB.prepare(
          "UPDATE documentos SET estado = 'concluido', erro = NULL WHERE id = ?"
        )
          .bind(doc.id)
          .run();
      } catch (e) {
        const msg = e instanceof Error ? e.message : "erro";
        results.push({ titulo: doc.titulo, chunks: 0, error: msg });
        // Mark as failed so the loop moves on instead of retrying forever.
        await env.DB.prepare("UPDATE documentos SET estado = 'erro', erro = ? WHERE id = ?")
          .bind(msg.slice(0, 500), doc.id)
          .run();
      }
    }

    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM documentos WHERE estado != 'concluido'"
    ).first<{ n: number }>();

    return json({
      success: true,
      documents: docs.length,
      totalChunks,
      faqs,
      faqError,
      remaining: left?.n ?? 0,
      results,
    });
  } catch (e) {
    return json({ success: false, error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
};

export const onRequestOptions: PagesFunction<Env> = async () => preflight();

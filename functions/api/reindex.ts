import { Env, json, preflight, requireAdmin, indexDocument, indexAllFaqs, chunkText } from "../_shared";

interface Doc {
  id: string;
  titulo: string;
  conteudo: string;
}

/**
 * The free-tier embedding quota counts each excerpt, not each API call
 * (limit: 100/minute). So we pace by EXCERPTS, not by documents: a batch of
 * 8 large regulations would be ~160 excerpts and would always be throttled.
 */
const CHUNK_BUDGET = 80;
/** Hard cap on documents per invocation (Workers free plan: 50 subrequests). */
const MAX_DOCS = 8;

// POST /api/reindex  { force?: boolean }  [requires admin token]
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;

  try {
    const body = (await request.json().catch(() => ({}))) as { force?: boolean };

    if (body.force) {
      await env.DB.prepare("UPDATE documentos SET estado = 'pendente', erro = NULL").run();
    }

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
      "SELECT id, titulo, conteudo FROM documentos WHERE estado != 'concluido' ORDER BY LENGTH(conteudo) ASC LIMIT ?"
    )
      .bind(MAX_DOCS)
      .all<Doc>();

    let totalChunks = 0;
    let rateLimited = false;
    let retryAfter = 0;
    const results: { titulo: string; chunks: number; error?: string }[] = [];
    let spent = 0;

    for (const doc of pending.results ?? []) {
      // Stay inside the per-minute embedding quota.
      const need = chunkText(doc.conteudo).length;
      if (spent > 0 && spent + need > CHUNK_BUDGET) break;

      try {
        const n = await indexDocument(env, doc);
        spent += n;
        totalChunks += n;
        results.push({ titulo: doc.titulo, chunks: n });
        await env.DB.prepare("UPDATE documentos SET estado = 'concluido', erro = NULL WHERE id = ?")
          .bind(doc.id)
          .run();
      } catch (e) {
        const status = (e as { status?: number }).status;
        const msg = e instanceof Error ? e.message : "erro";

        if (status === 429) {
          // Transient: the quota resets in seconds. Leave it pending so the
          // next pass picks it up — marking it "erro" was simply wrong.
          rateLimited = true;
          retryAfter = Math.max(retryAfter, (e as { retryAfter?: number }).retryAfter ?? 30);
          await env.DB.prepare("UPDATE documentos SET estado = 'pendente', erro = NULL WHERE id = ?")
            .bind(doc.id)
            .run();
          break;
        }

        results.push({ titulo: doc.titulo, chunks: 0, error: msg });
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
      documents: results.filter((r) => !r.error).length,
      totalChunks,
      faqs,
      faqError,
      remaining: left?.n ?? 0,
      rateLimited,
      retryAfter,
      results,
    });
  } catch (e) {
    return json({ success: false, error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
};

export const onRequestOptions: PagesFunction<Env> = async () => preflight();

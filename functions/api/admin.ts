import { Env, json, preflight, requireAdmin, indexFaq } from "../_shared";

interface FAQInput {
  pergunta: string;
  resposta: string;
  email?: string | null;
  modelo_email?: string | null;
}

// POST /api/admin  { action, id?, data? }   [requires admin token]
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;

  try {
    const { action, id, data } = (await request.json()) as {
      action: string;
      id?: string;
      data?: FAQInput | FAQInput[];
    };

    switch (action) {
      case "create": {
        const d = data as FAQInput;
        const row = await env.DB.prepare(
          "INSERT INTO base_conhecimento (pergunta, resposta, email, modelo_email) VALUES (?, ?, ?, ?) RETURNING *"
        )
          .bind(d.pergunta, d.resposta, d.email ?? null, d.modelo_email ?? null)
          .first<{ id: string; pergunta: string; resposta: string }>();

        // Keep the semantic index in sync; never fail the write because of it.
        try {
          if (row) await indexFaq(env, row);
        } catch (e) {
          return json({ success: true, data: row, indexWarning: String(e) });
        }
        return json({ success: true, data: row });
      }

      case "update": {
        const d = data as FAQInput;
        if (!id) return json({ error: "id em falta" }, 400);
        const row = await env.DB.prepare(
          "UPDATE base_conhecimento SET pergunta = ?, resposta = ?, email = ?, modelo_email = ? WHERE id = ? RETURNING *"
        )
          .bind(d.pergunta, d.resposta, d.email ?? null, d.modelo_email ?? null, id)
          .first<{ id: string; pergunta: string; resposta: string }>();

        try {
          if (row) await indexFaq(env, row);
        } catch (e) {
          return json({ success: true, data: row, indexWarning: String(e) });
        }
        return json({ success: true, data: row });
      }

      case "delete": {
        if (!id) return json({ error: "id em falta" }, 400);
        await env.DB.prepare("DELETE FROM faq_embeddings WHERE faq_id = ?").bind(id).run();
        await env.DB.prepare("DELETE FROM base_conhecimento WHERE id = ?").bind(id).run();
        return json({ success: true });
      }

      case "delete-doc": {
        if (!id) return json({ error: "id em falta" }, 400);
        await env.DB.prepare("DELETE FROM documento_chunks WHERE documento_id = ?").bind(id).run();
        await env.DB.prepare("DELETE FROM documentos WHERE id = ?").bind(id).run();
        return json({ success: true });
      }

      case "import": {
        const items = (data as FAQInput[]) ?? [];
        if (!Array.isArray(items) || items.length === 0) {
          return json({ error: "Nada para importar" }, 400);
        }
        const stmt = env.DB.prepare(
          "INSERT INTO base_conhecimento (pergunta, resposta, email, modelo_email) VALUES (?, ?, ?, ?)"
        );
        const batch = items.map((it) =>
          stmt.bind(it.pergunta, it.resposta, it.email ?? null, it.modelo_email ?? null)
        );
        await env.DB.batch(batch);
        // Imported rows are not embedded here (could be many); ask for a reindex.
        return json({
          success: true,
          data: { imported: items.length },
          needsReindex: true,
        });
      }

      default:
        return json({ error: "Invalid action" }, 400);
    }
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
};

export const onRequestOptions: PagesFunction<Env> = async () => preflight();

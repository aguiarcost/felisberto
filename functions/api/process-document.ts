import JSZip from "jszip";
import { Env, json, preflight, geminiExtractPdf, indexDocument, requireAdmin } from "../_shared";

const DOCX_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function extractDocx(bytes: Uint8Array): Promise<string> {
  try {
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file("word/document.xml")?.async("string");
    if (!xml) return "";
    return xml
      .replace(/<w:p[^>]*>/g, "\n")
      .replace(/<w:br[^>]*>/g, "\n")
      .replace(/<w:tab[^>]*>/g, "\t")
      .replace(/<w:t[^>]*>([^<]*)<\/w:t>/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

// POST /api/process-document  { fileName, fileType, fileContent(base64) }
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;

  try {
    const { fileName, fileType, fileContent } = (await request.json()) as {
      fileName?: string;
      fileType?: string;
      fileContent?: string;
    };

    if (!fileName || !fileContent) {
      return json({ success: false, error: "Missing fileName or fileContent" }, 400);
    }

    let extractedText = "";
    let tipoFicheiro = "txt";

    if (fileType === "text/plain") {
      extractedText = new TextDecoder().decode(base64ToBytes(fileContent));
    } else if (fileType === "application/pdf") {
      extractedText = await geminiExtractPdf(env, fileContent);
      tipoFicheiro = "pdf";
    } else if (fileType === DOCX_TYPE) {
      extractedText = await extractDocx(base64ToBytes(fileContent));
      tipoFicheiro = "docx";
    } else {
      return json({ success: false, error: "Unsupported file type" }, 400);
    }

    if (!extractedText.trim()) {
      return json(
        {
          success: false,
          error:
            "Não foi possível extrair texto do documento. Pode ser digitalizado/imagem ou estar protegido.",
        },
        400
      );
    }

    const titulo = fileName.replace(/\.[^/.]+$/, "").replace(/[_-]/g, " ");
    const conteudo = extractedText
      .replace(/\u0000/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .substring(0, 300000);

    const existing = await env.DB.prepare("SELECT id FROM documentos WHERE titulo = ?")
      .bind(titulo)
      .first<{ id: string }>();

    let docId: string;
    if (existing) {
      await env.DB.prepare("UPDATE documentos SET conteudo = ?, tipo_ficheiro = ? WHERE id = ?")
        .bind(conteudo, tipoFicheiro, existing.id)
        .run();
      docId = existing.id;
    } else {
      const row = await env.DB.prepare(
        "INSERT INTO documentos (titulo, conteudo, tipo_ficheiro) VALUES (?, ?, ?) RETURNING id"
      )
        .bind(titulo, conteudo, tipoFicheiro)
        .first<{ id: string }>();
      docId = row!.id;
    }

    // Chunk + embed for semantic search. If embedding fails, keep the document
    // anyway (it can be re-indexed later via /api/reindex).
    let chunks = 0;
    let indexWarning: string | undefined;
    try {
      chunks = await indexDocument(env, { id: docId, titulo, conteudo });
    } catch (e) {
      indexWarning = e instanceof Error ? e.message : "Falha na indexação semântica";
    }

    return json({
      success: true,
      message: `Documento "${fileName}" processado e guardado${chunks ? ` (${chunks} excertos indexados)` : ""}.`,
      chunks,
      indexWarning,
    });
  } catch (e) {
    return json({ success: false, error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
};

export const onRequestOptions: PagesFunction<Env> = async () => preflight();

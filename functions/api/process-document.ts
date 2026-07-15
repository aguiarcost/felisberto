import JSZip from "jszip";
import {
  Env,
  json,
  preflight,
  geminiExtractPdf,
  indexDocument,
  requireAdmin,
  sha256,
  textFingerprint,
} from "../_shared";

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
    const { fileName, fileType, fileContent, substituir } = (await request.json()) as {
      fileName?: string;
      fileType?: string;
      fileContent?: string;
      substituir?: boolean;
    };

    if (!fileName || !fileContent) {
      return json({ success: false, error: "Missing fileName or fileContent" }, 400);
    }

    // 1) Exact-file check first: costs nothing and avoids a wasted Gemini call.
    const bytes = base64ToBytes(fileContent);
    const hashFicheiro = await sha256(bytes);
    if (!substituir) {
      const dup = await env.DB.prepare(
        "SELECT titulo FROM documentos WHERE hash_ficheiro = ?"
      )
        .bind(hashFicheiro)
        .first<{ titulo: string }>();
      if (dup) {
        return json({
          success: false,
          duplicate: true,
          error: `Já existe: "${dup.titulo}" (ficheiro idêntico).`,
        });
      }
    }

    let extractedText = "";
    let tipoFicheiro = "txt";

    if (fileType === "text/plain") {
      extractedText = new TextDecoder().decode(bytes);
    } else if (fileType === "application/pdf") {
      extractedText = await geminiExtractPdf(env, fileContent);
      tipoFicheiro = "pdf";
    } else if (fileType === DOCX_TYPE) {
      extractedText = await extractDocx(bytes);
      tipoFicheiro = "docx";
    } else {
      return json({ success: false, error: "Unsupported file type" }, 400);
    }

    if (!extractedText.trim()) {
      return json(
        {
          success: false,
          error:
            "O documento não produziu texto. Se for um PDF digitalizado (imagem) ou protegido, não é possível extrair.",
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

    // 2) Content check: catches the same document uploaded under another name
    //    (e.g. "regulamento.pdf" and "regulamento (1).pdf").
    const hashTexto = await sha256(textFingerprint(conteudo));
    if (!substituir) {
      const dupTexto = await env.DB.prepare(
        "SELECT titulo FROM documentos WHERE hash_texto = ? AND titulo != ?"
      )
        .bind(hashTexto, titulo)
        .first<{ titulo: string }>();
      if (dupTexto) {
        return json({
          success: false,
          duplicate: true,
          error: `Conteúdo igual a "${dupTexto.titulo}".`,
        });
      }
    }

    const existing = await env.DB.prepare("SELECT id FROM documentos WHERE titulo = ?")
      .bind(titulo)
      .first<{ id: string }>();

    let docId: string;
    if (existing) {
      await env.DB.prepare(
        "UPDATE documentos SET conteudo = ?, tipo_ficheiro = ?, hash_ficheiro = ?, hash_texto = ? WHERE id = ?"
      )
        .bind(conteudo, tipoFicheiro, hashFicheiro, hashTexto, existing.id)
        .run();
      docId = existing.id;
    } else {
      const row = await env.DB.prepare(
        "INSERT INTO documentos (titulo, conteudo, tipo_ficheiro, hash_ficheiro, hash_texto) VALUES (?, ?, ?, ?, ?) RETURNING id"
      )
        .bind(titulo, conteudo, tipoFicheiro, hashFicheiro, hashTexto)
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

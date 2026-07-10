-- Esquema da base de dados D1 do Felisberto (SQLite).
-- Já aplicado à base de dados `felisberto`. Mantido aqui para referência
-- e para recriar a BD do zero se necessário (npx wrangler d1 execute felisberto --file schema.sql).

CREATE TABLE IF NOT EXISTS base_conhecimento (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  pergunta TEXT NOT NULL,
  resposta TEXT NOT NULL,
  email TEXT,
  modelo_email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documentos (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  titulo TEXT NOT NULL,
  conteudo TEXT NOT NULL,
  tipo_ficheiro TEXT
);

CREATE INDEX IF NOT EXISTS idx_documentos_titulo ON documentos(titulo);

-- Pesquisa semântica: pedaços (chunks) de documentos com embeddings do Gemini.
CREATE TABLE IF NOT EXISTS documento_chunks (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  documento_id TEXT NOT NULL,
  titulo TEXT NOT NULL,
  seq INTEGER NOT NULL,
  chunk TEXT NOT NULL,
  embedding TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON documento_chunks(documento_id);

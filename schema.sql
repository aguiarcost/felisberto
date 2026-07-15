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

-- Pesquisa híbrida: embeddings das perguntas frequentes.
CREATE TABLE IF NOT EXISTS faq_embeddings (
  faq_id TEXT PRIMARY KEY,
  embedding TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Registo de perguntas dos utilizadores (para identificar lacunas na base de conhecimento).
-- Guarda apenas a pergunta e métricas de pesquisa. Sem IP nem identificação do utilizador.
CREATE TABLE IF NOT EXISTS chat_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  pergunta TEXT NOT NULL,
  pergunta_pesquisa TEXT,
  retrieval TEXT,
  faq_score REAL,
  doc_score REAL,
  faq_match TEXT,
  fontes TEXT,
  respondido INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_logs_created ON chat_logs(created_at DESC);

-- Colunas acrescentadas para a pesquisa em dois andares e estado de processamento:
--   ALTER TABLE documentos ADD COLUMN centroid TEXT;   -- vetor médio do documento (base64 float32)
--   ALTER TABLE documentos ADD COLUMN estado TEXT NOT NULL DEFAULT 'concluido';
--   ALTER TABLE documentos ADD COLUMN erro TEXT;
--   ALTER TABLE documentos ADD COLUMN hash_ficheiro TEXT;  -- SHA-256 do ficheiro (deteta duplicados)
--   ALTER TABLE documentos ADD COLUMN hash_texto TEXT;     -- SHA-256 do texto normalizado
--   CREATE INDEX idx_docs_hash_ficheiro ON documentos(hash_ficheiro);
--   CREATE INDEX idx_docs_hash_texto ON documentos(hash_texto);

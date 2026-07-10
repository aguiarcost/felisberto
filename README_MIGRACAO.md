# Felisberto — migração para Cloudflare (nunca pausa)

O Felisberto deixou de depender do Supabase. Todo o backend passou a correr no
Cloudflare, ao lado do site — e o Cloudflare **não adormece**.

## O que mudou

| Antes (pausava) | Agora (sempre ligado) |
|---|---|
| Base de dados Postgres (Supabase) | **Cloudflare D1** (`felisberto`) |
| 3 Edge Functions (Supabase) | **Pages Functions** em `/functions/api/` |
| IA via gateway do Lovable | **Google Gemini** direto (`gemini-2.5-flash`, plano grátis) |
| Frontend em Cloudflare Pages | Frontend em Cloudflare Pages (igual) |

A base de dados D1 já foi criada e tem o esquema aplicado
(`database_id` em `wrangler.toml`). Já tem 2 perguntas de exemplo que podes apagar.

## Estrutura nova

```
functions/
  _shared.ts                 # helpers + chamadas ao Gemini
  api/
    faqs.ts                  # GET  /api/faqs           (lê perguntas + nº de documentos)
    chat.ts                  # POST /api/chat           (pesquisa + resposta da IA)
    admin.ts                 # POST /api/admin          (criar/editar/apagar/importar)
    process-document.ts      # POST /api/process-document (txt/pdf/docx)
src/lib/api.ts               # cliente do frontend (substitui o Supabase)
wrangler.toml                # binding da D1 + nodejs_compat
public/_redirects            # fallback SPA
schema.sql                   # esquema da D1 (para referência)
```

## Passos para publicar (uma vez)

### 1. Obter a chave grátis do Gemini
Vai a https://aistudio.google.com/apikey → **Create API key**. Não pede cartão.
Guarda a chave.

### 2. Ligar o repositório ao Cloudflare Pages
Envia este código para o repositório GitHub que o Cloudflare Pages constrói
(o mesmo fluxo que usas nos outros projetos). Se o projeto `felisberto` no
Cloudflare ainda for um *Lovable publish*, cria antes um projeto Pages ligado
ao GitHub (Workers & Pages → Create → Pages → Connect to Git).

Configuração de build no Pages:
- **Build command:** `npm run build`
- **Build output directory:** `dist`

### 3. Ligar a base de dados e a chave (no dashboard do Cloudflare)
No projeto Pages → **Settings**:
- **Bindings → D1 database binding:** nome da variável `DB`, base de dados `felisberto`.
  (Já vem declarado no `wrangler.toml`, mas confirma que aparece.)
- **Variables and Secrets → Add → Secret:** nome `GEMINI_API_KEY`, valor = a tua chave.
- **Runtime → Compatibility flags:** confirma `nodejs_compat` (também está no `wrangler.toml`).

### 4. Redeploy
Faz um novo deploy. Testa:
- Página principal → a lista de perguntas carrega (as 2 de exemplo).
- Escreve uma pergunta no chat → a IA responde.
- `/admin` (password atual: `decivil2024`) → criar/editar/importar.

## Dados: já migrados

As tuas **18 perguntas reais** já foram recuperadas do Supabase antigo e
inseridas na D1 nova (verificado: 18 registos, conteúdo idêntico ao carácter).
O site vai mostrá-las logo no primeiro deploy — não precisas de importar nada.

Ficheiros de backup incluídos neste pacote:
- `base_conhecimento_export.json` — as 18 perguntas no formato do Admin → Importar
  (usa-o se alguma vez precisares de repor a base).
- `seed_faqs.sql` — as mesmas perguntas em SQL, para recriar a BD do zero.
- `documentos_backup.json` — os 2 documentos (texto extraído).

**Faltam os 2 documentos** (regras de vigilâncias e submissão de notas no Fénix).
A forma mais simples de os repor é, depois do deploy, ir a
**Admin → Upload de Documentos** e voltar a carregar os 2 ficheiros originais
(.docx e .pdf) — o sistema volta a extrair o texto automaticamente.

## Desenvolvimento local (opcional)
```
cp .dev.vars.example .dev.vars   # e mete lá a tua GEMINI_API_KEY
npm install
npm run build
npx wrangler pages dev dist
```

## Notas
- **Custo:** tudo dentro dos planos gratuitos. D1 grátis chega a milhões de
  leituras/dia; Gemini Flash grátis dá ~1.500 pedidos/dia — muito acima do
  volume do Felisberto.
- **Privacidade:** no plano grátis do Gemini, a Google pode usar os prompts
  para treino. Para um FAQ público não é problema; se um dia precisares de
  privacidade, ativa faturação no Gemini (continua barato).
- **Segurança do admin:** a password está no código do frontend (como já
  estava) e o endpoint `/api/admin` é aberto — igual ao que tinhas no Supabase.
  Recomendo adicionar depois um token de admin no servidor; posso fazer isso a
  seguir se quiseres.

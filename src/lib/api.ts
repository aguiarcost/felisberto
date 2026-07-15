// Central client for the Felisberto backend (Cloudflare Pages Functions + D1).
import { BaseConhecimento } from '@/types/chat';

/* ---------------- Admin session token ---------------- */
// The token is issued by the server after validating the password.
// It lives in sessionStorage so a page refresh keeps the session,
// and disappears when the tab closes. The password itself is never stored.
const TOKEN_KEY = 'felisberto_admin_token';

export function getAdminToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAdminToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: session simply won't persist across reloads */
  }
}

/** Thrown when the server rejects the admin token (expired or invalid). */
export class UnauthorizedError extends Error {}

async function postJson<T>(path: string, body: unknown, auth = false): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth) {
    const token = getAdminToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    setAdminToken(null);
    throw new UnauthorizedError((data as { error?: string })?.error || 'Sessão expirada');
  }
  if (!res.ok) throw new Error((data as { error?: string })?.error || `Erro ${res.status}`);
  return data as T;
}

async function getJson<T>(path: string, auth = false): Promise<T> {
  const headers: Record<string, string> = {};
  if (auth) {
    const token = getAdminToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(path, { headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    setAdminToken(null);
    throw new UnauthorizedError((data as { error?: string })?.error || 'Sessão expirada');
  }
  if (!res.ok) throw new Error((data as { error?: string })?.error || `Erro ${res.status}`);
  return data as T;
}

/* ---------------- Auth ---------------- */

export async function adminLogin(password: string): Promise<void> {
  const { token } = await postJson<{ token: string }>('/api/admin-login', { password });
  setAdminToken(token);
}

export function adminLogout() {
  setAdminToken(null);
}

/* ---------------- Public ---------------- */

export function getFaqs(): Promise<{ faqs: BaseConhecimento[]; docsCount: number }> {
  return getJson('/api/faqs');
}

export interface ChatSource {
  pergunta: string;
  score: number;
  type: string;
}
export interface ChatResult {
  resposta: string;
  email: string | null;
  modelo_email: string | null;
  sources: ChatSource[];
  retrieval?: string;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export function sendChat(message: string, history: ChatTurn[] = []): Promise<ChatResult> {
  return postJson<ChatResult>('/api/chat', { message, history });
}

/* ---------------- Admin (token required) ---------------- */

export interface FAQData {
  pergunta: string;
  resposta: string;
  email?: string | null;
  modelo_email?: string | null;
}

export function adminAction(
  action: 'create' | 'update' | 'delete' | 'import' | 'delete-doc',
  payload: { id?: string; data?: FAQData | FAQData[] }
): Promise<{ success: boolean; data?: unknown; needsReindex?: boolean }> {
  return postJson('/api/admin', { action, ...payload }, true);
}

export function processDocument(
  fileName: string,
  fileType: string,
  fileContent: string
): Promise<{ success: boolean; message?: string; error?: string; chunks?: number }> {
  return postJson('/api/process-document', { fileName, fileType, fileContent }, true);
}

export function reindexDocuments(): Promise<{
  success: boolean;
  documents: number;
  totalChunks: number;
  faqs: number;
  faqError?: string;
  results: { titulo: string; chunks: number; error?: string }[];
}> {
  return postJson('/api/reindex', {}, true);
}

export interface DocItem {
  id: string;
  titulo: string;
  tipo_ficheiro: string | null;
  created_at: string;
  tamanho: number;
  chunks: number;
}

export function getDocuments(): Promise<{ documents: DocItem[] }> {
  return getJson('/api/docs', true);
}

export function deleteDocument(id: string): Promise<{ success: boolean }> {
  return postJson('/api/admin', { action: 'delete-doc', id }, true);
}

/* ---------------- Logs (token required) ---------------- */

export interface LogItem {
  id: string;
  pergunta: string;
  pergunta_pesquisa: string | null;
  retrieval: string | null;
  faq_score: number | null;
  doc_score: number | null;
  faq_match: string | null;
  fontes: string | null;
  respondido: number;
  created_at: string;
}

export interface LogGap {
  pergunta: string;
  vezes: number;
  ultima: string;
}

export function getLogs(limit = 100): Promise<{
  logs: LogItem[];
  stats: { total: number; sem_fonte: number; ultimos_7d: number };
  gaps: LogGap[];
}> {
  return getJson(`/api/logs?limit=${limit}`, true);
}

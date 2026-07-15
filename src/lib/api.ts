// Central client for the Felisberto backend (Cloudflare Pages Functions + D1).
// Replaces the previous Supabase client/edge-function calls.
import { BaseConhecimento } from '@/types/chat';

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string })?.error || `Erro ${res.status}`);
  }
  return data as T;
}

export async function getFaqs(): Promise<{ faqs: BaseConhecimento[]; docsCount: number }> {
  const res = await fetch('/api/faqs');
  if (!res.ok) throw new Error('Erro ao carregar dados');
  return res.json();
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
}

export function sendChat(message: string): Promise<ChatResult> {
  return postJson<ChatResult>('/api/chat', { message });
}

export interface FAQData {
  pergunta: string;
  resposta: string;
  email?: string | null;
  modelo_email?: string | null;
}

export function adminAction(
  action: 'create' | 'update' | 'delete' | 'import',
  payload: { id?: string; data?: FAQData | FAQData[] }
): Promise<{ success: boolean; data?: unknown }> {
  return postJson('/api/admin', { action, ...payload });
}

export function processDocument(
  fileName: string,
  fileType: string,
  fileContent: string
): Promise<{ success: boolean; message?: string; error?: string; chunks?: number }> {
  return postJson('/api/process-document', { fileName, fileType, fileContent });
}

export function reindexDocuments(): Promise<{
  success: boolean;
  documents: number;
  totalChunks: number;
  results: { titulo: string; chunks: number; error?: string }[];
}> {
  return postJson('/api/reindex', {});
}

export interface DocItem {
  id: string;
  titulo: string;
  tipo_ficheiro: string | null;
  created_at: string;
  tamanho: number;
  chunks: number;
}

export async function getDocuments(): Promise<{ documents: DocItem[] }> {
  const res = await fetch('/api/docs');
  if (!res.ok) throw new Error('Erro ao carregar documentos');
  return res.json();
}

export function deleteDocument(id: string): Promise<{ success: boolean }> {
  return postJson('/api/admin', { action: 'delete-doc', id });
}

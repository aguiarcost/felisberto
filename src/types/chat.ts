export interface Source {
  pergunta: string;
  score: number;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  email?: string;
  modeloEmail?: string;
  sources?: Source[];
  timestamp: Date;
}

export interface BaseConhecimento {
  id: string;
  pergunta: string;
  resposta: string;
  email: string | null;
  modelo_email: string | null;
  created_at: string;
}

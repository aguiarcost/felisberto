import { useState, useCallback } from 'react';
import { Message } from '@/types/chat';
import { sendChat, type ChatTurn } from '@/lib/api';

const WELCOME: Message = {
  id: 'welcome',
  role: 'assistant',
  content: 'Olá! Sou o Felisberto, o assistente ACSUTA. Como posso ajudá-lo hoje?',
  timestamp: new Date(),
};

export function useChat() {
  const [messages, setMessages] = useState<Message[]>([WELCOME]);
  const [isLoading, setIsLoading] = useState(false);

  const sendMessage = useCallback(async (content: string) => {
    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content,
      timestamp: new Date(),
    };

    // Conversation so far (excluding the greeting and the message being sent),
    // so the assistant can understand follow-up questions.
    const history: ChatTurn[] = messages
      .filter((m) => m.id !== 'welcome')
      .map((m) => ({ role: m.role, content: m.content }));

    setMessages((prev) => [...prev, userMessage]);
    setIsLoading(true);

    try {
      const data = await sendChat(content, history);

      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: data.resposta,
        email: data.email ?? undefined,
        modeloEmail: data.modelo_email ?? undefined,
        sources: data.sources || [],
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error) {
      console.error('Erro ao enviar mensagem:', error);

      // Show what actually went wrong (quota, overload, ...) instead of a
      // generic message that tells the user nothing.
      const detalhe = error instanceof Error ? error.message : '';
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: detalhe
          ? `Desculpe: ${detalhe}`
          : 'Desculpe, ocorreu um erro ao processar a sua pergunta. Por favor, tente novamente.',
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  }, [messages]);

  const clearMessages = useCallback(() => {
    setMessages([{ ...WELCOME, timestamp: new Date() }]);
  }, []);

  return {
    messages,
    isLoading,
    sendMessage,
    clearMessages,
  };
}

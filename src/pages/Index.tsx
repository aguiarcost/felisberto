import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Settings } from 'lucide-react';
import { Header } from '@/components/Header';
import { FAQCombobox } from '@/components/FAQCombobox';
import { IntegratedChat } from '@/components/IntegratedChat';
import { Button } from '@/components/ui/button';
import { getFaqs } from '@/lib/api';
import { BaseConhecimento } from '@/types/chat';
import { Skeleton } from '@/components/ui/skeleton';
import { useChat } from '@/hooks/useChat';

const Index = () => {
  const [faqs, setFaqs] = useState<BaseConhecimento[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { messages, isLoading: isChatLoading, sendMessage, clearMessages } = useChat();

  useEffect(() => {
    const fetchFAQs = async () => {
      try {
        const { faqs } = await getFaqs();
        setFaqs(
          faqs.filter(
            (f) => !f.pergunta.toUpperCase().startsWith('[DOCUMENTO]')
          )
        );
      } catch (error) {
        console.error('Erro ao carregar FAQs:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchFAQs();
  }, []);

  const handleFAQSelect = (pergunta: string) => {
    sendMessage(pergunta);
  };

  return (
    <div className="min-h-screen flex flex-col">
      <Header />

      <main className="flex-1 container mx-auto px-4 py-8">
        {/* Hero Section */}
        <section className="text-center mb-8">
          <h2 className="text-3xl font-bold text-foreground mb-4">
            Como posso ajudar?
          </h2>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            Sou o Felisberto, o assistente virtual ACSUTA. Estou aqui para responder às suas dúvidas sobre procedimentos, reservas e serviços.
          </p>
        </section>

        {/* FAQ Combobox */}
        <section className="max-w-2xl mx-auto mb-8">
          {isLoading ? (
            <Skeleton className="h-12 w-full rounded-lg" />
          ) : (
            <FAQCombobox
              faqs={faqs}
              onSelectFAQ={handleFAQSelect}
              isLoading={isLoading}
            />
          )}
        </section>

        {/* Integrated Chat */}
        <section className="max-w-2xl mx-auto">
          <IntegratedChat
            messages={messages}
            isLoading={isChatLoading}
            onSendMessage={sendMessage}
            onClearMessages={clearMessages}
          />
        </section>

        {/* Admin Link */}
        <section className="text-center mt-8">
          <Link to="/admin">
            <Button variant="ghost" size="sm" className="text-muted-foreground">
              <Settings className="h-4 w-4 mr-2" />
              Administração
            </Button>
          </Link>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t bg-card py-6">
        <div className="container mx-auto px-4 text-center text-sm text-muted-foreground">
          <p>AAC@2026</p>
        </div>
      </footer>
    </div>
  );
};

export default Index;

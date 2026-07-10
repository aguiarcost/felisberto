import { useRef, useEffect } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { Message } from '@/types/chat';
import felisbertoAvatar from '@/assets/felisberto_avatar.png';

interface IntegratedChatProps {
  messages: Message[];
  isLoading: boolean;
  onSendMessage: (content: string) => void;
  onClearMessages: () => void;
}

export function IntegratedChat({
  messages,
  isLoading,
  onSendMessage,
  onClearMessages,
}: IntegratedChatProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Scroll to bottom when messages change
    const scrollToBottom = () => {
      if (scrollRef.current) {
        const scrollContainer = scrollRef.current.querySelector('[data-radix-scroll-area-viewport]');
        if (scrollContainer) {
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
        }
      }
    };
    
    // Small delay to ensure content is rendered
    setTimeout(scrollToBottom, 50);
  }, [messages, isLoading]);

  return (
    <Card className="flex flex-col h-[500px] md:h-[600px]">
      {/* Header */}
      <CardHeader className="flex flex-row items-center justify-between gap-3 p-4 bg-primary text-primary-foreground rounded-t-lg">
        <div className="flex items-center gap-3">
          <img
            src={felisbertoAvatar}
            alt="Felisberto"
            className="h-10 w-10 rounded-full object-cover"
          />
          <div>
            <h3 className="font-semibold">Felisberto</h3>
            <p className="text-xs opacity-80">Assistente ACSUTA</p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClearMessages}
          className="text-primary-foreground hover:bg-primary-foreground/20"
          title="Limpar conversa"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </CardHeader>

      {/* Messages */}
      <CardContent className="flex-1 p-0 overflow-hidden">
        <ScrollArea className="h-full" ref={scrollRef}>
          <div className="flex flex-col gap-1 p-4">
            {messages.map((message) => (
              <ChatMessage key={message.id} message={message} />
            ))}
            {isLoading && (
              <div className="flex gap-3 p-3">
                <img
                  src={felisbertoAvatar}
                  alt="Felisberto"
                  className="h-8 w-8 shrink-0 rounded-full object-cover"
                />
                <div className="flex items-center gap-1 rounded-2xl rounded-bl-md bg-secondary px-4 py-3">
                  <span
                    className="h-2 w-2 rounded-full bg-muted-foreground/40 animate-bounce"
                    style={{ animationDelay: '0ms' }}
                  />
                  <span
                    className="h-2 w-2 rounded-full bg-muted-foreground/40 animate-bounce"
                    style={{ animationDelay: '150ms' }}
                  />
                  <span
                    className="h-2 w-2 rounded-full bg-muted-foreground/40 animate-bounce"
                    style={{ animationDelay: '300ms' }}
                  />
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
      </CardContent>

      {/* Input */}
      <div className="p-4 border-t">
        <ChatInput onSend={onSendMessage} isLoading={isLoading} />
      </div>
    </Card>
  );
}

import { Message } from '@/types/chat';
import { cn } from '@/lib/utils';
import { Mail, Copy, Check, BookOpen } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import felisbertoAvatar from '@/assets/felisberto_avatar.png';
import ReactMarkdown from 'react-markdown';

interface ChatMessageProps {
  message: Message;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const [copied, setCopied] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [isSourcesOpen, setIsSourcesOpen] = useState(false);
  const isUser = message.role === 'user';

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const hasSources = message.sources && message.sources.length > 0;

  return (
    <div
      className={cn(
        'flex w-full gap-3 p-3',
        isUser ? 'justify-end' : 'justify-start'
      )}
    >
      {!isUser && (
        <img src={felisbertoAvatar} alt="Felisberto" className="h-8 w-8 shrink-0 rounded-full object-cover" />
      )}
      <div
        className={cn(
          'max-w-[80%] rounded-2xl px-4 py-2.5 shadow-sm',
          isUser
            ? 'bg-primary text-primary-foreground rounded-br-md'
            : 'bg-secondary text-secondary-foreground rounded-bl-md'
        )}
      >
        <div className="text-sm leading-relaxed prose prose-sm max-w-none prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5">
          <ReactMarkdown>{message.content}</ReactMarkdown>
        </div>

        {hasSources && (
          <Collapsible open={isSourcesOpen} onOpenChange={setIsSourcesOpen} className="mt-2">
            <CollapsibleTrigger asChild>
              <Badge 
                variant="outline" 
                className="cursor-pointer hover:bg-background/50 gap-1 text-xs"
              >
                <BookOpen className="h-3 w-3" />
                {message.sources!.length} fonte{message.sources!.length > 1 ? 's' : ''} consultada{message.sources!.length > 1 ? 's' : ''}
              </Badge>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2">
              <div className="rounded-lg bg-background/50 p-2 text-xs space-y-1">
                {message.sources!.map((source, index) => (
                  <div key={index} className="flex items-start gap-2">
                    <span className="text-muted-foreground">•</span>
                    <span className="text-muted-foreground">{source.pergunta}</span>
                  </div>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
        
        {message.email && (
          <div className="mt-3 pt-2 border-t border-border/20">
            <a
              href={`mailto:${message.email}`}
              className={cn(
                'flex items-center gap-2 text-xs hover:underline',
                isUser ? 'text-primary-foreground/90' : 'text-muted-foreground'
              )}
            >
              <Mail className="h-3 w-3" />
              {message.email}
            </a>
          </div>
        )}

        {message.modeloEmail && (
          <Collapsible open={isOpen} onOpenChange={setIsOpen} className="mt-2">
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  'h-auto p-0 text-xs font-normal hover:bg-transparent',
                  isUser ? 'text-primary-foreground/80 hover:text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {isOpen ? '▼ Esconder modelo' : '▶ Ver modelo de email'}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2">
              <div className={cn(
                'rounded-lg p-3 text-xs',
                isUser ? 'bg-primary-foreground/10' : 'bg-background'
              )}>
                <div className="flex justify-between items-start gap-2 mb-2">
                  <span className="font-medium">Modelo de email:</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0"
                    onClick={() => copyToClipboard(message.modeloEmail || '')}
                  >
                    {copied ? (
                      <Check className="h-3 w-3" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                  </Button>
                </div>
                <pre className="whitespace-pre-wrap font-sans">{message.modeloEmail.replace(/\\n/g, '\n')}</pre>
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
      {isUser && (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground text-sm">
          👤
        </div>
      )}
    </div>
  );
}

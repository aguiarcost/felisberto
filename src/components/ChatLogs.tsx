import { useEffect, useState } from 'react';
import { MessageSquare, RefreshCw, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { getLogs, UnauthorizedError, type LogItem, type LogGap } from '@/lib/api';

function formatWhen(iso: string): string {
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('pt-PT', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ChatLogs() {
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [gaps, setGaps] = useState<LogGap[]>([]);
  const [stats, setStats] = useState({ total: 0, sem_fonte: 0, ultimos_7d: 0 });
  const [isLoading, setIsLoading] = useState(true);

  const load = async () => {
    setIsLoading(true);
    try {
      const res = await getLogs(100);
      setLogs(res.logs);
      setGaps(res.gaps);
      setStats(res.stats);
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) {
        toast.error(err instanceof Error ? err.message : 'Erro ao carregar registos');
      }
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="h-5 w-5" />
              Perguntas dos utilizadores
            </CardTitle>
            <CardDescription>
              O que as pessoas perguntam ao Felisberto e onde ele não encontrou informação.
              Use os "sem resposta" para decidir que perguntas frequentes criar.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={isLoading} className="shrink-0">
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="rounded-lg border p-3 text-center">
            <p className="text-2xl font-semibold">{stats.total}</p>
            <p className="text-xs text-muted-foreground">perguntas no total</p>
          </div>
          <div className="rounded-lg border p-3 text-center">
            <p className="text-2xl font-semibold">{stats.ultimos_7d}</p>
            <p className="text-xs text-muted-foreground">últimos 7 dias</p>
          </div>
          <div className="rounded-lg border p-3 text-center">
            <p className="text-2xl font-semibold text-amber-600">{stats.sem_fonte}</p>
            <p className="text-xs text-muted-foreground">sem fonte encontrada</p>
          </div>
        </div>

        <Tabs defaultValue="gaps">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="gaps">Lacunas ({gaps.length})</TabsTrigger>
            <TabsTrigger value="recent">Recentes ({logs.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="gaps" className="mt-3">
            {isLoading ? (
              <div className="py-6 text-center text-sm text-muted-foreground">A carregar...</div>
            ) : gaps.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                Nenhuma pergunta ficou sem fonte. Boa cobertura!
              </div>
            ) : (
              <ul className="divide-y">
                {gaps.map((g, i) => (
                  <li key={i} className="flex items-center gap-3 py-2.5">
                    <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
                    <p className="min-w-0 flex-1 truncate text-sm">{g.pergunta}</p>
                    <Badge variant="secondary" className="shrink-0">
                      {g.vezes}×
                    </Badge>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatWhen(g.ultima)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>

          <TabsContent value="recent" className="mt-3">
            {isLoading ? (
              <div className="py-6 text-center text-sm text-muted-foreground">A carregar...</div>
            ) : logs.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                Ainda não há perguntas registadas.
              </div>
            ) : (
              <ul className="divide-y max-h-[420px] overflow-y-auto">
                {logs.map((l) => (
                  <li key={l.id} className="py-2.5">
                    <div className="flex items-start gap-2">
                      <p className="min-w-0 flex-1 text-sm">{l.pergunta}</p>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatWhen(l.created_at)}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      {l.respondido ? (
                        <Badge variant="secondary" className="text-xs">
                          {l.faq_match ? 'FAQ' : 'documento'}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs text-amber-600">
                          sem fonte
                        </Badge>
                      )}
                      {l.retrieval && l.retrieval !== 'nenhuma' && (
                        <span className="text-xs text-muted-foreground">{l.retrieval}</span>
                      )}
                      {!!l.faq_score && (
                        <span className="text-xs text-muted-foreground">
                          faq {l.faq_score.toFixed(2)}
                        </span>
                      )}
                      {!!l.doc_score && (
                        <span className="text-xs text-muted-foreground">
                          doc {l.doc_score.toFixed(2)}
                        </span>
                      )}
                      {l.pergunta_pesquisa && (
                        <span className="truncate text-xs italic text-muted-foreground">
                          → {l.pergunta_pesquisa}
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

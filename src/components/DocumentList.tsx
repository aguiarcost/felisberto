import { useState } from 'react';
import { FileText, Trash2, Loader2, FileType, AlertCircle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { deleteDocument, type DocItem } from '@/lib/api';

interface DocumentListProps {
  documents: DocItem[];
  isLoading?: boolean;
  onChanged: () => void;
}

function formatBytes(chars: number): string {
  if (chars < 1000) return `${chars} car.`;
  return `${(chars / 1000).toFixed(1)}k car.`;
}

function formatDate(iso: string): string {
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function DocumentList({ documents, isLoading, onChanged }: DocumentListProps) {
  const [pendingDelete, setPendingDelete] = useState<DocItem | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleConfirmDelete = async () => {
    if (!pendingDelete) return;
    const doc = pendingDelete;
    setPendingDelete(null);
    setDeletingId(doc.id);
    try {
      await deleteDocument(doc.id);
      toast.success(`Documento "${doc.titulo}" apagado.`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao apagar documento');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="h-5 w-5" />
          Documentos ({documents.length})
        </CardTitle>
        <CardDescription>
          Documentos carregados e usados pela pesquisa. Apagar remove também os seus excertos indexados.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" />
            A carregar...
          </div>
        ) : documents.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-6">
            Ainda não há documentos carregados.
          </div>
        ) : (
          <ul className="divide-y">
            {documents.map((doc) => (
              <li key={doc.id} className="flex items-center gap-3 py-3">
                <FileType className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{doc.titulo}</p>
                  <div className="flex flex-wrap items-center gap-2 mt-1">
                    {doc.tipo_ficheiro && (
                      <Badge variant="secondary" className="text-xs uppercase">
                        {doc.tipo_ficheiro}
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground">{formatDate(doc.created_at)}</span>
                    <span className="text-xs text-muted-foreground">{formatBytes(doc.tamanho)}</span>
                    {doc.chunks > 0 ? (
                      <span className="text-xs text-muted-foreground">
                        {doc.chunks} excerto{doc.chunks === 1 ? '' : 's'} indexado{doc.chunks === 1 ? '' : 's'}
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-xs text-amber-600">
                        <AlertCircle className="h-3 w-3" />
                        não indexado
                      </span>
                    )}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="shrink-0 text-destructive hover:text-destructive"
                  onClick={() => setPendingDelete(doc)}
                  disabled={deletingId === doc.id}
                  aria-label={`Apagar ${doc.titulo}`}
                >
                  {deletingId === doc.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <AlertDialog open={!!pendingDelete} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apagar documento?</AlertDialogTitle>
            <AlertDialogDescription>
              Vai apagar "{pendingDelete?.titulo}" e todos os seus excertos indexados. Esta ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Apagar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

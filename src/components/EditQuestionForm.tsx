import { useState, useEffect } from 'react';
import { Edit, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { adminAction } from '@/lib/api';
import { BaseConhecimento } from '@/types/chat';

interface EditQuestionFormProps {
  faqs: BaseConhecimento[];
  onQuestionUpdated: () => void;
}

export function EditQuestionForm({ faqs, onQuestionUpdated }: EditQuestionFormProps) {
  const [selectedId, setSelectedId] = useState<string>('');
  const [pergunta, setPergunta] = useState('');
  const [resposta, setResposta] = useState('');
  const [email, setEmail] = useState('');
  const [modeloEmail, setModeloEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (selectedId) {
      const faq = faqs.find((f) => f.id === selectedId);
      if (faq) {
        setPergunta(faq.pergunta);
        setResposta(faq.resposta);
        setEmail(faq.email || '');
        setModeloEmail(faq.modelo_email || '');
      }
    } else {
      setPergunta('');
      setResposta('');
      setEmail('');
      setModeloEmail('');
    }
  }, [selectedId, faqs]);

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!selectedId) {
      toast.error('Selecione uma pergunta');
      return;
    }

    if (!pergunta.trim() || !resposta.trim()) {
      toast.error('Pergunta e resposta são obrigatórias');
      return;
    }

    setIsLoading(true);

    try {
      await adminAction('update', {
        id: selectedId,
        data: {
          pergunta: pergunta.trim(),
          resposta: resposta.trim(),
          email: email.trim() || null,
          modelo_email: modeloEmail.trim() || null,
        },
      });

      toast.success('Pergunta atualizada com sucesso');
      onQuestionUpdated();
    } catch (error) {
      console.error('Erro ao atualizar pergunta:', error);
      toast.error('Erro ao atualizar pergunta');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedId) return;

    setIsLoading(true);

    try {
      await adminAction('delete', { id: selectedId });

      toast.success('Pergunta apagada com sucesso');
      setSelectedId('');
      onQuestionUpdated();
    } catch (error) {
      console.error('Erro ao apagar pergunta:', error);
      toast.error('Erro ao apagar pergunta');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Edit className="h-5 w-5" />
          Editar/Apagar Pergunta
        </CardTitle>
        <CardDescription>
          Selecione uma pergunta existente para editar ou apagar
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleUpdate} className="space-y-4">
          <div className="space-y-2">
            <Label>Selecionar Pergunta</Label>
            <Select value={selectedId} onValueChange={setSelectedId}>
              <SelectTrigger>
                <SelectValue placeholder="Escolha uma pergunta..." />
              </SelectTrigger>
              <SelectContent className="bg-popover z-50">
                {faqs.map((faq) => (
                  <SelectItem key={faq.id} value={faq.id}>
                    {faq.pergunta.length > 60
                      ? faq.pergunta.substring(0, 60) + '...'
                      : faq.pergunta}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selectedId && (
            <>
              <div className="space-y-2">
                <Label htmlFor="edit-pergunta">Pergunta *</Label>
                <Input
                  id="edit-pergunta"
                  value={pergunta}
                  onChange={(e) => setPergunta(e.target.value)}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-resposta">Resposta *</Label>
                <Textarea
                  id="edit-resposta"
                  value={resposta}
                  onChange={(e) => setResposta(e.target.value)}
                  rows={4}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-email">Email de contacto (opcional)</Label>
                <Input
                  id="edit-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-modelo-email">Modelo de email (opcional)</Label>
                <Textarea
                  id="edit-modelo-email"
                  value={modeloEmail}
                  onChange={(e) => setModeloEmail(e.target.value)}
                  rows={3}
                />
              </div>

              <div className="flex gap-2">
                <Button type="submit" className="flex-1" disabled={isLoading}>
                  {isLoading ? 'A guardar...' : 'Guardar Alterações'}
                </Button>

                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button type="button" variant="destructive" disabled={isLoading}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Apagar pergunta?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Esta ação não pode ser revertida. A pergunta será permanentemente
                        removida da base de conhecimento.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancelar</AlertDialogCancel>
                      <AlertDialogAction onClick={handleDelete}>
                        Apagar
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

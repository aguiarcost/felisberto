import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { adminAction } from '@/lib/api';

interface CreateQuestionFormProps {
  onQuestionCreated: () => void;
}

export function CreateQuestionForm({ onQuestionCreated }: CreateQuestionFormProps) {
  const [pergunta, setPergunta] = useState('');
  const [resposta, setResposta] = useState('');
  const [email, setEmail] = useState('');
  const [modeloEmail, setModeloEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!pergunta.trim() || !resposta.trim()) {
      toast.error('Pergunta e resposta são obrigatórias');
      return;
    }

    setIsLoading(true);

    try {
      await adminAction('create', {
        data: {
          pergunta: pergunta.trim(),
          resposta: resposta.trim(),
          email: email.trim() || null,
          modelo_email: modeloEmail.trim() || null,
        },
      });

      toast.success('Pergunta criada com sucesso');
      setPergunta('');
      setResposta('');
      setEmail('');
      setModeloEmail('');
      onQuestionCreated();
    } catch (error) {
      console.error('Erro ao criar pergunta:', error);
      toast.error('Erro ao criar pergunta');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Plus className="h-5 w-5" />
          Criar Nova Pergunta
        </CardTitle>
        <CardDescription>
          Adicione uma nova pergunta à base de conhecimento
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="pergunta">Pergunta *</Label>
            <Input
              id="pergunta"
              value={pergunta}
              onChange={(e) => setPergunta(e.target.value)}
              placeholder="Ex: Como posso reservar uma sala?"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="resposta">Resposta *</Label>
            <Textarea
              id="resposta"
              value={resposta}
              onChange={(e) => setResposta(e.target.value)}
              placeholder="Escreva a resposta detalhada..."
              rows={4}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">Email de contacto (opcional)</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Ex: acsuta@example.pt"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="modelo-email">Modelo de email (opcional)</Label>
            <Textarea
              id="modelo-email"
              value={modeloEmail}
              onChange={(e) => setModeloEmail(e.target.value)}
              placeholder="Modelo de email sugerido..."
              rows={3}
            />
          </div>

          <Button type="submit" className="w-full" disabled={isLoading}>
            {isLoading ? 'A guardar...' : 'Guardar Nova Pergunta'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

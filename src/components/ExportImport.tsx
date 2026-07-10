import { useState, useRef } from 'react';
import { Download, Upload, FileJson } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from 'sonner';
import { adminAction } from '@/lib/api';
import { BaseConhecimento } from '@/types/chat';

interface ExportImportProps {
  faqs: BaseConhecimento[];
  onImportComplete: () => void;
}

export function ExportImport({ faqs, onImportComplete }: ExportImportProps) {
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExport = () => {
    const exportData = faqs.map((faq) => ({
      pergunta: faq.pergunta,
      resposta: faq.resposta,
      email: faq.email,
      modelo_email: faq.modelo_email,
    }));

    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: 'application/json',
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `base_conhecimento_${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toast.success('Base de conhecimento exportada');
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type !== 'application/json') {
      toast.error('Por favor selecione um ficheiro JSON');
      return;
    }

    setIsImporting(true);

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (!Array.isArray(data)) {
        throw new Error('O ficheiro deve conter um array de perguntas');
      }

      // Validate structure
      for (const item of data) {
        if (!item.pergunta || !item.resposta) {
          throw new Error('Cada item deve ter "pergunta" e "resposta"');
        }
      }

      // Import via backend function
      await adminAction('import', { data });

      toast.success(`${data.length} perguntas importadas com sucesso`);
      onImportComplete();
    } catch (error) {
      console.error('Erro ao importar:', error);
      toast.error(error instanceof Error ? error.message : 'Erro ao importar ficheiro');
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileJson className="h-5 w-5" />
          Exportar/Importar JSON
        </CardTitle>
        <CardDescription>
          Faça backup ou restaure a base de conhecimento
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex gap-2">
          <Button onClick={handleExport} variant="outline" className="flex-1">
            <Download className="h-4 w-4 mr-2" />
            Exportar
          </Button>

          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleFileChange}
            className="hidden"
          />

          <Button
            onClick={handleImportClick}
            variant="outline"
            className="flex-1"
            disabled={isImporting}
          >
            <Upload className="h-4 w-4 mr-2" />
            {isImporting ? 'A importar...' : 'Importar'}
          </Button>
        </div>

        <p className="text-xs text-muted-foreground mt-3">
          O formato JSON deve ser um array com objetos contendo "pergunta" e "resposta".
        </p>
      </CardContent>
    </Card>
  );
}

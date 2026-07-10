import { useState, useRef } from 'react';
import { Upload, FileText, Loader2, CheckCircle, XCircle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from 'sonner';
import { processDocument } from '@/lib/api';
import { Progress } from '@/components/ui/progress';

interface DocumentUploadProps {
  onDocumentProcessed: () => void;
}

interface UploadingFile {
  name: string;
  status: 'pending' | 'uploading' | 'success' | 'error';
  error?: string;
}

const ACCEPTED_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
];

const ACCEPTED_EXTENSIONS = '.pdf,.docx,.txt';

export function DocumentUpload({ onDocumentProcessed }: DocumentUploadProps) {
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFile = async (file: File): Promise<{ success: boolean; error?: string }> => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      
      reader.onload = async () => {
        try {
          const base64 = (reader.result as string).split(',')[1];

          const data = await processDocument(file.name, file.type, base64);

          if (data?.success) {
            resolve({ success: true });
          } else {
            resolve({ success: false, error: data?.error || 'Erro ao processar documento' });
          }
        } catch (err) {
          resolve({ success: false, error: err instanceof Error ? err.message : 'Erro desconhecido' });
        }
      };

      reader.onerror = () => {
        resolve({ success: false, error: 'Erro ao ler ficheiro' });
      };

      reader.readAsDataURL(file);
    });
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    // Filter valid files
    const validFiles = files.filter(file => ACCEPTED_TYPES.includes(file.type));
    const invalidFiles = files.filter(file => !ACCEPTED_TYPES.includes(file.type));

    if (invalidFiles.length > 0) {
      toast.error(`${invalidFiles.length} ficheiro(s) com tipo não suportado foram ignorados.`);
    }

    if (validFiles.length === 0) return;

    // Initialize upload state
    setUploadingFiles(validFiles.map(f => ({ name: f.name, status: 'pending' })));
    setIsUploading(true);

    let successCount = 0;
    let errorCount = 0;

    // Process files sequentially to avoid overwhelming the server
    for (let i = 0; i < validFiles.length; i++) {
      const file = validFiles[i];
      
      setUploadingFiles(prev => 
        prev.map((f, idx) => idx === i ? { ...f, status: 'uploading' } : f)
      );

      const result = await processFile(file);

      setUploadingFiles(prev => 
        prev.map((f, idx) => 
          idx === i 
            ? { ...f, status: result.success ? 'success' : 'error', error: result.error } 
            : f
        )
      );

      if (result.success) {
        successCount++;
      } else {
        errorCount++;
      }
    }

    // Show summary toast
    if (successCount > 0) {
      toast.success(`${successCount} documento(s) processado(s) com sucesso!`);
      onDocumentProcessed();
    }
    if (errorCount > 0) {
      toast.error(`${errorCount} documento(s) falharam.`);
    }

    // Reset after a delay
    setTimeout(() => {
      setUploadingFiles([]);
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }, 3000);
  };

  const completedCount = uploadingFiles.filter(f => f.status === 'success' || f.status === 'error').length;
  const progress = uploadingFiles.length > 0 ? (completedCount / uploadingFiles.length) * 100 : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Upload className="h-5 w-5" />
          Upload de Documentos
        </CardTitle>
        <CardDescription>
          Carregue documentos (PDF, DOCX, TXT) para extrair conteúdo automaticamente. Pode selecionar múltiplos ficheiros.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_EXTENSIONS}
            onChange={handleFileChange}
            className="hidden"
            id="document-upload"
            multiple
          />

          <label
            htmlFor="document-upload"
            className={`flex flex-col items-center justify-center w-full h-32 border-2 border-dashed rounded-lg cursor-pointer transition-colors ${
              isUploading
                ? 'border-primary bg-primary/5 pointer-events-none'
                : 'border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50'
            }`}
          >
            {isUploading ? (
              <div className="flex flex-col items-center gap-2 w-full px-4">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <span className="text-sm text-muted-foreground">
                  A processar {completedCount}/{uploadingFiles.length} ficheiros...
                </span>
                <Progress value={progress} className="w-full max-w-xs h-2" />
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <FileText className="h-8 w-8 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">
                  Clique para selecionar ficheiros
                </span>
                <span className="text-xs text-muted-foreground/70">
                  PDF, DOCX ou TXT (múltiplos ficheiros permitidos)
                </span>
              </div>
            )}
          </label>

          {/* File status list */}
          {uploadingFiles.length > 0 && (
            <div className="space-y-2 max-h-40 overflow-y-auto">
              {uploadingFiles.map((file, idx) => (
                <div key={idx} className="flex items-center gap-2 text-sm">
                  {file.status === 'pending' && (
                    <div className="h-4 w-4 rounded-full bg-muted" />
                  )}
                  {file.status === 'uploading' && (
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  )}
                  {file.status === 'success' && (
                    <CheckCircle className="h-4 w-4 text-green-500" />
                  )}
                  {file.status === 'error' && (
                    <XCircle className="h-4 w-4 text-destructive" />
                  )}
                  <span className={file.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}>
                    {file.name}
                    {file.error && <span className="ml-2 text-xs">({file.error})</span>}
                  </span>
                </div>
              ))}
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            O conteúdo dos documentos será extraído e adicionado à base de conhecimento.
            O nome de cada ficheiro será usado como pergunta.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

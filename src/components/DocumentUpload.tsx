import { useState, useRef } from 'react';
import { Upload, FileText, Loader2, CheckCircle, XCircle, RefreshCw, CopyCheck } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { processDocument, reindexDocuments } from '@/lib/api';
import { Progress } from '@/components/ui/progress';

interface DocumentUploadProps {
  onDocumentProcessed: () => void;
}

interface UploadingFile {
  name: string;
  status: 'pending' | 'uploading' | 'success' | 'error' | 'duplicate';
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
  const [isReindexing, setIsReindexing] = useState(false);
  const [reindexProgress, setReindexProgress] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reindexing runs in batches: the free plan caps subrequests per invocation,
  // so we keep calling until the backend reports nothing left to do.
  const handleReindex = async () => {
    setIsReindexing(true);
    setReindexProgress('a iniciar...');
    try {
      // Continue the existing queue. Only rebuild from scratch when there is
      // genuinely nothing left to do — otherwise every click would discard the
      // progress of the previous one.
      let force = false;
      let docs = 0;
      let chunks = 0;
      let faqs = 0;
      const errors: string[] = [];

      for (let pass = 0; pass < 120; pass++) {
        const res = await reindexDocuments(force);
        force = false;

        if (res.nothingPending) {
          if (pass === 0) {
            setReindexProgress('tudo indexado — a reconstruir do início...');
            force = true;
            continue;
          }
          break;
        }
        docs += res.documents;
        chunks += res.totalChunks;
        faqs = faqs || res.faqs;
        res.results.filter((r) => r.error).forEach((r) => errors.push(r.titulo));

        if (res.remaining === 0) break;

        // The embedding quota is 100 excerpts/minute. When we hit it, wait the
        // exact time Google asks for instead of hammering it.
        if (res.rateLimited) {
          const wait = res.retryAfter || 30;
          for (let s = wait; s > 0; s--) {
            setReindexProgress(
              `${docs} feitos, ${res.remaining} por indexar — a aguardar quota (${s}s)...`
            );
            await new Promise((r) => setTimeout(r, 1000));
          }
          continue;
        }

        setReindexProgress(`${docs} feitos, ${res.remaining} por indexar...`);
        if (res.documents === 0 && !res.rateLimited) break; // nothing progressed
      }

      if (errors.length) {
        toast.warning(
          `Índice reconstruído: ${faqs} perguntas, ${docs} documento(s), ${chunks} excertos. ${errors.length} falharam.`
        );
      } else {
        toast.success(
          `Índice reconstruído: ${faqs} perguntas, ${docs} documento(s), ${chunks} excertos.`
        );
      }
      onDocumentProcessed?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao reindexar');
    } finally {
      setIsReindexing(false);
      setReindexProgress('');
    }
  };

  const processFile = async (
    file: File
  ): Promise<{ success: boolean; error?: string; duplicate?: boolean; rateLimited?: boolean }> => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      
      reader.onload = async () => {
        try {
          const base64 = (reader.result as string).split(',')[1];

          const data = await processDocument(file.name, file.type, base64);

          if (data?.success) {
            resolve({ success: true });
          } else {
            resolve({
              success: false,
              duplicate: data?.duplicate,
              rateLimited: data?.rateLimited,
              error: data?.error || 'Erro ao processar documento',
            });
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
    let duplicateCount = 0;

    // Process files sequentially to avoid overwhelming the server
    for (let i = 0; i < validFiles.length; i++) {
      const file = validFiles[i];
      
      setUploadingFiles(prev => 
        prev.map((f, idx) => idx === i ? { ...f, status: 'uploading' } : f)
      );

      const result = await processFile(file);

      const status = result.success ? 'success' : result.duplicate ? 'duplicate' : 'error';
      setUploadingFiles(prev =>
        prev.map((f, idx) => (idx === i ? { ...f, status, error: result.error } : f))
      );

      if (result.success) successCount++;
      else if (result.duplicate) duplicateCount++;
      else errorCount++;

      // Quota exhausted: every remaining file would fail the same way, so stop
      // and leave them pending instead of marking them all as errors.
      if (result.rateLimited) {
        const restantes = validFiles.length - (i + 1);
        setUploadingFiles(prev =>
          prev.map((f, idx) => (idx > i ? { ...f, status: 'pending' } : f))
        );
        toast.error(
          restantes > 0
            ? `Quota do Gemini esgotada. ${restantes} ficheiro(s) por carregar — tente mais tarde.`
            : 'Quota do Gemini esgotada. Tente mais tarde.'
        );
        break;
      }
    }

    // Show summary toast
    if (successCount > 0) {
      toast.success(`${successCount} documento(s) processado(s) com sucesso!`);
      onDocumentProcessed();
    }
    if (duplicateCount > 0) {
      toast.info(`${duplicateCount} documento(s) já existiam e foram ignorados.`);
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
                  {file.status === 'duplicate' && (
                    <CopyCheck className="h-4 w-4 text-blue-500" />
                  )}
                  {file.status === 'error' && (
                    <XCircle className="h-4 w-4 text-destructive" />
                  )}
                  <span
                    className={
                      file.status === 'error'
                        ? 'text-destructive'
                        : file.status === 'duplicate'
                          ? 'text-blue-600'
                          : 'text-muted-foreground'
                    }
                  >
                    {file.name}
                    {file.error && <span className="ml-2 text-xs">({file.error})</span>}
                  </span>
                </div>
              ))}
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            O conteúdo dos documentos é extraído e indexado para pesquisa semântica.
            Documentos novos são indexados automaticamente ao carregar. Ficheiros já
            existentes (mesmo com outro nome) são detetados e ignorados.
          </p>

          <div className="flex items-center justify-between gap-2 border-t pt-4">
            <div className="text-xs text-muted-foreground">
              Reconstruir o índice semântico de todos os documentos (use após importar
              dados ou se a pesquisa parecer desatualizada). Corre por lotes; mantenha
              esta página aberta até terminar.
              {reindexProgress && (
                <span className="mt-1 block font-medium text-foreground">{reindexProgress}</span>
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleReindex}
              disabled={isReindexing || isUploading}
              className="shrink-0"
            >
              {isReindexing ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              {isReindexing ? 'A reindexar...' : 'Reindexar'}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

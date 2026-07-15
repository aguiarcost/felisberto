import { useState, useEffect } from 'react';
import { ArrowLeft, Settings, LogOut } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { AdminPasswordDialog } from '@/components/AdminPasswordDialog';
import { CreateQuestionForm } from '@/components/CreateQuestionForm';
import { EditQuestionForm } from '@/components/EditQuestionForm';
import { DocumentUpload } from '@/components/DocumentUpload';
import { DocumentList } from '@/components/DocumentList';
import { ChatLogs } from '@/components/ChatLogs';
import { ExportImport } from '@/components/ExportImport';
import { getFaqs, getDocuments, getAdminToken, adminLogout, UnauthorizedError, type DocItem } from '@/lib/api';
import { BaseConhecimento } from '@/types/chat';
import felisbertoAvatar from '@/assets/felisberto_avatar.png';

const Admin = () => {
  const navigate = useNavigate();
  // Resume an existing session (token in sessionStorage) instead of asking again.
  const [isAuthenticated, setIsAuthenticated] = useState(() => !!getAdminToken());
  const [faqs, setFaqs] = useState<BaseConhecimento[]>([]);
  const [documents, setDocuments] = useState<DocItem[]>([]);
  const [docsCount, setDocsCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  const handleLogout = () => {
    adminLogout();
    setIsAuthenticated(false);
    navigate('/');
  };

  const fetchData = async () => {
    setIsLoading(true);
    try {
      const [{ faqs, docsCount }, { documents }] = await Promise.all([
        getFaqs(),
        getDocuments(),
      ]);
      setFaqs(faqs);
      setDocsCount(docsCount);
      setDocuments(documents);
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        setIsAuthenticated(false);
        return;
      }
      console.error('Erro ao carregar dados:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isAuthenticated) {
      fetchData();
    }
  }, [isAuthenticated]);

  if (!isAuthenticated) {
    return (
      <AdminPasswordDialog
        open={!isAuthenticated}
        onAuthenticated={() => setIsAuthenticated(true)}
        onCancel={() => navigate('/')}
      />
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Header */}
      <header className="border-b bg-card">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <img
                src={felisbertoAvatar}
                alt="Felisberto"
                className="h-10 w-10 rounded-full object-cover shadow-md"
              />
              <div>
                <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
                  <Settings className="h-5 w-5" />
                  Administração
                </h1>
                <p className="text-sm text-muted-foreground">
                  Gestão da base de conhecimento
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={handleLogout}>
                <LogOut className="h-4 w-4 mr-2" />
                Terminar sessão
              </Button>
              <Link to="/">
                <Button variant="outline">
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Voltar
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 container mx-auto px-4 py-8">
        <div className="grid gap-6 lg:grid-cols-2">
          <CreateQuestionForm onQuestionCreated={fetchData} />
          <EditQuestionForm faqs={faqs} onQuestionUpdated={fetchData} />
          <DocumentUpload onDocumentProcessed={fetchData} />
          <ExportImport faqs={faqs} onImportComplete={fetchData} />
        </div>

        <div className="mt-6">
          <DocumentList documents={documents} isLoading={isLoading} onChanged={fetchData} />
        </div>

        <div className="mt-6">
          <ChatLogs />
        </div>

        {/* Stats */}
        <div className="mt-8 p-4 bg-muted/50 rounded-lg">
          <p className="text-sm text-muted-foreground text-center">
            {isLoading
              ? 'A carregar...'
              : `${faqs.length} perguntas frequentes • ${docsCount} documentos`}
          </p>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t bg-card py-4">
        <div className="container mx-auto px-4 text-center text-sm text-muted-foreground">
          <p>AAC@2026</p>
        </div>
      </footer>
    </div>
  );
};

export default Admin;

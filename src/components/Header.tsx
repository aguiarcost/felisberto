import felisbertoAvatar from '@/assets/felisberto_avatar.png';

export function Header() {
  return (
    <header className="border-b bg-card">
      <div className="container mx-auto px-4 py-6">
        <div className="flex items-center gap-4">
          <img 
            src={felisbertoAvatar} 
            alt="Felisberto" 
            className="h-14 w-14 rounded-full object-cover shadow-md"
          />
          <div>
            <h1 className="text-2xl font-bold text-foreground">Felisberto</h1>
            <p className="text-muted-foreground">Assistente Virtual ACSUTA</p>
          </div>
        </div>
      </div>
    </header>
  );
}

import { Link } from 'react-router-dom';

export default function PageNotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-background">
      <div className="text-center space-y-6">
        <div className="text-6xl">🎮</div>
        <h1 className="text-6xl font-bold font-mono bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent">
          404
        </h1>
        <h2 className="text-xl font-medium text-foreground">Pagina Non Trovata</h2>
        <p className="text-sm text-muted-foreground max-w-sm">
          Questa pagina non esiste. Forse stavi cercando un trofeo segreto?
        </p>
        <Link
          to="/"
          className="inline-flex items-center px-6 py-3 text-sm font-medium bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 transition-colors glow-purple"
        >
          Torna alla Home
        </Link>
      </div>
    </div>
  );
}
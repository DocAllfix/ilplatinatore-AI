# Il Platinatore AI — Frontend

Frontend Vite + React 18 + Tailwind per Il Platinatore AI.

## Prerequisiti

1. Backend in esecuzione su `http://localhost:3000` (vedi `../backend/README.md`).
2. Node.js >= 18.

## Setup

```bash
npm install
```

Crea un file `.env.local` (opzionale — i default funzionano):

```
VITE_API_BACKEND_URL=http://localhost:3000
VITE_API_BASE_URL=
```

- `VITE_API_BACKEND_URL` — target del proxy `/api` di Vite in dev (default `http://localhost:3000`).
- `VITE_API_BASE_URL` — prefisso assoluto usato dal client fetch in prod (default vuoto → stessa origin).

## Script

| Comando | Azione |
|---------|--------|
| `npm run dev` | Dev server su `http://localhost:5173` con proxy `/api` → backend |
| `npm run build` | Build di produzione in `dist/` |
| `npm run preview` | Serve la build di produzione in locale |
| `npm run lint` | ESLint (quiet mode) |
| `npm run typecheck` | Controllo tipi TypeScript su sorgente JSX (`checkJs: true`) |

## Architettura

- `src/api/client.js` — fetch shim compatibile con la shape `api.auth.*` / `api.entities.*` usata dalle pagine. Auth cablata sugli endpoint reali di Fase 18; endpoint non ancora pronti restituiscono stub con `console.warn`.
- `src/lib/AuthContext.jsx` — provider React che espone `user`, `isAuthenticated`, `isLoadingAuth`, `logout`, `checkUserAuth` (wrapper su `api.auth.me`).
- `src/components/ui/` — componenti Radix UI + `class-variance-authority` (shadcn/ui style).
- `src/pages/` — pagine di livello top instradate da `react-router-dom` v6.
- `vite.config.js` — alias `@` → `src/`, proxy `/api` → backend.

## Stato Fase 21

Fase 21.0 completata (design port + rimozione SDK esterno). Auth hardening, login UI reali e wiring endpoint mancanti sono pianificati in Fase 21.1+ (vedi `../../project-status.md`).

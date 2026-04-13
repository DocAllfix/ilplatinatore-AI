# Il Platinatore AI

Chatbot AI per guide videoludiche con pipeline RAG (Retrieval-Augmented Generation).

## Descrizione

Il Platinatore AI è un assistente conversazionale specializzato in guide per videogiochi. Risponde a domande specifiche su trofei, achievement, segreti e strategie attingendo a una knowledge base costruita tramite scraping di siti specializzati e articoli WordPress del blog [ilplatinatore.it](https://www.ilplatinatore.it).

## Stack Tecnologico

| Layer | Tecnologia |
|-------|-----------|
| Backend API | Node.js + TypeScript + Express |
| Database | PostgreSQL + pgvector (ricerca semantica) |
| Connection pooling | PgBouncer |
| Cache / Queue | Redis + BullMQ |
| LLM | Google Gemini 2.5 Flash |
| Embedding | Google Embedding API (768 dim) |
| Scraper | Node.js + Cheerio + Puppeteer |
| Frontend | Base44 (gestione esterna) |

## Struttura del Progetto

```
il-platinatore-ai/
├── backend/        # API Express + pipeline RAG
├── scraper/        # Estrazione contenuti da siti di guide
├── frontend/       # Gestito esternamente (Base44)
├── infra/          # Configurazioni Docker/Nginx
└── scripts/        # Utilità migrate/seed
```

## Avvio in Sviluppo

```bash
# 1. Copia il template delle variabili d'ambiente
cp .env.example .env
# Modifica .env con le tue credenziali

# 2. Avvia l'infrastruttura
docker compose -f docker-compose.dev.yml up -d

# 3. Esegui le migrazioni
./scripts/migrate.sh

# 4. (Opzionale) Carica dati di test
./scripts/seed.sh
```

## Architettura RAG

Il sistema utilizza una pipeline RAG ibrida:
1. **Retrieval**: ricerca vettoriale HNSW su pgvector + full-text search PostgreSQL con Reciprocal Rank Fusion (RRF)
2. **Augmentation**: i chunk più rilevanti vengono inseriti nel contesto del prompt
3. **Generation**: Gemini 2.5 Flash genera la risposta finale

## Licenza

Progetto privato — tutti i diritti riservati.

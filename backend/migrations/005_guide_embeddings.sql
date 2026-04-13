-- Migration 005: Tabella guide_embeddings (pgvector)
-- CORREZIONE AUDIT: usa HNSW invece di IVFFlat
CREATE TABLE IF NOT EXISTS guide_embeddings (
    id SERIAL PRIMARY KEY,
    guide_id INT NOT NULL REFERENCES guides(id) ON DELETE CASCADE,
    embedding vector(768),
    chunk_index INT DEFAULT 0,
    chunk_text TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_embeddings_guide ON guide_embeddings(guide_id);
-- CORREZIONE AUDIT: indice HNSW per migliore recall senza necessità di reindex periodico
CREATE INDEX IF NOT EXISTS idx_embeddings_vector ON guide_embeddings
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

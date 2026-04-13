-- Migration: Tabella harvest_sources — tracciabilità ingestion
-- Ogni guida scrapata ha almeno un record qui per audit e difesa legale

CREATE TABLE IF NOT EXISTS harvest_sources (
    id SERIAL PRIMARY KEY,
    guide_id INT NOT NULL REFERENCES guides(id) ON DELETE CASCADE,
    source_url TEXT NOT NULL,
    source_domain VARCHAR(255) NOT NULL,
    scraped_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    content_hash VARCHAR(64) NOT NULL,
    raw_content_length INT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_harvest_source_url ON harvest_sources(source_url);
CREATE INDEX IF NOT EXISTS idx_harvest_guide ON harvest_sources(guide_id);
CREATE INDEX IF NOT EXISTS idx_harvest_domain ON harvest_sources(source_domain);

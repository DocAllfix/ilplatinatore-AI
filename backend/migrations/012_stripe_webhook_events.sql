-- Migration 012: Tabella stripe_webhook_events
-- AUDIT: idempotenza webhook Stripe — ogni event_id viene processato una sola volta.
-- Previene doppi pagamenti, doppie attivazioni tier, race condition su retry Stripe.
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
    event_id VARCHAR(255) PRIMARY KEY,
    event_type VARCHAR(100) NOT NULL,
    subscription_id VARCHAR(255),
    customer_id VARCHAR(255),
    payload JSONB NOT NULL DEFAULT '{}',
    processed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stripe_events_subscription ON stripe_webhook_events(subscription_id);
CREATE INDEX IF NOT EXISTS idx_stripe_events_type ON stripe_webhook_events(event_type);

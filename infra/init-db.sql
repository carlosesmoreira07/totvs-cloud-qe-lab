-- [LAB] Schema PostgreSQL para o laboratorio LAB-05 (Transactional Outbox)
-- Nao representa schemas ou arquitetura interna da TOTVS.

CREATE TABLE IF NOT EXISTS instances (
    id UUID PRIMARY KEY,
    name VARCHAR(40) NOT NULL,
    region VARCHAR(64) NOT NULL,
    image VARCHAR(128) NOT NULL,
    flavor VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS operations (
    id UUID PRIMARY KEY,
    type VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL,
    resource_id UUID NOT NULL REFERENCES instances(id),
    correlation_id VARCHAR(128) NOT NULL,
    submitted_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_records (
    idempotency_key VARCHAR(128) PRIMARY KEY,
    fingerprint VARCHAR(64) NOT NULL,
    operation_id UUID NOT NULL REFERENCES operations(id),
    created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox_events (
    id UUID PRIMARY KEY,
    event_type VARCHAR(128) NOT NULL,
    aggregate_type VARCHAR(64) NOT NULL,
    aggregate_id UUID NOT NULL,
    correlation_id VARCHAR(128) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    retry_count INT NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_outbox_events_pending 
ON outbox_events (status, created_at) 
WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS processed_events (
    event_id UUID PRIMARY KEY,
    consumer_name VARCHAR(64) NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL
);

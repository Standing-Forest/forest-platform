CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS forests;
CREATE SCHEMA IF NOT EXISTS events;
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS core.instances (
    id UUID PRIMARY KEY,
    public_id TEXT NOT NULL CONSTRAINT instances_public_id_unique UNIQUE,
    canonical_url TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS forests.projects (
    id UUID PRIMARY KEY,
    public_id TEXT NOT NULL CONSTRAINT projects_public_id_unique UNIQUE,
    home_instance_id UUID NOT NULL CONSTRAINT projects_home_instance_id_instances_id_fk REFERENCES core.instances(id),
    lead_organization_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS events.outbox (
    id UUID PRIMARY KEY,
    event_id UUID NOT NULL CONSTRAINT outbox_event_id_unique UNIQUE,
    event_type TEXT NOT NULL,
    schema_version INTEGER NOT NULL CONSTRAINT outbox_schema_version_check CHECK (schema_version > 0),
    aggregate_type TEXT NOT NULL,
    aggregate_id UUID NOT NULL,
    aggregate_sequence BIGINT NOT NULL CONSTRAINT outbox_aggregate_sequence_check CHECK (aggregate_sequence > 0),
    payload JSONB NOT NULL,
    requirement_ids JSONB NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL,
    published_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_outbox_aggregate_sequence
ON events.outbox(aggregate_type, aggregate_id, aggregate_sequence);

-- DRAFT — proposed, not approved, NOT APPLIED.
--
-- This file is not run by scripts/migrate.ts, which reads only the approved
-- package. Move it there, drop the .draft suffix and renumber it before it
-- becomes real.
--
-- Follows the conventions of 0001_foundation.sql: explicit constraint names
-- matching what drizzle-kit generates, UUID primary keys (UUIDv7 supplied by
-- the application, ADR-019), and TIMESTAMPTZ throughout.

CREATE SCHEMA IF NOT EXISTS parties;

-- ---------------------------------------------------------------------------
-- parties.parties — a person or organization (PARTY-001)
--
-- Bitemporal per ARCH-003: valid_from/valid_to are real-world time,
-- recorded_at/superseded_at are system time. A correction supersedes a row and
-- inserts a new one; rows are never updated in place and never deleted.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parties.parties (
    id UUID PRIMARY KEY,
    party_id UUID NOT NULL,
    home_instance_id UUID NOT NULL
        CONSTRAINT parties_home_instance_id_instances_id_fk REFERENCES core.instances(id),
    party_type TEXT NOT NULL
        CONSTRAINT parties_party_type_check CHECK (party_type IN ('person', 'organization')),
    display_name TEXT NOT NULL,
    community TEXT,
    contact JSONB NOT NULL DEFAULT '{}'::jsonb,
    identity_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
    data_classification TEXT NOT NULL
        CONSTRAINT parties_data_classification_check
        CHECK (data_classification IN ('confidential', 'restricted', 'cultural_restricted')),
    valid_from TIMESTAMPTZ NOT NULL,
    valid_to TIMESTAMPTZ,
    recorded_at TIMESTAMPTZ NOT NULL,
    superseded_at TIMESTAMPTZ,
    CONSTRAINT parties_valid_period_check CHECK (valid_to IS NULL OR valid_to > valid_from)
);

-- Exactly one current version per party.
CREATE UNIQUE INDEX IF NOT EXISTS uq_parties_current_version
ON parties.parties(party_id) WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_parties_tenant ON parties.parties(home_instance_id);

-- ---------------------------------------------------------------------------
-- parties.consent_grants — what a party agreed to (CONSENT-002, CONSENT-003)
--
-- Withdrawal sets withdrawn_at. Rows are never deleted: see open question 3,
-- which is unresolved and may not satisfy a legal right to erasure.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parties.consent_grants (
    id UUID PRIMARY KEY,
    home_instance_id UUID NOT NULL
        CONSTRAINT consent_grants_home_instance_id_instances_id_fk REFERENCES core.instances(id),
    party_id UUID NOT NULL,
    scope_parcel_id UUID,  -- no FK: forests.parcels does not exist (GEO-001)
    permitted_uses JSONB NOT NULL,
    granted_at TIMESTAMPTZ NOT NULL,
    language_tag TEXT NOT NULL,
    method TEXT NOT NULL
        CONSTRAINT consent_grants_method_check
        CHECK (method IN ('written_signature', 'thumbprint', 'witnessed_verbal', 'digital_signature')),
    witness_party_id UUID,
    evidence JSONB,
    withdrawn_at TIMESTAMPTZ,
    withdrawal_reason TEXT,
    recorded_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT consent_grants_permitted_uses_check CHECK (jsonb_array_length(permitted_uses) > 0),
    CONSTRAINT consent_grants_witness_check
        CHECK (method <> 'witnessed_verbal' OR witness_party_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ix_consent_grants_party ON parties.consent_grants(party_id);
CREATE INDEX IF NOT EXISTS ix_consent_grants_active
ON parties.consent_grants(party_id) WHERE withdrawn_at IS NULL;

-- ---------------------------------------------------------------------------
-- parties.land_roles — farmer / landowner / land_controller (LAND-001, LAND-002)
--
-- The role is a relationship between a party and a parcel, not a property of
-- the party: one person is often both farmer and landowner, and a controller
-- is frequently neither the registered owner nor the farmer.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parties.land_roles (
    id UUID PRIMARY KEY,
    land_role_id UUID NOT NULL,
    home_instance_id UUID NOT NULL
        CONSTRAINT land_roles_home_instance_id_instances_id_fk REFERENCES core.instances(id),
    party_id UUID NOT NULL,
    parcel_id UUID NOT NULL,  -- no FK: forests.parcels does not exist (GEO-001)
    role TEXT NOT NULL
        CONSTRAINT land_roles_role_check
        CHECK (role IN ('farmer', 'landowner', 'land_controller')),
    authority_basis TEXT,
    conveys_authority_to_commit BOOLEAN NOT NULL,
    exclusive BOOLEAN NOT NULL DEFAULT FALSE,
    supporting_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
    asserted_by UUID NOT NULL,
    supersedes_land_role_id UUID,
    valid_from TIMESTAMPTZ NOT NULL,
    valid_to TIMESTAMPTZ,
    recorded_at TIMESTAMPTZ NOT NULL,
    superseded_at TIMESTAMPTZ,
    CONSTRAINT land_roles_valid_period_check CHECK (valid_to IS NULL OR valid_to > valid_from),
    -- A land_controller must say on what basis it holds authority.
    CONSTRAINT land_roles_authority_basis_check
        CHECK (role <> 'land_controller' OR authority_basis IS NOT NULL),
    -- Keep the derived flag honest: only these two roles convey authority.
    CONSTRAINT land_roles_conveys_authority_check
        CHECK (conveys_authority_to_commit = (role IN ('landowner', 'land_controller')))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_land_roles_current_version
ON parties.land_roles(land_role_id) WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_land_roles_parcel ON parties.land_roles(parcel_id);
CREATE INDEX IF NOT EXISTS ix_land_roles_party ON parties.land_roles(party_id);

-- Only one *exclusive* holder of a given role per parcel at a time.
-- Non-exclusive claims may overlap deliberately, so a genuine tenure dispute
-- is recorded rather than silently decided at the point of capture
-- (open question 9 — nothing yet says who adjudicates).
CREATE UNIQUE INDEX IF NOT EXISTS uq_land_roles_exclusive_current
ON parties.land_roles(parcel_id, role)
WHERE exclusive AND superseded_at IS NULL AND valid_to IS NULL;

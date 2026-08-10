-- DRAFT — proposed, not approved, NOT APPLIED.
--
-- Applies after 0001_foundation.sql and 0002_parties.draft.sql.
-- Follows 0001's conventions: explicit constraint names, UUID keys supplied by
-- the application (UUIDv7, ADR-019), TIMESTAMPTZ throughout.

CREATE SCHEMA IF NOT EXISTS evidence;
-- forests already exists from 0001_foundation.sql.

-- ---------------------------------------------------------------------------
-- evidence.assets — immutable content-addressed originals (EVID-002/003/004)
--
-- Bytes live in object storage; this table records what exists, its digest and
-- whether the digest was verified. Nothing is ever deleted: 'withheld' hides an
-- asset from serving without destroying the record.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS evidence.assets (
    id UUID PRIMARY KEY,
    home_instance_id UUID NOT NULL
        CONSTRAINT assets_home_instance_id_instances_id_fk REFERENCES core.instances(id),
    checksum_sha256 TEXT NOT NULL
        CONSTRAINT assets_checksum_format_check CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
    media_type TEXT NOT NULL,
    byte_size BIGINT NOT NULL CONSTRAINT assets_byte_size_check CHECK (byte_size > 0),
    status TEXT NOT NULL
        CONSTRAINT assets_status_check
        CHECK (status IN ('pending_upload', 'verified', 'rejected', 'superseded', 'withheld')),
    storage_key TEXT NOT NULL,
    captured_at TIMESTAMPTZ,
    captured_by UUID NOT NULL,
    capture_location GEOGRAPHY(POINT, 4326),
    data_classification TEXT NOT NULL
        CONSTRAINT assets_data_classification_check
        CHECK (data_classification IN ('public','internal','confidential','restricted','cultural_restricted')),
    superseded_by_asset_id UUID
        CONSTRAINT assets_superseded_by_fk REFERENCES evidence.assets(id),
    recorded_at TIMESTAMPTZ NOT NULL,
    verified_at TIMESTAMPTZ,
    -- Content addressing: identical bytes are one asset within a tenant.
    CONSTRAINT uq_assets_tenant_checksum UNIQUE (home_instance_id, checksum_sha256),
    -- An asset cannot claim to be verified without recording when.
    CONSTRAINT assets_verified_at_check
        CHECK ((status = 'verified') = (verified_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS ix_assets_tenant ON evidence.assets(home_instance_id);

-- ---------------------------------------------------------------------------
-- forests.parcels — a piece of land (GEO-002)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS forests.parcels (
    id UUID PRIMARY KEY,
    home_instance_id UUID NOT NULL
        CONSTRAINT parcels_home_instance_id_instances_id_fk REFERENCES core.instances(id),
    project_id UUID NOT NULL
        CONSTRAINT parcels_project_id_projects_id_fk REFERENCES forests.projects(id),
    local_reference TEXT NOT NULL,
    status TEXT NOT NULL
        CONSTRAINT parcels_status_check
        CHECK (status IN ('draft', 'boundary_submitted', 'boundary_approved', 'withdrawn')),
    current_boundary_id UUID,  -- FK added after parcel_boundaries exists
    recorded_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_parcels_project_reference UNIQUE (project_id, local_reference),
    -- Approved land must name the boundary that is in force.
    CONSTRAINT parcels_approved_needs_boundary_check
        CHECK (status <> 'boundary_approved' OR current_boundary_id IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- forests.parcel_boundaries — append-only geometry versions (GEO-001, GEO-003)
--
-- Named in traceability.csv since Release 0 but never created. Geography rather
-- than geometry so ST_Area returns true square metres at tropical latitudes
-- without choosing a projection.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS forests.parcel_boundaries (
    id UUID PRIMARY KEY,
    home_instance_id UUID NOT NULL
        CONSTRAINT parcel_boundaries_home_instance_id_instances_id_fk REFERENCES core.instances(id),
    parcel_id UUID NOT NULL
        CONSTRAINT parcel_boundaries_parcel_id_parcels_id_fk REFERENCES forests.parcels(id),
    version INTEGER NOT NULL
        CONSTRAINT parcel_boundaries_version_check CHECK (version > 0),
    geom GEOGRAPHY(POLYGON, 4326) NOT NULL,
    survey_method TEXT NOT NULL
        CONSTRAINT parcel_boundaries_survey_method_check
        CHECK (survey_method IN ('gps_walk','satellite_trace','cadastral_record','participatory_mapping')),
    accuracy_metres DOUBLE PRECISION,
    supporting_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
    submitted_by UUID NOT NULL,
    submitted_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL
        CONSTRAINT parcel_boundaries_status_check
        CHECK (status IN ('submitted', 'approved', 'rejected', 'superseded')),
    approved_by UUID,
    approved_at TIMESTAMPTZ,
    rejection_reason TEXT,
    superseded_by_boundary_id UUID
        CONSTRAINT parcel_boundaries_superseded_by_fk REFERENCES forests.parcel_boundaries(id),
    recorded_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_parcel_boundaries_version UNIQUE (parcel_id, version),
    -- Approval must record who and when: dual control is unauditable otherwise.
    CONSTRAINT parcel_boundaries_approval_check
        CHECK ((status = 'approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
    CONSTRAINT parcel_boundaries_rejection_check
        CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ix_parcel_boundaries_geom ON forests.parcel_boundaries USING GIST (geom);
CREATE INDEX IF NOT EXISTS ix_parcel_boundaries_parcel ON forests.parcel_boundaries(parcel_id);

-- Only one approved boundary in force per parcel.
CREATE UNIQUE INDEX IF NOT EXISTS uq_parcel_boundaries_approved_current
ON forests.parcel_boundaries(parcel_id)
WHERE status = 'approved' AND superseded_by_boundary_id IS NULL;

ALTER TABLE forests.parcels
    ADD CONSTRAINT parcels_current_boundary_id_boundaries_id_fk
    FOREIGN KEY (current_boundary_id) REFERENCES forests.parcel_boundaries(id);

-- ---------------------------------------------------------------------------
-- forests.trees — durable identity (TREE-001, TREE-002, TREE-003)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS forests.trees (
    id UUID PRIMARY KEY,
    home_instance_id UUID NOT NULL
        CONSTRAINT trees_home_instance_id_instances_id_fk REFERENCES core.instances(id),
    parcel_id UUID NOT NULL
        CONSTRAINT trees_parcel_id_parcels_id_fk REFERENCES forests.parcels(id),
    physical_tag TEXT,
    vernacular_name TEXT NOT NULL,
    scientific_name TEXT,
    taxonomy_id TEXT,
    taxonomy_source TEXT,
    location GEOGRAPHY(POINT, 4326) NOT NULL,
    accuracy_metres DOUBLE PRECISION,
    location_precision_policy TEXT NOT NULL DEFAULT 'reduced_1km'
        CONSTRAINT trees_location_precision_check
        CHECK (location_precision_policy IN ('exact', 'reduced_1km', 'parcel_only')),
    caretaker_party_id UUID,
    registered_by UUID NOT NULL,
    registered_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'unverified'
        CONSTRAINT trees_status_check
        CHECK (status IN ('standing', 'fallen', 'removed', 'unverified')),
    sponsorable BOOLEAN NOT NULL DEFAULT FALSE,
    recorded_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_trees_location ON forests.trees USING GIST (location);
CREATE INDEX IF NOT EXISTS ix_trees_parcel ON forests.trees(parcel_id);
CREATE INDEX IF NOT EXISTS ix_trees_sponsorable ON forests.trees(parcel_id) WHERE sponsorable;

-- A physical tag, where used, must not be ambiguous within a parcel.
CREATE UNIQUE INDEX IF NOT EXISTS uq_trees_parcel_tag
ON forests.trees(parcel_id, physical_tag) WHERE physical_tag IS NOT NULL;

-- ---------------------------------------------------------------------------
-- forests.tree_observations — immutable condition series (TREE-002, TREE-004)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS forests.tree_observations (
    id UUID PRIMARY KEY,
    home_instance_id UUID NOT NULL
        CONSTRAINT tree_observations_home_instance_id_instances_id_fk REFERENCES core.instances(id),
    tree_id UUID NOT NULL
        CONSTRAINT tree_observations_tree_id_trees_id_fk REFERENCES forests.trees(id),
    observed_by UUID NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL,
    condition TEXT NOT NULL
        CONSTRAINT tree_observations_condition_check
        CHECK (condition IN ('healthy','stressed','diseased','damaged','fallen','removed')),
    height_metres DOUBLE PRECISION,
    diameter_breast_height_cm DOUBLE PRECISION,
    canopy_spread_metres DOUBLE PRECISION,
    note TEXT,
    evidence JSONB NOT NULL,
    superseded_by_observation_id UUID
        CONSTRAINT tree_observations_superseded_by_fk REFERENCES forests.tree_observations(id),
    recorded_at TIMESTAMPTZ NOT NULL,
    -- EVID-001 / TREE-004: an observation is a material claim and must cite
    -- evidence. Enforced by the database because a claim shown to a sponsor
    -- without a photograph behind it is the failure mode that matters most.
    CONSTRAINT tree_observations_evidence_required_check
        CHECK (jsonb_array_length(evidence) > 0),
    CONSTRAINT tree_observations_observed_before_recorded_check
        CHECK (observed_at <= recorded_at)
);

CREATE INDEX IF NOT EXISTS ix_tree_observations_tree_time
ON forests.tree_observations(tree_id, observed_at DESC);

-- ---------------------------------------------------------------------------
-- Resolve the deferred reference from the parties proposal: land roles point at
-- parcels, which could not be enforced until parcels existed.
-- ---------------------------------------------------------------------------
ALTER TABLE parties.land_roles
    ADD CONSTRAINT land_roles_parcel_id_parcels_id_fk
    FOREIGN KEY (parcel_id) REFERENCES forests.parcels(id);

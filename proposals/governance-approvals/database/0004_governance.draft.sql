-- DRAFT — proposed, not approved, NOT APPLIED.
--
-- Applies after 0001_foundation.sql, 0002_parties.draft.sql and
-- 0003_land_and_trees.draft.sql.
--
-- Defines what permissions.json already assumes: what dual_control means, who
-- may approve, and how an approval is recorded. Until this exists the platform
-- refuses every permission carrying an approvalPolicy.

CREATE SCHEMA IF NOT EXISTS governance;

-- ---------------------------------------------------------------------------
-- governance.staff_roles — an office held by a party for a period (GOV-001)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS governance.staff_roles (
    id UUID PRIMARY KEY,
    home_instance_id UUID NOT NULL
        CONSTRAINT staff_roles_home_instance_id_instances_id_fk REFERENCES core.instances(id),
    party_id UUID NOT NULL,
    role TEXT NOT NULL
        CONSTRAINT staff_roles_role_check
        CHECK (role IN ('forest_committee_chair', 'president', 'field_worker', 'administrator')),
    assigned_by UUID NOT NULL,
    valid_from TIMESTAMPTZ NOT NULL,
    valid_to TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    revocation_reason TEXT,
    recorded_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT staff_roles_valid_period_check CHECK (valid_to IS NULL OR valid_to > valid_from)
);

-- One person holds a given office at a time; an office may be held by one
-- person at a time. Both are enforced, because "the President" must be
-- unambiguous when an approval names the role.
CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_roles_current_holder
ON governance.staff_roles(home_instance_id, role)
WHERE revoked_at IS NULL AND valid_to IS NULL;

CREATE INDEX IF NOT EXISTS ix_staff_roles_party ON governance.staff_roles(party_id);

-- ---------------------------------------------------------------------------
-- governance.approval_policies — what dual_control means (GOV-002)
--
-- Data, not code: raising minimum_approvals when a third authorized person
-- exists is a row update, not a release.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS governance.approval_policies (
    policy_code TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    minimum_approvals INTEGER NOT NULL
        CONSTRAINT approval_policies_minimum_approvals_check CHECK (minimum_approvals >= 1),
    requester_may_approve BOOLEAN NOT NULL DEFAULT FALSE,
    eligible_approver_roles JSONB NOT NULL,
    default_expiry_days INTEGER NOT NULL DEFAULT 30
        CONSTRAINT approval_policies_expiry_check CHECK (default_expiry_days > 0),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- dual_control as the first user group operates it: the Forest Committee Chair
-- submits, the President approves. Two distinct people, one eligible approver
-- role. See open question 1 — if the President ever submits, nothing can
-- approve it.
INSERT INTO governance.approval_policies
  (policy_code, description, minimum_approvals, requester_may_approve, eligible_approver_roles)
VALUES
  ('dual_control',
   'Submitter plus one approver. The Forest Committee Chair submits; the President approves.',
   1, FALSE, '["president"]'::jsonb),
  ('ai_release_review',
   'Undefined: nobody has said who reviews an AI release. Left with no eligible approver roles so it continues to refuse rather than silently permitting.',
   1, FALSE, '[]'::jsonb)
ON CONFLICT (policy_code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- governance.approval_requests — something awaiting a decision (GOV-004)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS governance.approval_requests (
    id UUID PRIMARY KEY,
    home_instance_id UUID NOT NULL
        CONSTRAINT approval_requests_home_instance_id_instances_id_fk REFERENCES core.instances(id),
    permission_code TEXT NOT NULL,
    policy_code TEXT NOT NULL
        CONSTRAINT approval_requests_policy_code_fk
        REFERENCES governance.approval_policies(policy_code),
    resource_type TEXT NOT NULL,
    -- GOV-004: the exact immutable version, never just the parent resource.
    -- Approving "the parcel" would let a submitter swap the boundary afterwards.
    resource_version_id UUID NOT NULL,
    requested_by UUID NOT NULL,
    requested_at TIMESTAMPTZ NOT NULL,
    justification TEXT,
    state TEXT NOT NULL DEFAULT 'pending'
        CONSTRAINT approval_requests_state_check
        CHECK (state IN ('pending', 'granted', 'rejected', 'expired', 'superseded')),
    expires_at TIMESTAMPTZ NOT NULL,
    decided_at TIMESTAMPTZ,
    recorded_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT approval_requests_expiry_after_request_check CHECK (expires_at > requested_at),
    CONSTRAINT approval_requests_decided_check
        CHECK ((state IN ('granted','rejected')) = (decided_at IS NOT NULL))
);

-- At most one live request per resource version, so two pending approvals for
-- the same thing cannot race to completion.
CREATE UNIQUE INDEX IF NOT EXISTS uq_approval_requests_open
ON governance.approval_requests(resource_type, resource_version_id)
WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS ix_approval_requests_pending
ON governance.approval_requests(home_instance_id, state) WHERE state = 'pending';

-- ---------------------------------------------------------------------------
-- governance.approval_decisions — append-only (GOV-003, GOV-005)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS governance.approval_decisions (
    id UUID PRIMARY KEY,
    home_instance_id UUID NOT NULL
        CONSTRAINT approval_decisions_home_instance_id_instances_id_fk REFERENCES core.instances(id),
    approval_request_id UUID NOT NULL
        CONSTRAINT approval_decisions_request_fk REFERENCES governance.approval_requests(id),
    decided_by UUID NOT NULL,
    -- The office held at the moment of decision. Denormalized on purpose: if
    -- the President changes next year, the history of this decision must not
    -- change with it.
    role_held TEXT NOT NULL
        CONSTRAINT approval_decisions_role_held_check
        CHECK (role_held IN ('forest_committee_chair', 'president', 'field_worker', 'administrator')),
    decision TEXT NOT NULL
        CONSTRAINT approval_decisions_decision_check CHECK (decision IN ('approve', 'reject')),
    reason TEXT,
    assurance_level TEXT NOT NULL
        CONSTRAINT approval_decisions_assurance_check
        CHECK (assurance_level IN ('aal1', 'aal2', 'aal3')),
    decided_at TIMESTAMPTZ NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT approval_decisions_rejection_reason_check
        CHECK (decision <> 'reject' OR reason IS NOT NULL)
);

-- One decision per person per request. Append-only: reconsideration supersedes
-- the request and raises a new one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_approval_decisions_one_per_approver
ON governance.approval_decisions(approval_request_id, decided_by);

CREATE INDEX IF NOT EXISTS ix_approval_decisions_request
ON governance.approval_decisions(approval_request_id);

-- ---------------------------------------------------------------------------
-- GOV-003: separation of duties, enforced in the database.
--
-- A CHECK cannot see another table, so this is a trigger. It is deliberately
-- not left to application code: an approval control that lives only in a
-- service layer is one refactor away from being lost.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION governance.enforce_separation_of_duties()
RETURNS TRIGGER AS $$
DECLARE
  v_requested_by UUID;
  v_policy TEXT;
  v_requester_may_approve BOOLEAN;
  v_eligible JSONB;
BEGIN
  SELECT r.requested_by, r.policy_code INTO v_requested_by, v_policy
    FROM governance.approval_requests r WHERE r.id = NEW.approval_request_id;

  SELECT p.requester_may_approve, p.eligible_approver_roles
    INTO v_requester_may_approve, v_eligible
    FROM governance.approval_policies p WHERE p.policy_code = v_policy;

  IF NEW.decided_by = v_requested_by AND NOT v_requester_may_approve THEN
    RAISE EXCEPTION 'APPROVAL_SELF_NOT_PERMITTED: requester % may not decide their own request',
      NEW.decided_by USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.decision = 'approve' AND NOT (v_eligible ? NEW.role_held) THEN
    RAISE EXCEPTION 'APPROVAL_ROLE_NOT_AUTHORIZED: role % is not eligible to approve under policy %',
      NEW.role_held, v_policy USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_approval_decisions_separation
BEFORE INSERT ON governance.approval_decisions
FOR EACH ROW EXECUTE FUNCTION governance.enforce_separation_of_duties();

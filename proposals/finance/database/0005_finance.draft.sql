-- DRAFT — proposed, not approved, NOT APPLIED.
--
-- Applies after 0001_foundation.sql and drafts 0002 parties, 0003 land and
-- trees, 0004 governance.
--
-- FIN-001 approves an append-only double-entry ledger; ADR-027 approves integer
-- money with explicit FX. Neither has any table. This supplies them, plus the
-- sponsorship, payment and payout flows around them.

CREATE SCHEMA IF NOT EXISTS finance;

-- ---------------------------------------------------------------------------
-- finance.accounts — the chart of accounts (FIN-001)
--
-- normal_balance records whether an account increases by debit or credit. It is
-- stored rather than inferred so a report can never disagree with the ledger
-- about which direction is "more".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS finance.accounts (
    id UUID PRIMARY KEY,
    home_instance_id UUID NOT NULL
        CONSTRAINT accounts_home_instance_id_instances_id_fk REFERENCES core.instances(id),
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    account_type TEXT NOT NULL
        CONSTRAINT accounts_type_check
        CHECK (account_type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
    normal_balance TEXT NOT NULL
        CONSTRAINT accounts_normal_balance_check CHECK (normal_balance IN ('debit', 'credit')),
    currency CHAR(3) NOT NULL
        CONSTRAINT accounts_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
    -- An account may belong to a party (a payee's obligation account) or be
    -- organizational (a bank or revenue account).
    party_id UUID,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    recorded_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_accounts_tenant_code UNIQUE (home_instance_id, code),
    -- Assets and expenses normally carry debit balances; the rest credit.
    CONSTRAINT accounts_normal_balance_matches_type_check CHECK (
        (account_type IN ('asset', 'expense') AND normal_balance = 'debit')
     OR (account_type IN ('liability', 'equity', 'revenue') AND normal_balance = 'credit')
    )
);

-- ---------------------------------------------------------------------------
-- finance.transactions — a balanced set of entries (FIN-002)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS finance.transactions (
    id UUID PRIMARY KEY,
    home_instance_id UUID NOT NULL
        CONSTRAINT transactions_home_instance_id_instances_id_fk REFERENCES core.instances(id),
    transaction_type TEXT NOT NULL
        CONSTRAINT transactions_type_check
        CHECK (transaction_type IN ('sponsorship_payment','payout','refund','chargeback','fee','adjustment','fx_conversion')),
    description TEXT NOT NULL,
    -- What in the outside world this records. Free-form because the referenced
    -- table varies (payment, payout_batch, sponsorship).
    source_reference_type TEXT,
    source_reference_id UUID,
    -- FIN-003: a correction references what it reverses; the original stands.
    reverses_transaction_id UUID
        CONSTRAINT transactions_reverses_fk REFERENCES finance.transactions(id),
    -- FIN-005: an FX conversion must be reproducible.
    fx_rate NUMERIC(20, 10),
    fx_rate_source TEXT,
    fx_rate_at TIMESTAMPTZ,
    posted_by UUID NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT transactions_fx_complete_check CHECK (
        (fx_rate IS NULL AND fx_rate_source IS NULL AND fx_rate_at IS NULL)
     OR (fx_rate IS NOT NULL AND fx_rate_source IS NOT NULL AND fx_rate_at IS NOT NULL)
    ),
    CONSTRAINT transactions_fx_rate_positive_check CHECK (fx_rate IS NULL OR fx_rate > 0)
);

CREATE INDEX IF NOT EXISTS ix_transactions_source
ON finance.transactions(source_reference_type, source_reference_id);

-- ---------------------------------------------------------------------------
-- finance.entries — the lines (FIN-001, FIN-004)
--
-- ADR-027: integer minor units, never floating point. A signed BIGINT with the
-- sign carrying debit/credit keeps the balance check a plain SUM = 0.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS finance.entries (
    id UUID PRIMARY KEY,
    home_instance_id UUID NOT NULL
        CONSTRAINT entries_home_instance_id_instances_id_fk REFERENCES core.instances(id),
    transaction_id UUID NOT NULL
        CONSTRAINT entries_transaction_id_fk REFERENCES finance.transactions(id),
    account_id UUID NOT NULL
        CONSTRAINT entries_account_id_fk REFERENCES finance.accounts(id),
    -- Positive is a debit, negative a credit.
    amount_minor_units BIGINT NOT NULL
        CONSTRAINT entries_amount_nonzero_check CHECK (amount_minor_units <> 0),
    currency CHAR(3) NOT NULL
        CONSTRAINT entries_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
    memo TEXT,
    recorded_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_entries_transaction ON finance.entries(transaction_id);
CREATE INDEX IF NOT EXISTS ix_entries_account ON finance.entries(account_id);

-- FIN-002: every transaction must balance to zero per currency.
-- DEFERRABLE so entries can be inserted one at a time inside a transaction and
-- checked at COMMIT. This is the constraint that makes the already-approved
-- LEDGER_TRANSACTION_UNBALANCED error reachable.
CREATE OR REPLACE FUNCTION finance.assert_transaction_balanced()
RETURNS TRIGGER AS $$
DECLARE
  v_currency CHAR(3);
  v_sum BIGINT;
  v_txn UUID := COALESCE(NEW.transaction_id, OLD.transaction_id);
BEGIN
  FOR v_currency, v_sum IN
    SELECT currency, SUM(amount_minor_units)
      FROM finance.entries WHERE transaction_id = v_txn GROUP BY currency
  LOOP
    IF v_sum <> 0 THEN
      RAISE EXCEPTION
        'LEDGER_TRANSACTION_UNBALANCED: transaction % does not balance in % (sum %)',
        v_txn, v_currency, v_sum USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_entries_balanced
AFTER INSERT OR UPDATE OR DELETE ON finance.entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION finance.assert_transaction_balanced();

-- FIN-003: posted entries are immutable. Enforced here rather than only in the
-- service layer, because an append-only guarantee that depends on application
-- discipline is not a guarantee.
CREATE OR REPLACE FUNCTION finance.forbid_entry_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'LEDGER_ENTRY_IMMUTABLE: posted entries cannot be % — post a reversing transaction instead',
    lower(TG_OP) USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_entries_no_update
BEFORE UPDATE ON finance.entries
FOR EACH ROW EXECUTE FUNCTION finance.forbid_entry_mutation();

CREATE TRIGGER trg_entries_no_delete
BEFORE DELETE ON finance.entries
FOR EACH ROW EXECUTE FUNCTION finance.forbid_entry_mutation();

-- ---------------------------------------------------------------------------
-- finance.payee_accounts — who may receive money (FIN-008)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS finance.payee_accounts (
    id UUID PRIMARY KEY,
    home_instance_id UUID NOT NULL
        CONSTRAINT payee_accounts_home_instance_id_instances_id_fk REFERENCES core.instances(id),
    party_id UUID NOT NULL,
    -- The provider's identifier for the onboarded business. Bank details live
    -- with the provider and are deliberately NOT stored here.
    provider TEXT NOT NULL,
    provider_account_ref TEXT NOT NULL,
    verification_status TEXT NOT NULL DEFAULT 'pending'
        CONSTRAINT payee_accounts_verification_check
        CHECK (verification_status IN ('pending', 'verified', 'rejected', 'suspended')),
    verified_at TIMESTAMPTZ,
    payout_currency CHAR(3) NOT NULL
        CONSTRAINT payee_accounts_currency_check CHECK (payout_currency ~ '^[A-Z]{3}$'),
    onboarded_by UUID NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_payee_accounts_provider_ref UNIQUE (provider, provider_account_ref),
    CONSTRAINT payee_accounts_verified_at_check
        CHECK ((verification_status = 'verified') = (verified_at IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- finance.sponsorships — a commitment with a reporting obligation (SPON-001)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS finance.sponsorships (
    id UUID PRIMARY KEY,
    home_instance_id UUID NOT NULL
        CONSTRAINT sponsorships_home_instance_id_instances_id_fk REFERENCES core.instances(id),
    tree_id UUID NOT NULL
        CONSTRAINT sponsorships_tree_id_trees_id_fk REFERENCES forests.trees(id),
    sponsor_party_id UUID,
    sponsor_display_name TEXT,
    sponsor_email TEXT,
    amount_minor_units BIGINT NOT NULL
        CONSTRAINT sponsorships_amount_positive_check CHECK (amount_minor_units > 0),
    currency CHAR(3) NOT NULL
        CONSTRAINT sponsorships_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
    term_start DATE NOT NULL,
    term_end DATE NOT NULL,
    -- SPON-001: how often the platform promises to report on the tree. No
    -- default: this is a policy decision with legal weight (open question 3).
    reporting_interval_days INTEGER
        CONSTRAINT sponsorships_reporting_interval_check
        CHECK (reporting_interval_days IS NULL OR reporting_interval_days > 0),
    status TEXT NOT NULL DEFAULT 'pending_payment'
        CONSTRAINT sponsorships_status_check
        CHECK (status IN ('pending_payment','active','lapsed','refunded','cancelled')),
    is_donation BOOLEAN NOT NULL DEFAULT FALSE,
    recorded_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT sponsorships_term_check CHECK (term_end > term_start),
    -- A sponsorship is only active once money has actually arrived. A CHECK
    -- cannot see another table, so this is a trigger below.
    CONSTRAINT sponsorships_email_present_check
        CHECK (is_donation OR sponsor_email IS NOT NULL)
);

-- SPON-001 / SPON-003: a sponsorship may only be active while a succeeded,
-- un-refunded payment exists for it. This is what stops a sponsor keeping a
-- tree they did not pay for, and what makes public sponsorship counts true.
CREATE OR REPLACE FUNCTION finance.assert_sponsorship_funded()
RETURNS TRIGGER AS $$
DECLARE
  v_paid BIGINT;
BEGIN
  IF NEW.status <> 'active' THEN
    RETURN NEW;
  END IF;
  SELECT COUNT(*) INTO v_paid FROM finance.payments
   WHERE sponsorship_id = NEW.id AND status = 'succeeded';
  IF v_paid = 0 THEN
    RAISE EXCEPTION
      'SPONSORSHIP_NOT_FUNDED: sponsorship % cannot be active without a succeeded payment',
      NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_sponsorships_funded
AFTER INSERT OR UPDATE ON finance.sponsorships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION finance.assert_sponsorship_funded();

CREATE INDEX IF NOT EXISTS ix_sponsorships_tree ON finance.sponsorships(tree_id);
CREATE INDEX IF NOT EXISTS ix_sponsorships_status ON finance.sponsorships(home_instance_id, status);

-- One active sponsorship per tree at a time. Open question: whether a tree may
-- have several sponsors is policy, not technology — relax this if it may.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sponsorships_active_tree
ON finance.sponsorships(tree_id) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- finance.payments — money in, as reported by the provider (FIN-006)
--
-- No card data. Not a masked PAN, not a BIN, not an expiry. Only the provider's
-- reference and what it tells us about the outcome.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS finance.payments (
    id UUID PRIMARY KEY,
    home_instance_id UUID NOT NULL
        CONSTRAINT payments_home_instance_id_instances_id_fk REFERENCES core.instances(id),
    sponsorship_id UUID
        CONSTRAINT payments_sponsorship_id_fk REFERENCES finance.sponsorships(id),
    provider TEXT NOT NULL,
    provider_payment_ref TEXT NOT NULL,
    amount_minor_units BIGINT NOT NULL
        CONSTRAINT payments_amount_positive_check CHECK (amount_minor_units > 0),
    currency CHAR(3) NOT NULL
        CONSTRAINT payments_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
    fee_minor_units BIGINT NOT NULL DEFAULT 0
        CONSTRAINT payments_fee_nonnegative_check CHECK (fee_minor_units >= 0),
    status TEXT NOT NULL
        CONSTRAINT payments_status_check
        CHECK (status IN ('pending','succeeded','failed','refunded','charged_back')),
    ledger_transaction_id UUID
        CONSTRAINT payments_ledger_transaction_fk REFERENCES finance.transactions(id),
    received_at TIMESTAMPTZ,
    recorded_at TIMESTAMPTZ NOT NULL,
    -- Provider webhooks retry; the same payment must never post twice.
    CONSTRAINT uq_payments_provider_ref UNIQUE (provider, provider_payment_ref)
);

CREATE INDEX IF NOT EXISTS ix_payments_sponsorship ON finance.payments(sponsorship_id);

-- ---------------------------------------------------------------------------
-- finance.payout_batches — money out (FIN-007)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS finance.payout_batches (
    id UUID PRIMARY KEY,
    home_instance_id UUID NOT NULL
        CONSTRAINT payout_batches_home_instance_id_instances_id_fk REFERENCES core.instances(id),
    payee_account_id UUID NOT NULL
        CONSTRAINT payout_batches_payee_account_fk REFERENCES finance.payee_accounts(id),
    total_minor_units BIGINT NOT NULL
        CONSTRAINT payout_batches_total_positive_check CHECK (total_minor_units > 0),
    currency CHAR(3) NOT NULL
        CONSTRAINT payout_batches_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
    -- FIN-007: binds to the exact approval, which itself binds to this batch id.
    approval_request_id UUID,
    status TEXT NOT NULL DEFAULT 'proposed'
        CONSTRAINT payout_batches_status_check
        CHECK (status IN ('proposed','approved','executing','paid','failed','cancelled')),
    -- A fingerprint of the batch lines at approval time. If the lines change
    -- afterwards the digest no longer matches and execution is refused: the
    -- approve-then-swap attack applied to money.
    approved_content_digest TEXT,
    proposed_by UUID NOT NULL,
    executed_by UUID,
    provider_payout_ref TEXT,
    ledger_transaction_id UUID
        CONSTRAINT payout_batches_ledger_transaction_fk REFERENCES finance.transactions(id),
    proposed_at TIMESTAMPTZ NOT NULL,
    executed_at TIMESTAMPTZ,
    recorded_at TIMESTAMPTZ NOT NULL,
    -- Money never moves without a granted approval recorded against the batch.
    CONSTRAINT payout_batches_approval_required_check
        CHECK (status IN ('proposed','cancelled') OR approval_request_id IS NOT NULL),
    CONSTRAINT payout_batches_digest_on_approval_check
        CHECK (status IN ('proposed','cancelled') OR approved_content_digest IS NOT NULL),
    CONSTRAINT payout_batches_executed_check
        CHECK ((status IN ('paid','failed')) = (executed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS ix_payout_batches_status
ON finance.payout_batches(home_instance_id, status);

-- ---------------------------------------------------------------------------
-- finance.payout_lines — what a batch is made of
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS finance.payout_lines (
    id UUID PRIMARY KEY,
    payout_batch_id UUID NOT NULL
        CONSTRAINT payout_lines_batch_fk REFERENCES finance.payout_batches(id),
    sponsorship_id UUID
        CONSTRAINT payout_lines_sponsorship_fk REFERENCES finance.sponsorships(id),
    amount_minor_units BIGINT NOT NULL
        CONSTRAINT payout_lines_amount_positive_check CHECK (amount_minor_units > 0),
    currency CHAR(3) NOT NULL
        CONSTRAINT payout_lines_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
    description TEXT NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_payout_lines_batch ON finance.payout_lines(payout_batch_id);

-- Lines may not be added to or removed from a batch once it leaves 'proposed'.
CREATE OR REPLACE FUNCTION finance.forbid_line_change_after_approval()
RETURNS TRIGGER AS $$
DECLARE
  v_status TEXT;
  v_batch UUID := COALESCE(NEW.payout_batch_id, OLD.payout_batch_id);
BEGIN
  SELECT status INTO v_status FROM finance.payout_batches WHERE id = v_batch;
  IF v_status IS NOT NULL AND v_status NOT IN ('proposed') THEN
    RAISE EXCEPTION
      'PAYOUT_BATCH_MODIFIED_AFTER_APPROVAL: batch % is % and its lines are fixed',
      v_batch, v_status USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_payout_lines_frozen
BEFORE INSERT OR UPDATE OR DELETE ON finance.payout_lines
FOR EACH ROW EXECUTE FUNCTION finance.forbid_line_change_after_approval();

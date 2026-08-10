# Proposal: ledger, sponsorship, payments in and payouts out

**Status: DRAFT — not approved, not implemented.**

Depends on [parties-and-land-roles](../parties-and-land-roles/),
[land-and-trees](../land-and-trees/) and
[governance-approvals](../governance-approvals/). Payouts cannot work without
the last of these, because `finance.payout.approve` is already approved as
`dual_control`.

## Read this part first

**I can build the software. I cannot make you compliant.**

Taking card payments and sending money to a company are regulated activities.
This proposal is designed so a licensed payment provider carries as much of that
burden as possible, but the following remain yours and your lawyer's:

- **Charitable / fundraising registration** in each jurisdiction you solicit from
- **Tax receipts** and their content and timing
- **KYB onboarding** of the landowning company before it can be paid
- **Sanctions screening** of payees
- **Money transmission** — if funds ever rest in an account you control, you may
  be transmitting money and may need a licence. The design below is arranged
  specifically to avoid that.

Nothing here should be taken as legal advice.

## The three flows

**1. Money in.** A sponsor pays by card through a **hosted checkout** — Stripe
Checkout or equivalent. Card details never touch your servers or this codebase,
which keeps you in the smallest PCI scope (SAQ A). The platform stores a
reference to the payment, never a card number.

**2. The ledger.** Every movement is recorded as balanced double-entry lines
(FIN-001). Nothing is deleted; a mistake is corrected by a reversing entry. This
is what lets you answer "where did this sponsor's money go" years later, and it
is the only defensible basis for the claims you will make to sponsors.

**3. Money out.** A payout batch to the landowning company is proposed by the
Chair, approved by the President under `dual_control`, and executed by the
provider. Funds move provider-to-payee; the platform records and authorizes but
never holds custody.

## Why "sponsorship" and not "donation"

They are different things legally and I have kept them separate:

- A **donation** is a gift. It may be tax-deductible. Nothing is owed in return.
- A **sponsorship** promises something — that a specific tree is cared for and
  reported on. That is a material claim under EVID-001, and a promise you can
  fail to keep.

The draft models sponsorship as a commitment with a term, an amount, and an
obligation to report. If sponsors are told "your tree" they must actually get
observations of that tree, or the claim is unfounded. This is the single most
likely place for this platform to mislead people, so the contract makes the
obligation explicit rather than implied.

## What this proposes

| Artifact | File |
| --- | --- |
| Requirements | [`requirements.draft.json`](./requirements.draft.json) |
| Permissions | [`permissions.draft.json`](./permissions.draft.json) |
| Error codes | [`errors.draft.json`](./errors.draft.json) |
| Ledger account | [`schemas/ledger-account.draft.schema.json`](./schemas/ledger-account.draft.schema.json) |
| Ledger transaction | [`schemas/ledger-transaction.draft.schema.json`](./schemas/ledger-transaction.draft.schema.json) |
| Sponsorship | [`schemas/sponsorship.draft.schema.json`](./schemas/sponsorship.draft.schema.json) |
| Payment | [`schemas/payment.draft.schema.json`](./schemas/payment.draft.schema.json) |
| Payout batch | [`schemas/payout-batch.draft.schema.json`](./schemas/payout-batch.draft.schema.json) |
| Payee account | [`schemas/payee-account.draft.schema.json`](./schemas/payee-account.draft.schema.json) |
| Domain events | [`events/`](./events/) |
| API operations | [`openapi/finance.draft.yaml`](./openapi/finance.draft.yaml) |
| Migration | [`database/0005_finance.draft.sql`](./database/0005_finance.draft.sql) |
| Traceability | [`traceability.draft.csv`](./traceability.draft.csv) |

## Decisions taken, and why

**Money is integer minor units with an explicit currency (ADR-027).** No
floating point anywhere. The approved `money.schema.json` is reused unchanged.

**Every transaction must balance, enforced by the database.** A deferred
constraint trigger rejects any transaction whose lines do not sum to zero per
currency. The approved `LEDGER_TRANSACTION_UNBALANCED` error finally becomes
reachable. An unbalanced ledger is not a reporting inconvenience; it means you
cannot say where the money is.

**Entries are append-only.** No `UPDATE`, no `DELETE` — enforced by trigger.
Corrections are reversing entries that reference what they reverse.

**FX is explicit and recorded (ADR-027).** Sponsors likely pay in USD or EUR;
farmers are likely paid in BRL. The rate used, its source and its timestamp are
stored on the transaction. A conversion whose rate cannot be reproduced is not
auditable.

**Custody is avoided by design.** The provider holds funds and pays out
directly. The platform's ledger tracks obligations, not a balance you control.
This is the difference between recordkeeping and money transmission.

**A payout cannot be executed without a granted approval.** The payout batch
references the `approval_request_id`, and a database constraint refuses
execution without it. This is the same approve-then-swap protection used for
boundaries: approval binds to the exact batch, so lines cannot be added
afterwards.

**Payees must be onboarded before payment.** A `payee_account` records the
provider's KYB verification status. Paying an unverified payee is refused.

**Refunds and chargebacks are first-class.** They will happen. A refund is a
reversing transaction, and a sponsorship whose payment is refunded or charged
back must lose its active status — otherwise a sponsor keeps a tree they did
not pay for.

## Open questions — these need a human

**1. Which payment provider, and is Connect-style payout available where you
operate?** The draft assumes a provider that both takes cards and pays out to
onboarded businesses. Availability for Brazilian payees is a real constraint and
should be confirmed before anyone builds against this.

**2. Are you taking donations, sponsorships, or both?** They have different tax
treatment and different promises. The draft supports both and keeps them
distinct, but your charitable status may make one preferable.

**3. What exactly is promised to a sponsor?** "Your tree is protected for a
year" is a claim requiring evidence. How often must an observation occur for the
promise to hold? The draft has `reporting_interval_days` with no default,
because this is a policy decision with legal weight.

**4. What happens to a sponsorship when the tree falls?** Trees die naturally.
Does the sponsor get a refund, a replacement tree, or an honest notification?
The draft records the event and leaves the remedy unspecified. Sponsors should
be told the answer before they pay, not after.

**5. How is the money actually split?** What proportion reaches the landowning
company versus overheads? Sponsors increasingly expect this disclosed. The
ledger can express any split; nobody has said what it is.

**6. Who is the payee — the landowning company, or the caretaker?** You
described paying the company that owns the land. The person tending the trees
may be a different party with a different economic interest. Both can be payees
in this model, but the intended arrangement should be explicit.

**7. Recurring sponsorships?** Monthly giving changes cancellation, dunning and
receipting substantially. The draft models a fixed-term commitment and does not
handle subscriptions.

**8. In which currency is a sponsorship priced?** If priced in USD and paid out
in BRL, someone bears the FX risk between commitment and payout. The draft
records the rate but does not say who absorbs the movement.

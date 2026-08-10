# Proposal: staff roles and approval records

**Status: DRAFT — not approved, not implemented.**

Depends on [parties-and-land-roles](../parties-and-land-roles/) for the party
record an approver is.

## Why

`permissions.json` marks three permissions with an `approvalPolicy`:

| Permission | Policy |
| --- | --- |
| `parcel.approve_boundary` | `dual_control` |
| `finance.payout.approve` | `dual_control` |
| `ai.agent.publish` | `ai_release_review` |

Nothing in Release 0 says what those policies mean, how an approval is
recorded, or who may give one. The platform therefore refuses **every**
permission carrying an approval policy outright — which is why land cannot be
approved and payouts cannot be released. This proposal is the smallest thing
that unblocks all three.

## The staff roles

For the first user group, two staff hold approving authority:

- **Forest Committee Chair**
- **President**

Both are modeled as staff roles held by a party within a tenant, with a validity
period. Roles are assignable and revocable; approvals record which role the
approver held **at the moment they decided**, so a later change of office never
rewrites the history of a decision.

`field_worker` and `administrator` are included as non-approving roles, since
somebody has to submit the work being approved.

## What `dual_control` means here

**The Forest Committee Chair submits. The President approves.**

Two distinct people always act, and the submitter can never approve their own
work. The roles are not interchangeable: `president` is the only role eligible
to approve, and the Chair's authority is to raise the request.

This is the four-eyes principle, and it is the strictest form achievable with
two people. Requiring two approvals *in addition to* the submitter would be
unsatisfiable with only one eligible approver.

The policy is data, not code (`governance.approval_policies`), so both the
eligible roles and the required approval count can be changed without touching
the application. When a third authorized person exists, raise
`minimum_approvals` to 2. That is the intended upgrade path.

### The gap this leaves — worth deciding now

**If the President submits something, nothing can approve it.** They are the
only eligible approver and cannot approve their own request, so the request
would sit until it expires.

Three ways to handle it, and this draft takes the first:

1. **Operational rule: the Chair always submits.** No software change. Works
   as long as the President never needs to originate an approvable action —
   which, for boundary approval, is realistic.
2. **Add the Chair as a fallback approver** for requests the President raised.
   Expressible as a second policy, and it keeps two-person control intact.
3. **Add a third authorized person.** The most robust, and it also removes the
   single point of failure in open question 1.

Option 1 is assumed here because it matches what you described. If the
President will ever submit boundaries or payouts, say so and I will add
option 2 — it is a data change, not a redesign.

`ai_release_review` is defined with the same machinery but is left with no
eligible roles assigned, because nobody has said who reviews an AI release. It
will keep refusing until someone does — deliberately.

## What this proposes

| Artifact | File |
| --- | --- |
| Requirements | [`requirements.draft.json`](./requirements.draft.json) |
| Permissions | [`permissions.draft.json`](./permissions.draft.json) |
| Error codes | [`errors.draft.json`](./errors.draft.json) |
| Staff role | [`schemas/staff-role.draft.schema.json`](./schemas/staff-role.draft.schema.json) |
| Approval policy | [`schemas/approval-policy.draft.schema.json`](./schemas/approval-policy.draft.schema.json) |
| Approval request | [`schemas/approval-request.draft.schema.json`](./schemas/approval-request.draft.schema.json) |
| Approval decision | [`schemas/approval-decision.draft.schema.json`](./schemas/approval-decision.draft.schema.json) |
| Domain events | [`events/`](./events/) |
| API operations | [`openapi/approvals.draft.yaml`](./openapi/approvals.draft.yaml) |
| Migration | [`database/0004_governance.draft.sql`](./database/0004_governance.draft.sql) |
| Traceability | [`traceability.draft.csv`](./traceability.draft.csv) |

## Decisions taken, and why

**Separation of duties is enforced by the database, not only by code.** A
`CHECK` prevents a decision row whose approver is the requester, and a unique
index prevents the same person deciding twice on one request. An approval
control that lives only in application logic is one refactor away from being
lost.

**Decisions are append-only.** A decision is never updated. Changing your mind
means the request is superseded and a new one raised, so an audit can always
answer who approved what, when, and in what capacity.

**Approvals name the exact resource version.** A boundary approval references
the `boundary_id`, not just the parcel. Approving "the parcel" would let someone
submit a new boundary after approval and inherit it — the classic
approve-then-swap attack.

**Requests expire.** An approval left pending for months is stale consent;
`expires_at` is required, defaulting to 30 days.

**Approving requires `aal3` where the permission demands it.** The existing
`parcel.approve_boundary` already carries `stepUpAuthentication: aal3`, and this
proposal does not weaken it. Note this means your Chair and President need
phishing-resistant authentication — a security key or equivalent — before
boundary approval can work at all. That is an operational prerequisite, not a
software one.

## Open questions — these need a human

**1. What happens when an approver is unavailable?** With two eligible people,
one being on leave stops all approvals. There is no delegation or break-glass
path in this draft. Adding one weakens the control; not adding one risks work
stalling. Which do you prefer?

**2. Should the President be the sole approver for money as well as land?**
Settled for boundaries: Chair submits, President approves. Financial approval
often demands a different separation from operational approval, and payouts may
warrant an additional approver. The draft currently applies the same policy to
both.

**3. Should approval of a payout require different roles than land?** Both are
`dual_control` today. Financial approval frequently demands a different
separation from operational approval.

**4. Who assigns staff roles?** The draft requires `staff_role.assign`, which is
itself `critical`. Somebody must hold it initially, and that first assignment
cannot itself be dual-controlled — the bootstrap problem. The draft assumes a
tenant administrator seeded at installation. That seeding step needs a
documented, audited procedure.

**5. Does `ai_release_review` need different machinery?** It is defined here for
completeness but left with no eligible roles. If AI release review needs
qualitative sign-off rather than counting approvals, it may not fit this model.

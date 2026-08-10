# Proposals

Draft specification artifacts awaiting human review and approval.

**Nothing in this directory is authoritative.** The running platform reads only
`docs/forest_platform_machine_readable_release0/forest_platform_release0/`, and
it will keep refusing the operations described here with
`SPECIFICATION_CONTRACT_MISSING` (409) until an approved contract exists in that
package.

These drafts were written by a coding agent. DEV-AI-001 forbids agents from
inventing missing contracts, which is why they live here rather than in the
approved package: a proposal put in front of an architect is not the same thing
as a contract an agent granted itself. Nothing here is self-approved, and no
code has been built against any of it.

## Status

| Proposal | Covers | Status |
| --- | --- | --- |
| [parties-and-land-roles](./parties-and-land-roles/) | Farmer, landowner and land controller records; land roles; consent; enrollment | **Draft — needs review** |
| [land-and-trees](./land-and-trees/) | Evidence assets, parcels, boundaries, trees and observation history | **Draft — needs review** |
| [governance-approvals](./governance-approvals/) | Staff roles, approval policies and dual-control approval records | **Draft — needs review** |
| [finance](./finance/) | Double-entry ledger, sponsorship, card payments in, approved payouts out | **Draft — needs review + legal input** |

Migrations are numbered to apply in order after the approved
`0001_foundation.sql`: `0002` parties, `0003` land and trees, `0004`
governance, `0005` finance. All five have been applied together to a scratch
PostGIS database and their constraints exercised; none has been applied to a
real one.

The finance proposal carries obligations that are not engineering decisions —
fundraising registration, tax receipts, payee KYB, sanctions screening and
money transmission. Read its README before approving anything in it.

## How to review

1. Read the proposal's own `README.md` first. The **Open questions** section is
   the point — those are decisions an agent should not be making, and several
   change the schema depending on the answer.
2. Check the draft artifacts against the patterns in the approved package
   (identifiers, bitemporality, event envelope, permission shape).
3. Amend whatever is wrong. These are starting points, not recommendations to
   be rubber-stamped.

## How to approve

1. Move the artifacts into the approved package, dropping `.draft` from the
   filenames.
2. Merge the registry entries into the real `requirements.json`,
   `permissions.json` and `errors.json`, changing `"status": "proposed"` to
   `"status": "approved"`.
3. Add the traceability rows to `requirements/traceability.csv`.
4. Regenerate `manifest.json` checksums.
5. Run `python scripts/validate_specifications.py`.
6. Only then implement. The gap entries in `CONTRACT-GAPS.md` should disappear
   on their own, because they are generated from what the code cannot do.

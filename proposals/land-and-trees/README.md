# Proposal: evidence, parcels and trees

**Status: DRAFT — not approved, not implemented.**

Depends on [parties-and-land-roles](../parties-and-land-roles/). Approve that
first, or approve both together.

## Why

This is the visible heart of the product. A sponsor wants to see *this tree*, on
*this land*, photographed on *these dates*, cared for by *this person*. Today
none of it exists: GEO-001 and TREE-001 are approved requirements with no
tables, and EVID-001/002 are approved with no storage at all.

Evidence comes first in this proposal even though it is the least visible part.
EVID-001 requires that material claims trace to evidence, and every claim the
platform will make to a sponsor — this land is protected, this tree is standing,
this caretaker tends it — is a material claim. Photographs are not decoration
here; they are the evidence chain.

## What this proposes

| Artifact | File |
| --- | --- |
| Requirements | [`requirements.draft.json`](./requirements.draft.json) |
| Permissions | [`permissions.draft.json`](./permissions.draft.json) |
| Error codes | [`errors.draft.json`](./errors.draft.json) |
| Evidence asset | [`schemas/evidence-asset.draft.schema.json`](./schemas/evidence-asset.draft.schema.json) |
| Parcel | [`schemas/parcel.draft.schema.json`](./schemas/parcel.draft.schema.json) |
| Parcel boundary | [`schemas/parcel-boundary.draft.schema.json`](./schemas/parcel-boundary.draft.schema.json) |
| Tree | [`schemas/tree.draft.schema.json`](./schemas/tree.draft.schema.json) |
| Tree observation | [`schemas/tree-observation.draft.schema.json`](./schemas/tree-observation.draft.schema.json) |
| Domain events | [`events/`](./events/) |
| API operations | [`openapi/land-and-trees.draft.yaml`](./openapi/land-and-trees.draft.yaml) |
| Migration | [`database/0003_land_and_trees.draft.sql`](./database/0003_land_and_trees.draft.sql) |
| Traceability | [`traceability.draft.csv`](./traceability.draft.csv) |

The migration also adds the foreign key from `parties.land_roles.parcel_id`,
which the parties proposal had to leave unenforced because parcels did not
exist.

## Decisions taken, and why

**Evidence is content-addressed and immutable (EVID-002).** An asset is
identified by its SHA-256. Uploading the same photograph twice yields one
stored object. Assets are never modified or deleted, only superseded — because
an evidence record that can be edited is not evidence.

**Upload is two-phase.** The client asks for an upload URL, puts the bytes
directly into object storage, then calls `complete` with the checksum it
computed. The server verifies the stored object's digest matches before the
asset becomes usable. This is why `EVIDENCE_CHECKSUM_MISMATCH` already exists in
the approved error catalog — the contract for it was anticipated; the operations
were not. Bytes never pass through the API process.

**Boundaries are append-only (GEO-001).** A correction supersedes; nothing is
overwritten. Geometry is `GEOGRAPHY(POLYGON, 4326)` — geography rather than
geometry so area and distance are correct over large tropical extents without
picking a local projection.

**Boundary approval is separate from submission.** The approved permission
`parcel.approve_boundary` is already `critical` with `aal3` and dual control.
This proposal keeps submission and approval as distinct operations to match it.
Note the platform refuses any dual-control permission until the approval-record
contract exists — that is drafted separately.

**A tree is a long-lived identity; its condition is an observation series.**
TREE-001 requires permanent history. A tree row holds identity — species,
location, when it was registered. Everything that changes over time — height,
health, photographs, who observed it — is an immutable observation. This is what
makes "the history of this tree" a real query rather than an audit-log
reconstruction.

**Location precision is deliberately reducible.** `location_precision` lets a
public sponsor view show a fuzzed point while staff see the exact one. Publishing
exact coordinates of high-value timber is a real risk to the trees and to the
people who tend them.

## Open questions — these need a human

**1. Species taxonomy.** The draft stores a free-text vernacular name plus an
optional scientific name and an optional external taxonomy id. Mandating a
taxonomy would block field capture; omitting one entirely makes reporting
unreliable. Which taxonomy — GBIF, local forestry service, something else?

**2. What makes two tree records the same tree?** There is no natural key. The
draft uses a platform-assigned id plus optional physical tag. If a caretaker
loses a tag, or two workers register the same tree offline, the platform cannot
detect it. A merge operation is not proposed and will eventually be needed.

**3. How exact should public coordinates be?** The draft offers `exact`,
`reduced_1km` and `parcel_only`. Somebody has to decide the default, and it
should probably not be `exact`.

**4. Who may approve a boundary?** The approved permission demands `aal3` and
dual control. With one landowner and one caretaker, is there a second person to
form the second control? If not, boundary approval cannot proceed as specified.

**5. Photograph retention and takedown.** Photographs may contain people, houses
and paths. EVID-002 says originals are immutable; data protection law may compel
deletion. The draft supports superseding and hiding but never hard-deleting.
Same unresolved tension as consent withdrawal, and it needs the same lawyer.

**6. Does registering a tree require an approved boundary first?** The draft says
no — field workers should be able to record trees before the survey is approved,
or nothing gets done. But it means trees can exist on unapproved land, which
must not be sponsorable. That constraint belongs in the sponsorship contract.

**7. Offline capture (ADR-028).** Photographs taken with no signal need
client-side checksums, deferred upload and duplicate detection on arrival. The
two-phase upload is compatible with this, but the sync contract still does not
exist.

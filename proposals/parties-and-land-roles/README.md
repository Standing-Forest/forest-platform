# Proposal: parties and land roles

**Status: DRAFT — not approved, not implemented.**

Supersedes an earlier, narrower `farmer-enrollment` draft that modeled only the
farmer. That was wrong: the person working the land is frequently not the person
who can commit it.

## Why

Field staff recruiting smallholders is central to how the platform works, but no
person or organization appears anywhere in Release 0 — no requirement, no
permission, no table. Parcels and trees are at least *specified but unbuilt*
(GEO-001, TREE-001). Parties are absent entirely.

Everything downstream needs them. A parcel is held by someone. A conservation
payment is made to someone. CONSENT-001 governs someone's consent.

## The core modeling decision

Three concepts were asked for — **farmer**, **landowner**, **land controller** —
and all three exist here. They are modeled as **roles a party holds over land**,
not as three separate tables of people.

The reason is that they overlap constantly, and one human is often more than one
of them:

- A smallholder who owns and works their own plot is farmer *and* landowner.
- A tenant farmer works land owned by someone else.
- Community or customary land often has a **controller** — a chief, association
  or council — with authority to commit it, who neither owns it in registry
  terms nor farms it.
- A cooperative may control land that many individuals farm.

Three separate tables would duplicate the same person into each, and then
disagree about their name and contact details. Worse, it makes the question that
actually matters — *who may consent to conservation on this parcel?* —
unanswerable, because it is a property of the relationship, not of the person.

So:

- **`parties.parties`** — a person or organization. Identity, once.
- **`parties.land_roles`** — a party holds a role (`farmer`, `landowner`,
  `land_controller`) over a parcel, for a period, supported by evidence.

`land_controller` is deliberately distinct from `landowner` because in much of
the tropics the party with authority to commit land is not the registered owner,
and treating them as the same would either exclude customary tenure or
misrepresent it as ownership.

**Consent must come from a party holding an authority-bearing role**, which the
draft defines as `landowner` or `land_controller`. A farmer alone cannot commit
land they neither own nor control. Payments, by contrast, may well go to the
farmer. These are separate questions and the draft keeps them separate.

## What this proposes

| Artifact | File |
| --- | --- |
| Requirements | [`requirements.draft.json`](./requirements.draft.json) |
| Permissions | [`permissions.draft.json`](./permissions.draft.json) |
| Error codes | [`errors.draft.json`](./errors.draft.json) |
| Party schema | [`schemas/party.draft.schema.json`](./schemas/party.draft.schema.json) |
| Land role schema | [`schemas/land-role.draft.schema.json`](./schemas/land-role.draft.schema.json) |
| Consent grant schema | [`schemas/consent-grant.draft.schema.json`](./schemas/consent-grant.draft.schema.json) |
| Domain events | [`events/`](./events/) |
| API operations | [`openapi/parties.draft.yaml`](./openapi/parties.draft.yaml) |
| Migration | [`database/0002_parties.draft.sql`](./database/0002_parties.draft.sql) |
| Traceability | [`traceability.draft.csv`](./traceability.draft.csv) |

Deliberately **out of scope**: payments and bank details (blocked on FIN-001),
tree registration (blocked on TREE-001), and the parcel table itself (blocked on
GEO-001). `land_roles.parcel_id` is therefore specified but **cannot be given a
foreign key until GEO-001 has its tables** — see open question 2.

## Decisions taken, and why

Following approved patterns rather than inventing new ones:

- **Bitemporal** (ARCH-003). Roles change: land is sold, tenancies end, a
  controller is replaced. The platform must be able to answer who held authority
  *on the day a payment was authorized*, not just who holds it now.
- **UUIDv7 identifiers** (ADR-019); **tenant-scoped** (SEC-006), as
  `forests.projects` is.
- **Consent is a record, not a column** (CONSENT-001, ADR-016). Permitted uses
  are enumerated per grant and withdrawable. A boolean could not express
  "consented to payment but not to research."
- **Evidence by reference** (EVID-001/002). Title deeds and identity documents
  live in evidence storage, referenced by id and checksum. Personal documents are
  never copied into domain tables.
- **`party.read` exists** — the platform's first read of an existing
  tenant-owned resource, which finally makes SEC-006's cross-tenant check
  reachable from HTTP.

## Open questions — these need a human

**1. Is `land_controller` one role or several?**
"Customary authority", "cooperative", "concession holder" and "power of
attorney" are legally distinct and may need different evidence and different
approval. The draft uses one role with an `authorityBasis` field. Collapsing
them may be an oversimplification with legal consequences.

**2. Roles point at parcels that do not exist.**
`parcel_id` has no foreign key because `forests.parcels` was never created. This
proposal cannot be fully implemented before GEO-001 gets its tables. Either
approve them together, or accept an unenforced reference for a period.

**3. Consent withdrawal versus permanent history — a genuine conflict.**
ARCH-003 and TREE-001 require append-only history. CONSENT-001 gives
record-level permitted uses, and consent that cannot be withdrawn is not
consent. The draft's answer is that withdrawal ends the grant and blocks all
future processing but does not delete history. **This may not satisfy a legal
right to erasure where you operate.** This needs a lawyer, and it is the most
consequential question here.

**4. What are the actual permitted uses?**
The draft enumerates `conservation_payment`, `public_reporting`, `research`,
`partner_sharing`. This list must come from the consent form a person physically
signs, in their language — not from a schema written in advance.

**5. How much personal data should the platform hold?**
The draft is minimal: name, community, contact, holding size. It deliberately
excludes national ID numbers, bank details and home geolocation. Each is a
separate decision affecting people who may be vulnerable.

**6. Is `confidential` the right classification?**
Where enrollment involves Indigenous communities, ADR-016 and
`cultural_restricted` may apply, carrying handling rules nobody has written yet.

**7. Should asserting a `landowner` or `land_controller` role need dual control?**
It determines who can commit land and, downstream, who is paid — a target for
fraud. The draft sets `high` risk without an approval policy. Note the platform
refuses *any* permission carrying an `approvalPolicy` until an approval contract
exists.

**8. Offline enrollment (ADR-028).**
On a phone with no signal, uniqueness cannot be checked, so two workers can
enroll the same person, and two parties can claim the same parcel. The draft
assumes online enrollment. A sync and duplicate-merge contract is still missing.

**9. What happens when two parties claim the same role over one parcel?**
Genuine tenure disputes are common. The draft permits overlapping asserted roles
and records evidence for each, rather than forcing a winner at capture time —
but nothing yet says how a dispute is resolved or who adjudicates.

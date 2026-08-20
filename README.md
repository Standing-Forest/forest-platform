# Forest Platform

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![CI](https://github.com/Standing-Forest/forest-platform/actions/workflows/ci.yml/badge.svg)](https://github.com/Standing-Forest/forest-platform/actions/workflows/ci.yml)

A rainforest conservation platform built from a machine-readable specification —
for tracking land, trees and the people who tend them, and for connecting
sponsors to verified conservation work.

> **Pre-release. Not deployable to the public internet.** There is no
> authentication contract yet, so the app fails closed under
> `NODE_ENV=production`. Several operations deliberately refuse to run. Read
> [What works, and what refuses](#what-works-and-what-refuses) before assuming
> anything is functional.

Specification version **0.2.0**. Two contract packages are approved and
implemented; four more are drafted and awaiting review.

## The idea worth stealing

The governing rule is **DEV-AI-001 — coding agents may not invent missing
contracts**, and it applies to human contributors too.

The specification package under `docs/` is the source of truth *at runtime*:
error statuses come from `errors.json`, authorization from `permissions.json`,
and every event is validated against the approved envelope before it can be
stored. Nothing in `src/` hardcodes an HTTP status, a permission code, or a
requirement id.

When an operation's contract does not exist, the platform **refuses** with
`SPECIFICATION_CONTRACT_MISSING` (409) and names precisely which artifacts are
missing — rather than guessing a plausible shape that would later conflict with
the real one and strand data collected under the wrong schema.

The result is [CONTRACT-GAPS.md](./CONTRACT-GAPS.md): a generated, always-current
list of exactly what this software cannot honestly do, and what must be written
and approved before it can. It is also served live at `/internal/contract-gaps`,
and CI fails if the file drifts from what the running app reports. For a system
that will make claims about land tenure and move money to smallholder farmers,
being loudly incapable beats being quietly wrong.

## Quick start

```bash
docker compose up -d --build     # Postgres+PostGIS, migrations, API
docker compose run --rm seed     # dev-only: create the home instance
curl localhost:3000/health
```

Then open <http://localhost:3000> for the web UI.

Services: `db` (postgis/postgis:16-3.4), `migrate` (applies the approved SQL
then exits), `api`, and `seed` (a dev-only profile, not started by `up`).

Already using port 3000? Override the host port:

```bash
API_PORT=3100 docker compose up -d --build
```

## What works, and what refuses

| Operation | Behavior |
| --- | --- |
| `POST /api/v1/projects` | **Implemented.** Creates the project and its `ForestProjectCreated` event in one transaction. |
| `POST /api/v1/parties` | **Implemented.** Registers a person or organization together with their consent grant, in one transaction — a party cannot exist having consented to nothing. |
| `GET /api/v1/parties/{partyId}` | **Implemented.** The first operation reading an existing tenant-owned resource, so SEC-006's cross-tenant check is reachable over HTTP. |
| `POST /api/v1/parties/{id}/consent-grants/{id}/withdrawal` | **Implemented.** Ends the grant and stops all future processing; deletes nothing. |
| `POST /api/v1/parcels/{parcelId}/land-roles` | **Implemented.** Records who is the farmer, landowner or land controller. Only the latter two convey authority to commit the land. |
| `GET /api/v1/parcels/{parcelId}/land-roles` | **Implemented.** Answers whether anyone has authority to commit this parcel. |
| `POST /api/v1/parcels/{parcelId}/boundaries` | Authorization and the `x-idempotency-required` contract are enforced, then **409** — no `forests.parcel_boundaries` table or geometry schema exists. |
| `POST /api/v1/ai/query` | **409** — no citation schema, evidence store, or grounding contract exists. Answering ungrounded would violate AI-002 and AI-004. |
| `GET /health` | Liveness plus the loaded spec version. |
| `GET /internal/contract-gaps` | Everything this deployment knows it cannot do. |
| `GET /internal/specification` | The registries actually loaded, for operator verification. |

### Three things worth knowing about what is implemented

**Farmer, landowner and land controller are roles over land, not three kinds of
person.** They overlap constantly — a smallholder who works their own plot is
both farmer and landowner, while community land often has a controller with
authority to commit it who neither owns nor farms it. Modelling them as a
relationship is what makes the question that actually matters answerable: *who
may consent to conservation on this parcel?*

**Consent is enforced, not merely recorded.** An authority-bearing land role
cannot be asserted for a party who has not consented to conservation payment, or
who has withdrawn that consent. Withdrawal is idempotent, requires no stated
reason, and is deliberately not gated behind step-up or approval — each of those
would be a way of obstructing it.

**Land roles currently name parcels that cannot be verified**, because
`forests.parcels` does not exist yet, so the reference has no foreign key. This
is recorded as a contract gap, and `GET /parcels/{id}/land-roles` reports
`parcelExistenceVerified: false` rather than implying otherwise. Approving the
`land-and-trees` proposal creates the table and closes it.

## The specification is the source of truth at runtime

`src/core/spec/registry.ts` loads the spec package on boot. Nothing hardcodes an
HTTP status, permission code, or requirement id:

- **Error statuses** come from `errors/errors.json`. Constructing an unregistered
  code throws.
- **Authorization** comes from `permissions/permissions.json` — `riskLevel`,
  `stepUpAuthentication` (aal3), `approvalPolicy`. Tightening a permission is a
  spec edit, not a code change.
- **Events** are validated against `events/envelope/domain-event.schema.json`
  before they can reach the outbox, and their `requirementIds` are cross-checked
  against the approved registry.

Failures the approved catalog cannot express (401, 403, 404, malformed body,
rate limiting) are returned with `specificationRegistered: false`, so a
contract-backed error is always distinguishable from a provisional one.

**Events carry no personal data, no precise coordinates and no secrets.** An
event stream is retained and forwarded far more widely than the records it
describes, so putting a farmer's name or a tree's exact position in one would
defeat the access control applied on read. A test asserts this.

## Authentication fails closed

The specification defines no authentication contract. The only resolver shipped
is a development header shim that trusts the caller completely:

```
x-actor-id, x-actor-type, x-organization-id, x-instance-id,
x-assurance-level, x-permissions (comma-separated)
```

`AUTH_MODE` has no default — startup fails unless it is set explicitly, and
`AUTH_MODE=dev-headers` is refused under `NODE_ENV=production`. The container
image defaults to `NODE_ENV=production` so a bare `docker run` fails closed;
Compose overrides it for local use. **Wire a real `PrincipalResolver`
(`src/core/auth/principal.ts`) before deploying anywhere real.**

## The web UI

Served by the API itself at <http://localhost:3000>. Four surfaces: supporters,
staff console, field, and platform status.

Every section is badged **Live** (talks to the real backend), **Demo** (sample
data from `web/demo-data.js`), or **No contract** (the operation genuinely does
not exist). The donation form does not take money and says so.

Rebranding is one file — `web/branding.json` holds the organization name,
tagline, mission, logo, colour palette and contact details. Edit, save, refresh.
No rebuild, no code.

## Proposals

`proposals/` holds draft contracts for capabilities the specification does not
yet cover. **A draft is not a contract**: the platform refuses every operation
an unapproved proposal describes.

| Proposal | Status |
| --- | --- |
| parties-and-land-roles | **Approved and implemented** at spec 0.2.0 |
| land-and-trees | Draft — evidence assets, parcels, boundaries, trees, observation history |
| governance-approvals | Draft — staff roles and dual-control approval records |
| finance | Draft — double-entry ledger, sponsorship, payments in, payouts out |

Each proposal ends with an **Open questions** section naming decisions that
cannot legitimately be made by an engineer: consent withdrawal versus permanent
history, what precisely is promised to a sponsor, whether a land controller is
one role or several. Those questions are the most valuable part.

Approving one means moving its artifacts into `docs/`, promoting `"proposed"` to
`"approved"`, regenerating the manifest checksums and running the validator —
see [proposals/README.md](proposals/README.md).

## Development

```bash
npm install
npm run dev            # tsx watch
npm test               # unit always; integration when a database is reachable
npm run typecheck
npm run migrate        # apply the approved SQL
npm run seed           # dev-only home instance
npm run gaps           # regenerate CONTRACT-GAPS.md
npm run spec:validate  # the spec package's own validator
```

Copy `.env.example` to `.env` for running outside Compose. `AUTH_MODE` must be
set explicitly or startup fails — that is the fail-closed guard, not a bug.

Integration tests **skip** rather than fail when no database is reachable, so
`npm test` is always useful. Test files run in parallel: scope any cleanup to
your own tenant, because an unqualified `DELETE` will wipe another file's rows
and produce failures that look like product bugs.

### Verifying the schema against the database

The SQL under `docs/.../database/` is the canonical DDL — `drizzle-kit` is a
checker here, never the source of truth. To confirm the TypeScript schema has
not drifted from a database built by that SQL:

```bash
npx drizzle-kit introspect --config=drizzle.introspect.config.ts
```

and compare the emitted DDL against `npm run db:generate` output. Last verified
on the foundation schema: **no drift** — all 7 constraint and index names
identical.

Two differences are expected and not drift: `CREATE EXTENSION postgis`
(drizzle-kit does not manage extensions) and `IF NOT EXISTS` idempotency.

### Note on the lockfile

`package-lock.json` must be generated on Linux — a Windows-generated lock omits
peer entries for optional native dependencies and breaks `npm ci` in the image:

```bash
docker run --rm -v "$PWD:/app" -w /app node:22-alpine npm install --package-lock-only
```

## Layout

```
src/core/spec/       registry loader, contract-gap registry
src/core/errors/     registry-backed AppError, UnregisteredError, DB translation
src/core/events/     envelope validation, transactional outbox, publisher
src/core/auth/       principal resolution, permission enforcement
src/modules/         forests, parties, ai
scripts/             migrate, seed-dev, report-contract-gaps
tests/               unit and integration
web/                 the browser UI (branding.json rebrands the whole site)
docs/                the specification package (read at runtime)
proposals/           DRAFT contracts awaiting human approval — not implemented
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: implementations must
not invent contracts, and anything requiring a contract that does not exist is a
*proposal*, not a pull request against `docs/`.

Never commit real personal data, real land coordinates, or photographs of real
land. Everything in `web/demo-data.js` is invented and must stay that way.

Security issues: see [SECURITY.md](SECURITY.md) — please report privately.

## Who maintains this

**Standing Forest** — an informal group of contributors. It is not a company,
charity or other legal entity, holds no assets, and speaks for no employer.
Copyright rests with the individual authors, who license their contributions
under Apache-2.0. See [NOTICE](NOTICE).

## Licence

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for authorship disclosure,
including the project's use of AI assistance.

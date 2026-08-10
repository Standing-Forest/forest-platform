# Forest Platform

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

A rainforest conservation platform built from a machine-readable specification —
for tracking land, trees and the people who tend them, and for connecting
sponsors to verified conservation work.

> **Pre-release. Not deployable to the public internet.** There is no
> authentication yet, and most operations deliberately refuse to run. Read
> [What works, and what refuses](#what-works-and-what-refuses) before assuming
> anything is functional.

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
and approved before it can. It is also served live at
`/internal/contract-gaps`. For a system that will make claims about land tenure
and move money to smallholder farmers, being loudly incapable beats being
quietly wrong.

## Quick start

```bash
docker compose up -d --build     # Postgres+PostGIS, migrations, API
docker compose run --rm seed     # dev-only: create the home instance
curl localhost:3000/health
```

The stack is three services: `db` (postgis/postgis:16-3.4), `migrate` (applies
the approved SQL then exits), and `api`.

## What works, and what refuses

| Operation | Behavior |
| --- | --- |
| `POST /api/v1/projects` | **Implemented.** Creates the project and its `ForestProjectCreated` event in one transaction. |
| `POST /api/v1/parcels/:parcelId/boundaries` | Authorization and the `x-idempotency-required` contract are enforced, then **409** — no `forests.parcel_boundaries` table or geometry schema exists. |
| `POST /api/v1/ai/query` | **409** — no citation schema, evidence store, or grounding contract exists. Answering ungrounded would violate AI-002 and AI-004. |
| `GET /health` | Liveness plus the loaded spec version. |
| `GET /internal/contract-gaps` | Everything this deployment knows it cannot do. |
| `GET /internal/specification` | The registries actually loaded, for operator verification. |

Only `POST /projects` is fully specified: `forests.projects` exists in the
approved SQL and `traceability.csv` names its event. Even there the OpenAPI
declares no `requestBody`, so the request shape is *derived* from the approved
table columns — recorded as a gap rather than treated as settled.

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

Failures the six-code catalog cannot express (401, 403, 404, malformed body) are
returned with `specificationRegistered: false` so a contract-backed error is
always distinguishable from a provisional one.

## Authentication fails closed

Release 0 defines no authentication contract. The only resolver shipped is a
development header shim that trusts the caller completely:

```
x-actor-id, x-actor-type, x-organization-id, x-instance-id,
x-assurance-level, x-permissions (comma-separated)
```

`AUTH_MODE` has no default — startup fails unless it is set explicitly, and
`AUTH_MODE=dev-headers` is refused under `NODE_ENV=production`. The container
image defaults to `NODE_ENV=production` so a bare `docker run` fails closed;
Compose overrides it for local use. **Wire a real `PrincipalResolver`
(`src/core/auth/principal.ts`) before deploying anywhere real.**

## Development

```bash
npm install
npm run dev          # tsx watch
npm test             # unit always; integration when a database is reachable
npm run typecheck
npm run gaps         # regenerate CONTRACT-GAPS.md
npm run spec:validate  # the spec package's own validator
```

Copy `.env.example` to `.env` for running outside Compose.

### Verifying the schema against the database

`0001_foundation.sql` is the canonical DDL — `drizzle-kit` is a checker here,
never the source of truth. To confirm `schema.foundation.ts` has not drifted
from a database built by that SQL:

```bash
npx drizzle-kit introspect --config=drizzle.introspect.config.ts
```

and compare the emitted DDL against `.drizzle/0000_foundation_from_ts.sql`
(`npm run db:generate`). Last verified: **no drift** — all 7 constraint and
index names identical.

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
src/core/errors/     registry-backed AppError, UnregisteredError
src/core/events/     envelope validation, transactional outbox, publisher
src/core/auth/       principal resolution, permission enforcement
src/modules/         forests, ai
scripts/             migrate, seed-dev, report-contract-gaps
web/                 the browser UI (branding.json rebrands the whole site)
docs/                the specification package (read at runtime)
proposals/           DRAFT contracts awaiting human approval — not implemented
```

## The web UI

`docker compose up -d --build`, then http://localhost:3000. Four surfaces:
supporters, staff console, field, and platform status.

Every section is badged **Live** (talks to the real backend), **Demo** (sample
data from `web/demo-data.js`), or **No contract** (the operation genuinely does
not exist). The donation form does not take money and says so.

Rebranding is one file — `web/branding.json` holds the organization name,
tagline, mission, logo, colour palette and contact details. Edit, save, refresh.
No rebuild, no code.

## Proposals

`proposals/` holds draft contracts for capabilities the specification does not
yet cover: parties and land roles, evidence and trees, governance and approvals,
and finance. **None is approved or implemented** — the platform still refuses
every operation they describe.

Each proposal ends with an **Open questions** section naming decisions that
cannot legitimately be made by an engineer: consent withdrawal versus permanent
history, what precisely is promised to a sponsor, whether a land controller is
one role or several. Those questions are the most valuable part.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: implementations must
not invent contracts, and anything requiring a contract that does not exist is a
*proposal*, not a pull request against `docs/`.

Security issues: see [SECURITY.md](SECURITY.md) — please report privately.

## Who maintains this

**Standing Forest** — an informal group of contributors. It is not a company,
charity or other legal entity, holds no assets, and speaks for no employer.
Copyright rests with the individual authors, who license their contributions
under Apache-2.0. See [NOTICE](NOTICE).

## Licence

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for authorship disclosure,
including the project's use of AI assistance.

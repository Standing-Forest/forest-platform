# Forest Platform

An implementation of the Release 0 machine-readable specification package in
`docs/forest_platform_machine_readable_release0/`.

The governing rule is **DEV-AI-001 — coding agents may not invent missing
contracts.** Release 0 is explicitly a foundation package, not the complete
production contract set, so this service implements what the specification fully
defines and *refuses* everything else with `SPECIFICATION_CONTRACT_MISSING`
(409), naming the exact artifacts that are absent. See
[CONTRACT-GAPS.md](./CONTRACT-GAPS.md).

## Quick start

```bash
docker compose up -d --build     # Postgres+PostGIS, migrations, API
docker compose run --rm seed     # dev-only: create the home instance
curl localhost:3000/health
```

The stack is three services: `db` (postgis/postgis:16-3.4), `migrate` (applies
the approved SQL then exits), and `api`.

## What works, and what refuses

| Operation | Behaviour |
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
docs/                the specification package (read at runtime)
```

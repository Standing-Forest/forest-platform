# Contributing

Thanks for your interest. This project has one unusual rule that shapes
everything else, so please read the first section before opening a PR.

## The one rule: don't invent contracts

Requirement **DEV-AI-001** states that coding agents may not invent missing
contracts. In practice the rule applies to everyone, human or otherwise.

The specification package under
`docs/forest_platform_machine_readable_release0/` is the source of truth. It is
read at runtime: error statuses come from `errors.json`, authorization comes
from `permissions.json`, and events are validated against the approved envelope
schema. Nothing in `src/` hardcodes an HTTP status, a permission code, or a
requirement id.

When an operation's contract does not exist, the platform **refuses** with
`SPECIFICATION_CONTRACT_MISSING` (409) and names the missing artifacts. It does
not guess a plausible shape.

This is deliberate. A guessed schema that later conflicts with the approved one
means migrating real data collected under the wrong shape — and, for a platform
making claims about land and payments to people, quietly inventing a rule is
worse than refusing to act.

**So:** if the change you want requires a contract that doesn't exist, the
contribution is a *proposal*, not an implementation. See below.

## Two kinds of contribution

### 1. Implementation

Building something the approved specification already defines, or fixing a bug.
Normal pull request.

- `npm run typecheck` must pass
- `npm test` must pass (integration tests skip automatically without a database)
- `npm run spec:validate` must pass
- `npm run gaps` if you changed what the platform can or cannot do —
  `CONTRACT-GAPS.md` is generated, and a test fails if it drifts from what the
  running app reports

### 2. A contract proposal

Proposing something the specification doesn't cover yet. These live in
`proposals/` as clearly-marked drafts and are **never** placed in the approved
package by their author.

Follow the shape of the existing proposals — see `proposals/README.md`. A good
proposal includes requirements, permissions, error codes, schemas, event
payloads, an OpenAPI fragment, a migration, traceability rows, and — most
importantly — an **Open questions** section naming the decisions you could not
legitimately make yourself.

That last part is the point. Several existing proposals are blocked on questions
that need a lawyer or a domain expert, not an engineer. Surfacing them is more
valuable than guessing.

## Getting set up

```bash
npm install
docker compose up -d db          # Postgres + PostGIS
npm run migrate
npm run seed                     # development-only home instance
npm run dev
```

Or the whole stack:

```bash
docker compose up -d --build
docker compose run --rm seed
```

Then open http://localhost:3000.

**Note on the lockfile:** `package-lock.json` must be generated on Linux. A
Windows-generated lock omits peer entries for optional native dependencies and
breaks `npm ci` inside the container image:

```bash
docker run --rm -v "$PWD:/app" -w /app node:24-alpine npm install --package-lock-only
```

## Testing against the database

Integration tests need Postgres running and **skip silently** when it is not
reachable, so `npm test` is always useful. If you are changing anything in
`src/db/`, `src/core/events/` or the migrations, run with a database up.

Test files run in parallel. Scope your cleanup to your own tenant — an
unqualified `DELETE` will wipe another test file's rows and produce failures
that look like product bugs.

## Style

Match the surrounding code. A few things that are consistent throughout and
worth preserving:

- Comments explain **why**, not what. If a constraint exists to prevent a
  specific failure, say which one.
- Constraints belong in the database when they protect something that matters.
  An approval control or an append-only guarantee that lives only in service
  code is one refactor away from being lost.
- Events carry no personal data, no precise coordinates, and no secrets. Event
  streams are retained and forwarded widely; access control applied on read is
  defeated by putting the same data in an event.

## Never commit

- Real personal data. No actual farmer, caretaker or landowner names, contact
  details, or identity documents — not in tests, not in seeds, not in
  screenshots. Everything in `web/demo-data.js` is invented and must stay that
  way.
- Real parcel coordinates or photographs of real land.
- Credentials of any kind. `.env` is gitignored; keep it that way.

Once something is public and cloned, it cannot be withdrawn.

## Code of conduct

By participating you agree to abide by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Licensing of contributions

Contributions are accepted under the [Apache License 2.0](LICENSE), the same
license as the project. If you used an AI assistant substantially, please say so
in the pull request — the project discloses its own use in `NOTICE` and applies
the same standard to contributions.

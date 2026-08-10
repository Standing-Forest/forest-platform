## What this changes

<!-- One or two sentences. -->

## Why

<!-- What problem does it solve? Link an issue if there is one. -->

## Type

- [ ] Implementation of something the **approved** specification already defines
- [ ] Bug fix
- [ ] A **draft proposal** under `proposals/` (not approved, not implemented)
- [ ] Documentation
- [ ] Infrastructure or tooling

## Checks

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] `npm run spec:validate` passes
- [ ] `npm run gaps` run, and `CONTRACT-GAPS.md` committed, if what the platform
      can or cannot do changed

## DEV-AI-001

- [ ] This change invents **no** contract that does not exist in the approved
      specification package. If an operation's contract is missing, it refuses
      with `SPECIFICATION_CONTRACT_MISSING` rather than guessing a shape.
- [ ] Nothing was added to
      `docs/forest_platform_machine_readable_release0/` without human approval.
      Proposals go in `proposals/`.

## Data safety

- [ ] No real personal data, land coordinates, or photographs of real land
- [ ] No credentials, keys or tokens

## Anything reviewers should know

<!-- Trade-offs, things you were unsure about, decisions you think need a human
     with authority rather than an engineer. -->

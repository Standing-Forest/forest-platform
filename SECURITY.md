# Security policy

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report privately through GitHub's [private vulnerability
reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)
(Security tab → Report a vulnerability), or email the maintainer.

Please include what you did, what happened, and what you expected. A working
proof of concept helps but is not required. You will get an acknowledgement
within a few days.

## What this project handles

This is not an ordinary web application. Take extra care with anything touching:

- **Land tenure records.** Who owns or controls a piece of land is contested in
  many of the places this platform is meant to serve. A disclosure or tampering
  bug here can expose people to dispossession or violence.
- **Precise tree locations.** `TREE-003` reduces location precision on read for
  a reason: exact coordinates of high-value timber endanger both the trees and
  the people who tend them. Any bug that leaks exact coordinates to an
  unauthorized caller is a **high severity** issue, not a privacy nitpick.
- **Personal data of vulnerable people.** Smallholder farmers, caretakers and
  their consent records.
- **Money.** Sponsor payments in and payouts to landowners.
- **Evidence integrity.** Photographs and documents that material claims rest
  on. A bug allowing evidence to be altered undermines every claim made to a
  sponsor.

## Known limitations — deliberate, not vulnerabilities

Please do not report these; they are documented and intentional at this stage.

- **There is no authentication.** The approved specification defines no
  authentication contract, so the only implementation is a development header
  shim that trusts the caller completely. It is refused when
  `NODE_ENV=production`, and the container image defaults to production so a
  bare `docker run` fails closed. **This project is not deployable to the public
  internet as-is.** See `CONTRACT-GAPS.md`.
- **Most operations refuse with HTTP 409.** Under requirement `DEV-AI-001` the
  platform will not implement an operation whose contract does not exist. That
  is the intended behavior.
- **`docker-compose.yml` uses `postgres/postgres`.** Local development only.
  Never use that Compose file as a production deployment.
- **Everything under `proposals/` is a draft.** Unapproved, unimplemented, and
  not wired into the running application.

## Supported versions

This project is pre-release. Only the `main` branch receives fixes.

## Reporting data-protection concerns

If you believe the platform's design mishandles personal data — particularly
consent withdrawal, evidence retention, or precision reduction — please raise
it. Several of these are open questions flagged in the proposal documents and
explicitly need human legal judgement rather than an engineering fix.

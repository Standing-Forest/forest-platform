/**
 * Translates Postgres integrity violations into client-facing responses.
 *
 * A constraint doing its job is not a server fault: a duplicate public_id is a
 * caller mistake and must not surface as 500. The database is the last line of
 * defence for invariants the approved SQL declares (unique public ids, the
 * outbox sequence index, the CHECK constraints), so these are expected
 * outcomes and get expressed as such.
 *
 * SPEC GAP: errors.json defines no code for a duplicate or conflicting
 * resource, so these carry unregistered codes and are recorded as a gap.
 */
import { registerContractGap } from "../spec/contract-gap.js";
import { UnregisteredError } from "./unregistered.js";

registerContractGap({
  operation: "integrity violation responses",
  missingArtifacts: [
    "errors.json entries for: resource already exists (409), referenced resource missing (422), check constraint violated (422)",
  ],
  blockedRequirementIds: ["DEV-AI-001"],
  notes:
    "The approved SQL declares unique, foreign key and CHECK constraints, but the error " +
    "catalog has no codes for violating them. Without these, a caller-caused conflict is " +
    "indistinguishable from a server fault.",
});

/** Postgres SQLSTATE class 23 — integrity constraint violation. */
const SQLSTATE = {
  UNIQUE_VIOLATION: "23505",
  FOREIGN_KEY_VIOLATION: "23503",
  CHECK_VIOLATION: "23514",
  NOT_NULL_VIOLATION: "23502",
} as const;

interface PostgresErrorShape {
  code?: string;
  constraint_name?: string;
  constraint?: string;
  detail?: string;
}

/**
 * Drizzle wraps driver errors, so the SQLSTATE sits somewhere down the `cause`
 * chain rather than on the thrown error itself.
 */
function findPostgresError(error: unknown, depth = 0): PostgresErrorShape | null {
  if (depth > 5 || error === null || typeof error !== "object") return null;
  const candidate = error as PostgresErrorShape & { cause?: unknown };
  if (typeof candidate.code === "string" && /^\d{5}$/.test(candidate.code)) {
    return candidate;
  }
  return findPostgresError(candidate.cause, depth + 1);
}

/**
 * Returns an UnregisteredError for a recognized integrity violation, or null so
 * the caller can fall through to its generic handling.
 *
 * Constraint names are safe to expose — they come from the approved SQL and
 * name the invariant. The driver's `detail` is not: it echoes the offending
 * values, so it stays in the log.
 */
export function translateDatabaseError(error: unknown): UnregisteredError | null {
  const pgError = findPostgresError(error);
  if (!pgError) return null;

  const constraint = pgError.constraint_name ?? pgError.constraint;

  switch (pgError.code) {
    case SQLSTATE.UNIQUE_VIOLATION:
      return new UnregisteredError(
        409,
        "RESOURCE_ALREADY_EXISTS",
        "A resource with these unique values already exists",
        constraint ? { constraint } : {},
      );

    case SQLSTATE.FOREIGN_KEY_VIOLATION:
      return new UnregisteredError(
        422,
        "REFERENCED_RESOURCE_MISSING",
        "A referenced resource does not exist",
        constraint ? { constraint } : {},
      );

    case SQLSTATE.CHECK_VIOLATION:
      return new UnregisteredError(
        422,
        "CHECK_CONSTRAINT_VIOLATED",
        "A value violates a constraint declared in the approved schema",
        constraint ? { constraint } : {},
      );

    case SQLSTATE.NOT_NULL_VIOLATION:
      return new UnregisteredError(422, "REQUIRED_FIELD_MISSING", "A required value was absent");

    default:
      return null;
  }
}

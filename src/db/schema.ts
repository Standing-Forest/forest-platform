/**
 * The approved Drizzle schema lives inside the specification package and is the
 * contract. We re-export it rather than redefining it so there is exactly one
 * definition of the foundation tables (ADR-008: PostgreSQL is the authority).
 */
export {
  core,
  forests,
  events,
  instances,
  projects,
  outbox,
} from "../../docs/forest_platform_machine_readable_release0/forest_platform_release0/database/schema.foundation.js";

export {
  parties,
  partyRecords,
  consentGrants,
  landRoles,
} from "../../docs/forest_platform_machine_readable_release0/forest_platform_release0/database/schema.parties.js";

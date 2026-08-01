import { defineConfig } from "drizzle-kit";

/**
 * Verification-only config: introspects a live database (one built by applying
 * the approved 0001_foundation.sql) so its DDL can be compared against
 * schema.foundation.ts. Output is diagnostic and never applied.
 */
export default defineConfig({
  dialect: "postgresql",
  schema:
    "./docs/forest_platform_machine_readable_release0/forest_platform_release0/database/schema.foundation.ts",
  out: "./.drizzle/introspect",
  schemaFilter: ["core", "forests", "events"],
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgres://postgres:postgres@localhost:5432/forest_platform",
  },
});

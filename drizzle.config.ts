import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema:
    "./docs/forest_platform_machine_readable_release0/forest_platform_release0/database/schema.foundation.ts",
  out: "./.drizzle",
  schemaFilter: ["core", "forests", "events"],
  // Used by `drizzle-kit introspect` to verify the TypeScript schema against a
  // database built from the approved 0001_foundation.sql. The canonical DDL is
  // that SQL file — drizzle-kit is a checker here, never the source of truth.
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgres://postgres:postgres@localhost:5432/forest_platform",
  },
  verbose: true,
  strict: true,
});

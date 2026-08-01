/**
 * Applies the approved SQL migrations from the specification package.
 *
 * The canonical DDL is 0001_foundation.sql inside the release0 package — not a
 * drizzle-kit generated migration. drizzle-kit is used here only to *verify*
 * that the TypeScript schema matches; the SQL is what actually runs.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { loadEnv } from "../src/config/env.js";
import { SPEC_ROOT } from "../src/core/spec/registry.js";

const env = loadEnv();
const migrationsDir = join(SPEC_ROOT, "database");

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const sql = postgres(env.databaseUrl, { max: 1, onnotice: () => {} });

/**
 * A healthy container is not always an accepting socket — Postgres refuses TCP
 * briefly during first-boot initialisation. Wait rather than crash the stack.
 */
async function waitForDatabase(attempts = 30, delayMs = 1000): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await sql`SELECT 1`;
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      console.log(`waiting for database (${attempt}/${attempts})`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

try {
  await waitForDatabase();

  await sql`CREATE TABLE IF NOT EXISTS public.schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

  for (const file of files) {
    const [existing] = await sql<{ filename: string }[]>`
      SELECT filename FROM public.schema_migrations WHERE filename = ${file}
    `;
    if (existing) {
      console.log(`skip   ${file} (already applied)`);
      continue;
    }

    const ddl = readFileSync(join(migrationsDir, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(ddl);
      await tx`INSERT INTO public.schema_migrations (filename) VALUES (${file})`;
    });
    console.log(`apply  ${file}`);
  }

  console.log(`\n${files.length} migration file(s) processed.`);
} finally {
  await sql.end({ timeout: 5 });
}

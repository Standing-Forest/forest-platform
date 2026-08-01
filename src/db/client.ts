import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Env } from "../config/env.js";
import * as schema from "./schema.js";

export type Database = ReturnType<typeof createDatabase>["db"];

export function createDatabase(env: Env) {
  const sql = postgres(env.databaseUrl, { max: 10, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  return { sql, db };
}

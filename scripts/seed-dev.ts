/**
 * Development seed: creates the home instance that POST /projects requires.
 *
 * forests.projects.home_instance_id is a foreign key to core.instances, so on a
 * fresh database the only implemented endpoint 404s until one instance row
 * exists. Release 0 defines no instance-provisioning operation, so this is a
 * development convenience, not a contract — and it refuses to run in production
 * for the same reason the header auth shim does.
 */
import postgres from "postgres";
import { loadEnv } from "../src/config/env.js";

const env = loadEnv();

if (env.nodeEnv === "production") {
  throw new Error(
    "seed-dev must not run in production: instance provisioning has no approved contract",
  );
}

const sql = postgres(env.databaseUrl, { max: 1, onnotice: () => {} });

try {
  const [existing] = await sql<{ id: string }[]>`
    SELECT id FROM core.instances WHERE id = ${env.instanceId}
  `;

  if (existing) {
    console.log(`instance ${env.instanceId} already present`);
  } else {
    await sql`
      INSERT INTO core.instances (id, public_id, canonical_url, created_at)
      VALUES (
        ${env.instanceId},
        ${"local-dev"},
        ${"http://localhost:3000"},
        ${new Date()}
      )
    `;
    console.log(`seeded instance ${env.instanceId}`);
  }
} finally {
  await sql.end({ timeout: 5 });
}

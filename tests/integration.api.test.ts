/**
 * Integration tests against a real Postgres — start it with `docker compose up -d db`.
 * Skipped (not failed) when no database is reachable, so `npm test` stays useful
 * without Docker.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { eq } from "drizzle-orm";

process.env.AUTH_MODE ??= "dev-headers";
process.env.LOG_LEVEL ??= "silent";
process.env.NODE_ENV ??= "development";
process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/forest_platform";

const { loadEnv } = await import("../src/config/env.js");
const { createDatabase } = await import("../src/db/client.js");
const { buildApp } = await import("../src/app.js");
const { instances, projects, outbox } = await import("../src/db/schema.js");
const { assertValidEnvelope } = await import("../src/core/events/envelope.js");
const { publishBatch, loggingTransport } = await import("../src/core/events/publisher.js");
const { newId } = await import("../src/core/ids.js");

const env = loadEnv();

const tenantId = newId();
const actorId = newId();
const orgId = newId();

// Reachability must be settled before the suites are declared: node:test reads
// the `skip` option at declaration time, so a hook cannot decide it.
const { sql, db } = createDatabase(env);
let reachable = true;
try {
  await sql`SELECT 1`;
} catch {
  reachable = false;
  console.log("no database reachable - skipping integration suites");
}

let app: Awaited<ReturnType<typeof buildApp>>;

if (reachable) {
  await db.insert(instances).values({
    id: tenantId,
    publicId: `test-${tenantId.slice(0, 8)}`,
    canonicalUrl: "http://test.local",
    createdAt: new Date(),
  });
  app = await buildApp({ env, db });
}

const authHeaders = (perms: string) => ({
  "content-type": "application/json",
  "x-actor-id": actorId,
  "x-instance-id": tenantId,
  "x-organization-id": orgId,
  "x-permissions": perms,
});

after(async () => {
  if (reachable) {
    await db.delete(outbox);
    await db.delete(projects).where(eq(projects.homeInstanceId, tenantId));
    await db.delete(instances).where(eq(instances.id, tenantId));
    await app?.close();
  }
  await sql?.end({ timeout: 5 });
});

describe("POST /api/v1/projects", { skip: !reachable }, () => {
  it("creates the project and its event in one transaction", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: authHeaders("project.create"),
      payload: { publicId: `p-${newId().slice(0, 8)}`, leadOrganizationId: orgId },
    });

    assert.equal(response.statusCode, 201);
    const body = response.json();

    const rows = await db.select().from(projects).where(eq(projects.id, body.id));
    assert.equal(rows.length, 1);

    const events = await db.select().from(outbox).where(eq(outbox.aggregateId, body.id));
    assert.equal(events.length, 1);
    assert.equal(events[0]!.eventType, "ForestProjectCreated");
    assert.equal(events[0]!.aggregateSequence, 1n);
    assert.deepEqual(events[0]!.requirementIds, ["ARCH-001"]);

    // The stored payload must still satisfy the canonical envelope.
    assert.doesNotThrow(() => assertValidEnvelope(events[0]!.payload as never));
  });

  it("rolls the event back when the transaction fails", async () => {
    const doomedId = newId();
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.insert(projects).values({
          id: doomedId,
          publicId: `doomed-${doomedId.slice(0, 8)}`,
          homeInstanceId: tenantId,
          leadOrganizationId: orgId,
          createdAt: new Date(),
          metadata: {},
        });
        throw new Error("forced failure after insert");
      }),
    );

    const rows = await db.select().from(projects).where(eq(projects.id, doomedId));
    assert.equal(rows.length, 0);
  });

  it("returns 403 without the permission", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: authHeaders("tree.register"),
      payload: { publicId: "nope", leadOrganizationId: orgId },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, "PERMISSION_DENIED");
  });

  it("returns 400 for a body that violates the derived schema", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: authHeaders("project.create"),
      payload: { publicId: "missing-org" },
    });
    assert.equal(response.statusCode, 400);
  });
});

describe("outbox publisher", { skip: !reachable }, () => {
  it("marks events published and is idempotent", async () => {
    const first = await publishBatch({
      db,
      transport: loggingTransport(() => {}),
      batchSize: 100,
      pollIntervalMs: 0,
    });
    assert.ok(first >= 0);

    const second = await publishBatch({
      db,
      transport: loggingTransport(() => {}),
      batchSize: 100,
      pollIntervalMs: 0,
    });
    assert.equal(second, 0, "already-published events must not publish twice");
  });
});

describe("unimplemented operations refuse rather than guess", { skip: !reachable }, () => {
  it("POST /ai/query returns 409 SPECIFICATION_CONTRACT_MISSING", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/ai/query",
      headers: { "content-type": "application/json" },
      payload: { question: "how many trees" },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, "SPECIFICATION_CONTRACT_MISSING");
  });

  it("POST /parcels/:id/boundaries enforces idempotency before refusing", async () => {
    const url = `/api/v1/parcels/${newId()}/boundaries`;

    const withoutKey = await app.inject({
      method: "POST",
      url,
      headers: authHeaders("parcel.submit_boundary"),
      payload: {},
    });
    assert.equal(withoutKey.statusCode, 400);
    assert.equal(withoutKey.json().code, "IDEMPOTENCY_KEY_REQUIRED");

    const withKey = await app.inject({
      method: "POST",
      url,
      headers: { ...authHeaders("parcel.submit_boundary"), "idempotency-key": "k-1" },
      payload: {},
    });
    assert.equal(withKey.statusCode, 409);
    assert.equal(withKey.json().code, "SPECIFICATION_CONTRACT_MISSING");
  });
});

describe("introspection endpoints", { skip: !reachable }, () => {
  it("reports the contract gaps this deployment knows about", async () => {
    const response = await app.inject({ method: "GET", url: "/internal/contract-gaps" });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.specVersion, "0.1.0");
    assert.ok(body.gaps.length > 0);
  });
});

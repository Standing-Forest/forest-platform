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
    // Scoped to this file's tenant. An unqualified delete would wipe events
    // belonging to other test files running in parallel.
    const own = await db.select().from(projects).where(eq(projects.homeInstanceId, tenantId));
    for (const row of own) await db.delete(outbox).where(eq(outbox.aggregateId, row.id));
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

  it("returns 409, not 500, when publicId is already taken", async () => {
    const publicId = `dup-${newId().slice(0, 8)}`;
    const payload = { publicId, leadOrganizationId: orgId };

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: authHeaders("project.create"),
      payload,
    });
    assert.equal(first.statusCode, 201);

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: authHeaders("project.create"),
      payload,
    });
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().code, "RESOURCE_ALREADY_EXISTS");
    assert.equal(second.json().details.constraint, "projects_public_id_unique");

    // The conflict must not have left a second row or a stray event.
    const rows = await db.select().from(projects).where(eq(projects.publicId, publicId));
    assert.equal(rows.length, 1);
    const events = await db.select().from(outbox).where(eq(outbox.aggregateId, rows[0]!.id));
    assert.equal(events.length, 1);
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
  it("marks an event published and will not publish it twice", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: authHeaders("project.create"),
      payload: { publicId: `pub-${newId().slice(0, 8)}`, leadOrganizationId: orgId },
    });
    assert.equal(response.statusCode, 201);
    const aggregateId = response.json().id;

    const run = () =>
      publishBatch({ db, transport: loggingTransport(() => {}), batchSize: 100, pollIntervalMs: 0 });

    await run();
    const [afterFirst] = await db.select().from(outbox).where(eq(outbox.aggregateId, aggregateId));
    assert.ok(afterFirst?.publishedAt, "event should be marked published");

    // Asserted on this specific row rather than a global count, so parallel
    // test files creating their own events cannot make this flap.
    await run();
    const [afterSecond] = await db.select().from(outbox).where(eq(outbox.aggregateId, aggregateId));
    assert.deepEqual(
      afterSecond?.publishedAt,
      afterFirst.publishedAt,
      "a published event must not be republished",
    );
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

describe("rate limiting", { skip: !reachable }, () => {
  it("returns 429, not 500, once a caller exceeds the limit", async () => {
    // A dedicated app so this cannot consume the shared instance's budget and
    // make unrelated tests flap.
    const limited = await buildApp({ env: { ...env, rateLimitMax: 3 }, db });
    const actor = newId();

    const send = () =>
      limited.inject({
        method: "POST",
        url: "/api/v1/ai/query",
        headers: { "content-type": "application/json", "x-actor-id": actor },
        payload: {},
      });

    // Within budget: the route's own refusal, not a throttle.
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await send()).statusCode, 409);
    }

    const throttled = await send();
    assert.equal(throttled.statusCode, 429, "a throttled caller must not receive 500");
    assert.equal(throttled.json().code, "RATE_LIMIT_EXCEEDED");
    assert.equal(throttled.json().retryable, true);

    // Limits are per caller, so one abusive client cannot lock out another.
    const other = await limited.inject({
      method: "POST",
      url: "/api/v1/ai/query",
      headers: { "content-type": "application/json", "x-actor-id": newId() },
      payload: {},
    });
    assert.equal(other.statusCode, 409, "a different caller must be unaffected");

    await limited.close();
  });
});

describe("contract gap reporting", { skip: !reachable }, () => {
  it("CONTRACT-GAPS.md matches what the running app reports", async () => {
    const { readFileSync } = await import("node:fs");
    const response = await app.inject({ method: "GET", url: "/internal/contract-gaps" });
    const live: number = response.json().gaps.length;

    const doc = readFileSync("CONTRACT-GAPS.md", "utf8");
    const declared = Number(/^## (\d+) open gaps$/m.exec(doc)?.[1]);

    // The report script must import every module that registers a gap. When it
    // misses one, the file silently under-reports — run `npm run gaps`.
    assert.equal(
      declared,
      live,
      `CONTRACT-GAPS.md declares ${declared} gaps but the app reports ${live}`,
    );

    for (const gap of response.json().gaps as Array<{ operation: string }>) {
      assert.ok(doc.includes(gap.operation), `CONTRACT-GAPS.md is missing "${gap.operation}"`);
    }
  });
});

describe("introspection endpoints", { skip: !reachable }, () => {
  it("reports the contract gaps this deployment knows about", async () => {
    const response = await app.inject({ method: "GET", url: "/internal/contract-gaps" });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    // Not pinned to a literal: the version moves every time a contract is
    // approved, and asserting it here only creates busywork.
    assert.match(body.specVersion, /^\d+\.\d+\.\d+$/);
    assert.ok(body.gaps.length > 0);
  });
});

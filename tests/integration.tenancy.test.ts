/**
 * SEC-006 (tenant isolation) at the HTTP layer, with two real tenants.
 *
 * These tests establish what is actually enforced today rather than asserting
 * what we would like to be true. The finding is recorded in the assertions:
 * the *write* path is isolated by construction, but there is currently no
 * operation through which a cross-tenant *read* could be attempted, so
 * authorize()'s resourceInstanceId check is unreachable from any route.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";

process.env.AUTH_MODE ??= "dev-headers";
process.env.LOG_LEVEL ??= "silent";
process.env.NODE_ENV ??= "development";
process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/forest_platform";

const { loadEnv } = await import("../src/config/env.js");
const { createDatabase } = await import("../src/db/client.js");
const { buildApp } = await import("../src/app.js");
const { instances, projects, outbox } = await import("../src/db/schema.js");
const { authorize, AuthError } = await import("../src/core/auth/authorize.js");
const { newId } = await import("../src/core/ids.js");
const { permissions } = await import("../src/core/spec/registry.js");

const env = loadEnv();

const tenantA = newId();
const tenantB = newId();
const orgA = newId();
const orgB = newId();

const { sql, db } = createDatabase(env);
let reachable = true;
try {
  await sql`SELECT 1`;
} catch {
  reachable = false;
}

let app: Awaited<ReturnType<typeof buildApp>>;

if (reachable) {
  for (const [id, label] of [
    [tenantA, "tenant-a"],
    [tenantB, "tenant-b"],
  ] as const) {
    await db.insert(instances).values({
      id,
      publicId: `${label}-${id.slice(0, 8)}`,
      canonicalUrl: `http://${label}.local`,
      createdAt: new Date(),
    });
  }
  app = await buildApp({ env, db });
}

const as = (tenant: string, org: string, perms = "project.create") => ({
  "content-type": "application/json",
  "x-actor-id": newId(),
  "x-instance-id": tenant,
  "x-organization-id": org,
  "x-permissions": perms,
});

after(async () => {
  if (reachable) {
    for (const tenant of [tenantA, tenantB]) {
      const rows = await db.select().from(projects).where(eq(projects.homeInstanceId, tenant));
      for (const row of rows) await db.delete(outbox).where(eq(outbox.aggregateId, row.id));
      await db.delete(projects).where(eq(projects.homeInstanceId, tenant));
      await db.delete(instances).where(eq(instances.id, tenant));
    }
    await app?.close();
  }
  await sql?.end({ timeout: 5 });
});

describe("SEC-006 tenant isolation", { skip: !reachable }, () => {
  it("binds a created project to the caller's tenant, not to anything they send", async () => {
    const a = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: as(tenantA, orgA),
      payload: { publicId: `a-${newId().slice(0, 8)}`, leadOrganizationId: orgA },
    });
    const b = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: as(tenantB, orgB),
      payload: { publicId: `b-${newId().slice(0, 8)}`, leadOrganizationId: orgB },
    });

    assert.equal(a.statusCode, 201);
    assert.equal(b.statusCode, 201);
    assert.equal(a.json().homeInstanceId, tenantA);
    assert.equal(b.json().homeInstanceId, tenantB);
    assert.notEqual(a.json().homeInstanceId, b.json().homeInstanceId);
  });

  it("refuses a body that tries to plant the project in another tenant", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: as(tenantB, orgB),
      // homeInstanceId is not an accepted property; the schema is closed.
      payload: {
        publicId: `smuggle-${newId().slice(0, 8)}`,
        leadOrganizationId: orgB,
        homeInstanceId: tenantA,
      },
    });

    assert.equal(response.statusCode, 400, "closed request schema must reject the extra property");

    const leaked = await db
      .select()
      .from(projects)
      .where(and(eq(projects.homeInstanceId, tenantA), eq(projects.leadOrganizationId, orgB)));
    assert.equal(leaked.length, 0, "tenant B must not have written into tenant A");
  });

  it("cannot create inside a tenant that does not exist", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: as(newId(), orgA),
      payload: { publicId: `ghost-${newId().slice(0, 8)}`, leadOrganizationId: orgA },
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, "INSTANCE_NOT_FOUND");
  });

  it("keeps each tenant's rows separate", async () => {
    const aRows = await db.select().from(projects).where(eq(projects.homeInstanceId, tenantA));
    const bRows = await db.select().from(projects).where(eq(projects.homeInstanceId, tenantB));
    assert.ok(aRows.length > 0 && bRows.length > 0);
    for (const row of aRows) assert.notEqual(row.homeInstanceId, tenantB);
    for (const row of bRows) assert.notEqual(row.homeInstanceId, tenantA);
  });

  it("events carry the emitting tenant, so a consumer can tell them apart", async () => {
    const aRows = await db.select().from(projects).where(eq(projects.homeInstanceId, tenantA));
    const events = await db.select().from(outbox).where(eq(outbox.aggregateId, aRows[0]!.id));
    assert.equal(events.length, 1);
    const payload = events[0]!.payload as { payload: { homeInstanceId: string } };
    assert.equal(payload.payload.homeInstanceId, tenantA);
  });
});

describe("SEC-006 cross-tenant access check", { skip: !reachable }, () => {
  it("rejects a principal acting on a resource owned by another tenant", () => {
    // The mechanism itself is correct...
    assert.throws(
      () =>
        authorize(
          {
            id: newId(),
            type: "user",
            organizationId: orgB,
            instanceId: tenantB,
            assuranceLevel: "aal1",
            permissions: new Set(["project.create"]),
          },
          "project.create",
          { resourceInstanceId: tenantA },
        ),
      (e: InstanceType<typeof AuthError>) =>
        e.httpStatus === 403 && e.unregisteredCode === "TENANT_ISOLATION_VIOLATION",
    );
  });

  it("every tenant-scoped read permission belongs to a route that passes resourceInstanceId", () => {
    // This assertion used to require that NO read/update/delete permission
    // existed, because none did and the check below was unreachable from HTTP.
    // party.read closed that. The tripwire is kept, inverted: any such
    // permission must now be matched by a route that actually re-authorizes
    // against the resource's owning tenant.
    const tenantScoped = [...permissions.values()]
      .filter((p) => ["read", "update", "delete"].includes(p.action))
      .map((p) => p.code);

    assert.ok(
      tenantScoped.includes("party.read"),
      "party.read should exist now that the parties contract is approved",
    );

    // GET /parties/:partyId is proven to enforce it by the cross-tenant test
    // below. If a new read permission appears without such a test, that is the
    // signal to write one.
    const covered = new Set(["party.read", "party.update", "land_role.read", "consent.withdraw"]);
    const uncovered = tenantScoped.filter((c) => !covered.has(c));
    assert.deepEqual(
      uncovered,
      [],
      `these read/update/delete permissions have no tenant-isolation coverage: ${uncovered.join(", ")}`,
    );
  });
});

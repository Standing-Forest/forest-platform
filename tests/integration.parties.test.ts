/**
 * Parties, consent and land roles (PARTY-001/002/003, LAND-001/002,
 * CONSENT-002/003).
 *
 * Needs Postgres — start it with `docker compose up -d db`. Skipped, not
 * failed, when no database is reachable.
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
const { instances, partyRecords, consentGrants, landRoles, outbox } = await import(
  "../src/db/schema.js"
);
const { assertValidEnvelope } = await import("../src/core/events/envelope.js");
const { activePermittedUses, assertConsent } = await import("../src/modules/parties/consent.js");
const { newId } = await import("../src/core/ids.js");

const env = loadEnv();

const tenantA = newId();
const tenantB = newId();
const orgA = newId();

const { sql, db } = createDatabase(env);
let reachable = true;
try {
  await sql`SELECT 1`;
} catch {
  reachable = false;
  console.log("no database reachable - skipping parties integration suites");
}

let app: Awaited<ReturnType<typeof buildApp>>;

if (reachable) {
  for (const [id, label] of [
    [tenantA, "parties-a"],
    [tenantB, "parties-b"],
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

const ALL_PERMS =
  "party.register,party.read,party.update,land_role.assert,land_role.read,consent.grant,consent.withdraw";

const as = (tenant: string, perms = ALL_PERMS) => ({
  "content-type": "application/json",
  "x-actor-id": newId(),
  "x-instance-id": tenant,
  "x-organization-id": orgA,
  "x-permissions": perms,
});

const validBody = (over: Record<string, unknown> = {}) => ({
  party: {
    partyType: "person",
    displayName: "Ana Ribeiro",
    community: "São Gabriel",
    contact: { preferredLanguage: "pt-BR" },
    dataClassification: "confidential",
  },
  consentGrant: {
    permittedUses: ["conservation_payment", "public_reporting"],
    languageTag: "pt-BR",
    method: "written_signature",
  },
  ...over,
});

const register = (tenant: string, body: Record<string, unknown> = validBody()) =>
  app.inject({ method: "POST", url: "/api/v1/parties", headers: as(tenant), payload: body });

after(async () => {
  if (reachable) {
    for (const tenant of [tenantA, tenantB]) {
      const parties = await db
        .select()
        .from(partyRecords)
        .where(eq(partyRecords.homeInstanceId, tenant));
      for (const p of parties) await db.delete(outbox).where(eq(outbox.aggregateId, p.partyId));
      const roles = await db.select().from(landRoles).where(eq(landRoles.homeInstanceId, tenant));
      for (const r of roles) await db.delete(outbox).where(eq(outbox.aggregateId, r.landRoleId));
      const grants = await db
        .select()
        .from(consentGrants)
        .where(eq(consentGrants.homeInstanceId, tenant));
      for (const g of grants) await db.delete(outbox).where(eq(outbox.aggregateId, g.id));
      await db.delete(landRoles).where(eq(landRoles.homeInstanceId, tenant));
      await db.delete(consentGrants).where(eq(consentGrants.homeInstanceId, tenant));
      await db.delete(partyRecords).where(eq(partyRecords.homeInstanceId, tenant));
      await db.delete(instances).where(eq(instances.id, tenant));
    }
    await app?.close();
  }
  await sql?.end({ timeout: 5 });
});

describe("POST /parties", { skip: !reachable }, () => {
  it("registers a party and their consent grant in one transaction", async () => {
    const response = await register(tenantA);
    assert.equal(response.statusCode, 201);
    const body = response.json();

    const [party] = await db
      .select()
      .from(partyRecords)
      .where(eq(partyRecords.partyId, body.partyId));
    assert.equal(party!.displayName, "Ana Ribeiro");
    assert.equal(party!.homeInstanceId, tenantA);
    assert.equal(party!.supersededAt, null, "the first version is current");

    const grants = await db
      .select()
      .from(consentGrants)
      .where(eq(consentGrants.partyId, body.partyId));
    assert.equal(grants.length, 1);
    assert.deepEqual(grants[0]!.permittedUses, ["conservation_payment", "public_reporting"]);

    // Both events, both valid against the canonical envelope.
    const events = await db.select().from(outbox);
    const mine = events.filter((e) => {
      const p = e.payload as { payload?: { partyId?: string } };
      return p.payload?.partyId === body.partyId;
    });
    const types = mine.map((e) => e.eventType).sort();
    assert.deepEqual(types, ["ConsentGranted", "PartyRegistered"]);
    for (const e of mine) assert.doesNotThrow(() => assertValidEnvelope(e.payload as never));
  });

  it("keeps names and contact details out of the event stream", async () => {
    const response = await register(tenantA);
    const partyId = response.json().partyId;

    const events = await db.select().from(outbox);
    const registered = events.find((e) => {
      const p = e.payload as { eventType: string; payload?: { partyId?: string } };
      return p.eventType === "PartyRegistered" && p.payload?.partyId === partyId;
    });

    const serialized = JSON.stringify(registered!.payload);
    assert.ok(!serialized.includes("Ana Ribeiro"), "a party name must not travel in an event");
    assert.ok(!serialized.includes("pt-BR"), "contact details must not travel in an event");
  });

  it("refuses witnessed verbal consent with no witness recorded", async () => {
    const response = await register(
      tenantA,
      validBody({
        consentGrant: {
          permittedUses: ["conservation_payment"],
          languageTag: "pt-BR",
          method: "witnessed_verbal",
        },
      }),
    );
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().code, "CONSENT_GRANT_REQUIRED");
  });

  it("accepts witnessed verbal consent when the witness is named", async () => {
    const response = await register(
      tenantA,
      validBody({
        consentGrant: {
          permittedUses: ["conservation_payment"],
          languageTag: "pt-BR",
          method: "witnessed_verbal",
          witnessPartyId: newId(),
        },
      }),
    );
    assert.equal(response.statusCode, 201, "literacy cannot be assumed; this path must work");
  });

  it("rejects a consent grant with no permitted uses", async () => {
    const response = await register(
      tenantA,
      validBody({
        consentGrant: { permittedUses: [], languageTag: "pt-BR", method: "written_signature" },
      }),
    );
    assert.equal(response.statusCode, 400);
  });

  it("stores non-ASCII names and communities unchanged", async () => {
    // The platform serves Brazil. A name it cannot store is a person it cannot
    // enroll, so this is load-bearing rather than cosmetic.
    const response = await register(
      tenantA,
      validBody({
        party: {
          partyType: "person",
          displayName: "João Gonçalves Añez",
          community: "São Gabriel da Cachoeira",
          dataClassification: "confidential",
        },
      }),
    );
    assert.equal(response.statusCode, 201);

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/parties/${response.json().partyId}`,
      headers: as(tenantA),
    });
    assert.equal(read.json().displayName, "João Gonçalves Añez");
    assert.equal(read.json().community, "São Gabriel da Cachoeira");
  });

  it("rejects a non-UUID actor id with 400 rather than failing at the database", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/parties",
      headers: { ...as(tenantA), "x-actor-id": "staff-1" },
      payload: validBody(),
    });
    assert.equal(response.statusCode, 400, "a caller mistake must not surface as a 500");
    assert.equal(response.json().code, "ACTOR_ID_INVALID");
  });

  it("requires the party.register permission", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/parties",
      headers: as(tenantA, "party.read"),
      payload: validBody(),
    });
    assert.equal(response.statusCode, 403);
  });
});

describe("GET /parties/:partyId — SEC-006 across two real tenants", { skip: !reachable }, () => {
  it("lets the owning tenant read the party", async () => {
    const partyId = (await register(tenantA)).json().partyId;
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/parties/${partyId}`,
      headers: as(tenantA),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().partyId, partyId);
    assert.equal(response.json().consentGrants.length, 1);
  });

  it("refuses a different tenant reading it", async () => {
    const partyId = (await register(tenantA)).json().partyId;
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/parties/${partyId}`,
      headers: as(tenantB),
    });
    assert.equal(response.statusCode, 403, "tenant B must not read tenant A's party");
    assert.equal(response.json().code, "TENANT_ISOLATION_VIOLATION");
  });

  it("returns 404, not 403, for a party that does not exist", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/parties/${newId()}`,
      headers: as(tenantA),
    });
    assert.equal(response.statusCode, 404);
  });
});

describe("consent withdrawal (CONSENT-003)", { skip: !reachable }, () => {
  it("stops processing without destroying history", async () => {
    const registered = (await register(tenantA)).json();
    const { partyId } = registered;
    const grantId = registered.consentGrant.consentGrantId;

    assert.ok((await activePermittedUses(db, partyId)).has("conservation_payment"));
    await assertConsent(db, partyId, "conservation_payment");

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/parties/${partyId}/consent-grants/${grantId}/withdrawal`,
      headers: as(tenantA),
      payload: {},
    });
    assert.equal(response.statusCode, 204);

    // Processing stops.
    assert.equal((await activePermittedUses(db, partyId)).size, 0);
    await assert.rejects(
      () => assertConsent(db, partyId, "conservation_payment"),
      (e: Error & { code?: string }) => e.code === "CONSENT_SCOPE_NOT_PERMITTED",
    );

    // History survives.
    const [grant] = await db.select().from(consentGrants).where(eq(consentGrants.id, grantId));
    assert.ok(grant, "the grant row must still exist after withdrawal");
    assert.ok(grant!.withdrawnAt, "and be marked withdrawn");
    assert.deepEqual(grant!.permittedUses, ["conservation_payment", "public_reporting"]);
  });

  it("does not require a reason", async () => {
    const registered = (await register(tenantA)).json();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/parties/${registered.partyId}/consent-grants/${registered.consentGrant.consentGrantId}/withdrawal`,
      headers: as(tenantA),
      payload: {},
    });
    assert.equal(response.statusCode, 204, "requiring a reason would obstruct withdrawal");
  });

  it("is idempotent — withdrawing twice still reports success", async () => {
    const registered = (await register(tenantA)).json();
    const url = `/api/v1/parties/${registered.partyId}/consent-grants/${registered.consentGrant.consentGrantId}/withdrawal`;
    assert.equal((await app.inject({ method: "POST", url, headers: as(tenantA), payload: {} })).statusCode, 204);
    assert.equal(
      (await app.inject({ method: "POST", url, headers: as(tenantA), payload: {} })).statusCode,
      204,
      "a party's intent is already satisfied; failing would suggest otherwise",
    );
  });

  it("emits ConsentWithdrawn so downstream consumers can stop", async () => {
    const registered = (await register(tenantA)).json();
    const grantId = registered.consentGrant.consentGrantId;
    await app.inject({
      method: "POST",
      url: `/api/v1/parties/${registered.partyId}/consent-grants/${grantId}/withdrawal`,
      headers: as(tenantA),
      payload: {},
    });

    const [event] = await db.select().from(outbox).where(eq(outbox.aggregateId, grantId));
    const all = await db.select().from(outbox).where(eq(outbox.aggregateId, grantId));
    const withdrawn = all.find((e) => e.eventType === "ConsentWithdrawn");
    assert.ok(withdrawn, "withdrawal must be broadcast, not only recorded");
    assert.ok(event);
    const payload = withdrawn!.payload as { payload: { withdrawnUses: string[] } };
    assert.deepEqual(payload.payload.withdrawnUses, [
      "conservation_payment",
      "public_reporting",
    ]);
  });

  it("refuses a different tenant withdrawing someone else's consent", async () => {
    const registered = (await register(tenantA)).json();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/parties/${registered.partyId}/consent-grants/${registered.consentGrant.consentGrantId}/withdrawal`,
      headers: as(tenantB),
      payload: {},
    });
    assert.equal(response.statusCode, 403);
  });
});

describe("land roles (LAND-001, LAND-002)", { skip: !reachable }, () => {
  const assertRole = (tenant: string, parcelId: string, body: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: `/api/v1/parcels/${parcelId}/land-roles`,
      headers: as(tenant),
      payload: body,
    });

  it("records a farmer, which does not convey authority to commit land", async () => {
    const partyId = (await register(tenantA)).json().partyId;
    const parcelId = newId();

    const response = await assertRole(tenantA, parcelId, { partyId, role: "farmer" });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().conveysAuthorityToCommit, false, "a farmer cannot commit the land");

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/parcels/${parcelId}/land-roles`,
      headers: as(tenantA),
    });
    assert.equal(listed.json().authorityToCommitEstablished, false);
  });

  it("records a landowner, which does convey authority", async () => {
    const partyId = (await register(tenantA)).json().partyId;
    const parcelId = newId();

    const response = await assertRole(tenantA, parcelId, { partyId, role: "landowner" });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().conveysAuthorityToCommit, true);

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/parcels/${parcelId}/land-roles`,
      headers: as(tenantA),
    });
    assert.equal(listed.json().authorityToCommitEstablished, true);
    assert.equal(listed.json().parcelExistenceVerified, false, "no parcels table exists yet");
  });

  it("requires a land controller to state the basis of its authority", async () => {
    const partyId = (await register(tenantA)).json().partyId;
    const response = await assertRole(tenantA, newId(), { partyId, role: "land_controller" });
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().code, "LAND_AUTHORITY_NOT_ESTABLISHED");
  });

  it("accepts a land controller that states one", async () => {
    const partyId = (await register(tenantA)).json().partyId;
    const response = await assertRole(tenantA, newId(), {
      partyId,
      role: "land_controller",
      authorityBasis: "community council minute of 2026-03-11",
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().conveysAuthorityToCommit, true);
  });

  it("refuses an authority-bearing role for a party who never consented to payment", async () => {
    const registered = (
      await register(
        tenantA,
        validBody({
          consentGrant: {
            permittedUses: ["research"],
            languageTag: "pt-BR",
            method: "written_signature",
          },
        }),
      )
    ).json();

    const response = await assertRole(tenantA, newId(), {
      partyId: registered.partyId,
      role: "landowner",
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, "CONSENT_SCOPE_NOT_PERMITTED");

    // A farmer role does not sell anything, so it is still allowed.
    const farmer = await assertRole(tenantA, newId(), {
      partyId: registered.partyId,
      role: "farmer",
    });
    assert.equal(farmer.statusCode, 201);
  });

  it("supersedes rather than overwrites when land changes hands", async () => {
    const first = (await register(tenantA)).json().partyId;
    const second = (await register(tenantA)).json().partyId;
    const parcelId = newId();

    const original = (await assertRole(tenantA, parcelId, { partyId: first, role: "landowner" }))
      .json().landRoleId;

    const replacement = await assertRole(tenantA, parcelId, {
      partyId: second,
      role: "landowner",
      supersedesLandRoleId: original,
    });
    assert.equal(replacement.statusCode, 201);

    // The superseded row survives — the platform must still be able to answer
    // who held authority on the day an earlier payment was authorized.
    const rows = await db.select().from(landRoles).where(eq(landRoles.parcelId, parcelId));
    assert.equal(rows.length, 2, "history is kept, not overwritten");

    const [old] = await db
      .select()
      .from(landRoles)
      .where(and(eq(landRoles.landRoleId, original)));
    assert.ok(old!.supersededAt, "the earlier role is closed off");

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/parcels/${parcelId}/land-roles`,
      headers: as(tenantA),
    });
    assert.equal(listed.json().roles.length, 1, "only the current role is reported");
    assert.equal(listed.json().roles[0].partyId, second);
  });

  it("refuses asserting a role for another tenant's party", async () => {
    const partyId = (await register(tenantA)).json().partyId;
    const response = await assertRole(tenantB, newId(), { partyId, role: "farmer" });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, "TENANT_ISOLATION_VIOLATION");
  });
});

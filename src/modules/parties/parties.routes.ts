/**
 * PARTY-001/002/003, CONSENT-002/003 — people and organizations, and what they
 * agreed to.
 *
 * Registration and consent are one transaction on purpose. CONSENT-002 says a
 * party must not enter the platform without a grant naming what they agreed to,
 * and two separate calls would leave a window in which a person exists in the
 * system having consented to nothing.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Env } from "../../config/env.js";
import { authorize } from "../../core/auth/authorize.js";
import { AppError } from "../../core/errors/app-error.js";
import { UnregisteredError } from "../../core/errors/unregistered.js";
import { emitEvent, nextAggregateSequence } from "../../core/events/outbox.js";
import { newId } from "../../core/ids.js";
import { assertKnownRequirements } from "../../core/spec/registry.js";
import type { Database } from "../../db/client.js";
import { consentGrants, instances, partyRecords } from "../../db/schema.js";
import { CONSENT_METHODS, PERMITTED_USES, type PermittedUse } from "./consent.js";

const REGISTER_REQUIREMENTS = ["PARTY-001", "PARTY-002", "CONSENT-002"];
const READ_REQUIREMENTS = ["PARTY-001", "PARTY-003"];
const WITHDRAW_REQUIREMENTS = ["CONSENT-003"];
assertKnownRequirements(REGISTER_REQUIREMENTS, "POST /parties");
assertKnownRequirements(READ_REQUIREMENTS, "GET /parties/{partyId}");
assertKnownRequirements(WITHDRAW_REQUIREMENTS, "POST /parties/../withdrawal");

const evidenceRefSchema = {
  type: "object",
  additionalProperties: false,
  required: ["evidenceAssetId", "checksumSha256", "kind"],
  properties: {
    evidenceAssetId: { type: "string", format: "uuid" },
    checksumSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    kind: { type: "string", maxLength: 120 },
  },
} as const;

const registerPartyBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["party", "consentGrant"],
  properties: {
    party: {
      type: "object",
      additionalProperties: false,
      required: ["partyType", "displayName", "dataClassification"],
      properties: {
        partyType: { enum: ["person", "organization"] },
        displayName: { type: "string", minLength: 1, maxLength: 200 },
        community: { type: "string", maxLength: 200 },
        contact: {
          type: "object",
          additionalProperties: false,
          properties: {
            phone: { type: "string", maxLength: 40 },
            email: { type: "string", format: "email" },
            preferredLanguage: { type: "string", maxLength: 35 },
          },
        },
        identityEvidence: { type: "array", items: evidenceRefSchema },
        dataClassification: { enum: ["confidential", "restricted", "cultural_restricted"] },
        validFrom: { type: "string", format: "date-time" },
      },
    },
    consentGrant: {
      type: "object",
      additionalProperties: false,
      required: ["permittedUses", "languageTag", "method"],
      properties: {
        permittedUses: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { enum: [...PERMITTED_USES] },
        },
        languageTag: { type: "string", minLength: 2, maxLength: 35 },
        method: { enum: [...CONSENT_METHODS] },
        witnessPartyId: { type: "string", format: "uuid" },
        scopeParcelId: { type: "string", format: "uuid" },
        grantedAt: { type: "string", format: "date-time" },
        evidence: {
          type: "object",
          additionalProperties: false,
          required: ["evidenceAssetId", "checksumSha256"],
          properties: {
            evidenceAssetId: { type: "string", format: "uuid" },
            checksumSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
        },
      },
    },
  },
} as const;

interface RegisterPartyBody {
  party: {
    partyType: "person" | "organization";
    displayName: string;
    community?: string;
    contact?: Record<string, string>;
    identityEvidence?: Array<Record<string, string>>;
    dataClassification: "confidential" | "restricted" | "cultural_restricted";
    validFrom?: string;
  };
  consentGrant: {
    permittedUses: PermittedUse[];
    languageTag: string;
    method: (typeof CONSENT_METHODS)[number];
    witnessPartyId?: string;
    scopeParcelId?: string;
    grantedAt?: string;
    evidence?: { evidenceAssetId: string; checksumSha256: string };
  };
}

export function registerPartyRoutes(app: FastifyInstance, deps: { db: Database; env: Env }): void {
  const { db, env } = deps;

  /* ------------------------------------------------------------------ */
  /* POST /parties                                                       */
  /* ------------------------------------------------------------------ */
  app.post<{ Body: RegisterPartyBody }>(
    "/parties",
    {
      schema: { body: registerPartyBodySchema },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const principal = request.principal;
      authorize(principal, "party.register");
      if (!principal) throw new Error("unreachable");

      const { party, consentGrant } = request.body;

      // Witnessed verbal consent exists because literacy cannot be assumed. It
      // is only meaningful if the witness is recorded, so this is refused here
      // as well as by the database — the caller deserves a clear reason.
      if (consentGrant.method === "witnessed_verbal" && !consentGrant.witnessPartyId) {
        throw new AppError(
          "CONSENT_GRANT_REQUIRED",
          "Witnessed verbal consent requires the witness to be identified",
          { method: consentGrant.method },
        );
      }

      const [homeInstance] = await db
        .select()
        .from(instances)
        .where(eq(instances.id, principal.instanceId))
        .limit(1);

      if (!homeInstance) {
        throw new UnregisteredError(
          404,
          "INSTANCE_NOT_FOUND",
          `Home instance '${principal.instanceId}' does not exist`,
          { instanceId: principal.instanceId },
        );
      }

      const partyId = newId();
      const consentGrantId = newId();
      const now = new Date();
      const validFrom = party.validFrom ? new Date(party.validFrom) : now;
      const grantedAt = consentGrant.grantedAt ? new Date(consentGrant.grantedAt) : now;

      const created = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(partyRecords)
          .values({
            id: newId(),
            partyId,
            homeInstanceId: principal.instanceId,
            partyType: party.partyType,
            displayName: party.displayName,
            community: party.community ?? null,
            contact: party.contact ?? {},
            identityEvidence: party.identityEvidence ?? [],
            dataClassification: party.dataClassification,
            validFrom,
            validTo: null,
            recordedAt: now,
            supersededAt: null,
          })
          .returning();

        await tx.insert(consentGrants).values({
          id: consentGrantId,
          homeInstanceId: principal.instanceId,
          partyId,
          scopeParcelId: consentGrant.scopeParcelId ?? null,
          permittedUses: consentGrant.permittedUses,
          grantedAt,
          languageTag: consentGrant.languageTag,
          method: consentGrant.method,
          witnessPartyId: consentGrant.witnessPartyId ?? null,
          evidence: consentGrant.evidence ?? null,
          withdrawnAt: null,
          withdrawalReason: null,
          recordedAt: now,
        });

        const actor = {
          type: principal.type,
          id: principal.id,
          organizationId: principal.organizationId,
        };
        const common = {
          actor,
          correlationId: request.correlationId,
          sourceInstanceId: env.instanceId,
          sourceService: env.serviceName,
        };

        await emitEvent(tx, {
          ...common,
          eventType: "PartyRegistered",
          aggregateType: "Party",
          aggregateId: partyId,
          aggregateSequence: await nextAggregateSequence(tx, "Party", partyId),
          // The party record itself is confidential or tighter, and the event
          // carries no name or contact — but the classification travels with it
          // so a consumer knows what it is handling.
          dataClassification: party.dataClassification,
          requirementIds: ["PARTY-001", "CONSENT-002"],
          payload: {
            partyId,
            homeInstanceId: principal.instanceId,
            partyType: party.partyType,
            ...(party.community ? { community: party.community } : {}),
            consentGrantId,
          },
        });

        await emitEvent(tx, {
          ...common,
          eventType: "ConsentGranted",
          aggregateType: "ConsentGrant",
          aggregateId: consentGrantId,
          aggregateSequence: await nextAggregateSequence(tx, "ConsentGrant", consentGrantId),
          dataClassification: party.dataClassification,
          requirementIds: ["CONSENT-002"],
          payload: {
            consentGrantId,
            homeInstanceId: principal.instanceId,
            partyId,
            scopeParcelId: consentGrant.scopeParcelId ?? null,
            permittedUses: consentGrant.permittedUses,
            grantedAt: grantedAt.toISOString(),
            languageTag: consentGrant.languageTag,
            method: consentGrant.method,
          },
        });

        return row;
      });

      return reply.status(201).send({
        partyId: created.partyId,
        homeInstanceId: created.homeInstanceId,
        partyType: created.partyType,
        displayName: created.displayName,
        community: created.community,
        dataClassification: created.dataClassification,
        validFrom: created.validFrom,
        consentGrant: {
          consentGrantId,
          permittedUses: consentGrant.permittedUses,
          languageTag: consentGrant.languageTag,
          method: consentGrant.method,
          grantedAt,
        },
      });
    },
  );

  /* ------------------------------------------------------------------ */
  /* GET /parties/:partyId                                               */
  /* ------------------------------------------------------------------ */
  app.get<{ Params: { partyId: string } }>(
    "/parties/:partyId",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      // Permission first, without the resource: a caller lacking party.read
      // must not learn whether a party exists by probing ids.
      authorize(request.principal, "party.read");

      const [record] = await db
        .select()
        .from(partyRecords)
        .where(
          and(
            eq(partyRecords.partyId, request.params.partyId),
            isNull(partyRecords.supersededAt),
          ),
        )
        .orderBy(desc(partyRecords.recordedAt))
        .limit(1);

      if (!record) {
        throw new UnregisteredError(404, "PARTY_NOT_FOUND", "No such party", {
          partyId: request.params.partyId,
        });
      }

      // SEC-006. Now that the resource is known, re-authorize against its
      // owning tenant. This is the first operation in the platform that can
      // reach this check — every earlier one either created a resource or was
      // a stub.
      authorize(request.principal, "party.read", {
        resourceInstanceId: record.homeInstanceId,
      });

      const grants = await db
        .select()
        .from(consentGrants)
        .where(eq(consentGrants.partyId, record.partyId));

      return {
        partyId: record.partyId,
        homeInstanceId: record.homeInstanceId,
        partyType: record.partyType,
        displayName: record.displayName,
        community: record.community,
        contact: record.contact,
        identityEvidence: record.identityEvidence,
        dataClassification: record.dataClassification,
        validFrom: record.validFrom,
        validTo: record.validTo,
        consentGrants: grants.map((g) => ({
          consentGrantId: g.id,
          permittedUses: g.permittedUses,
          languageTag: g.languageTag,
          method: g.method,
          grantedAt: g.grantedAt,
          withdrawnAt: g.withdrawnAt,
          active: g.withdrawnAt === null,
        })),
      };
    },
  );

  /* ------------------------------------------------------------------ */
  /* POST /parties/:partyId/consent-grants/:consentGrantId/withdrawal     */
  /* ------------------------------------------------------------------ */
  app.post<{
    Params: { partyId: string; consentGrantId: string };
    Body: { reason?: string };
  }>(
    "/parties/:partyId/consent-grants/:consentGrantId/withdrawal",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          // Optional, and it must stay that way: requiring a reason to withdraw
          // is a form of obstruction.
          properties: { reason: { type: "string", maxLength: 2000 } },
        },
      },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const principal = request.principal;
      authorize(principal, "consent.withdraw");
      if (!principal) throw new Error("unreachable");

      const { partyId, consentGrantId } = request.params;

      const [grant] = await db
        .select()
        .from(consentGrants)
        .where(and(eq(consentGrants.id, consentGrantId), eq(consentGrants.partyId, partyId)))
        .limit(1);

      if (!grant) {
        throw new UnregisteredError(404, "CONSENT_GRANT_NOT_FOUND", "No such consent grant", {
          partyId,
          consentGrantId,
        });
      }

      authorize(principal, "consent.withdraw", {
        resourceInstanceId: grant.homeInstanceId,
      });

      // Withdrawing an already-withdrawn grant is not an error. The party's
      // intent is already satisfied, and returning a failure would suggest
      // their withdrawal did not take effect.
      if (grant.withdrawnAt) {
        return reply.status(204).send();
      }

      const now = new Date();
      await db.transaction(async (tx) => {
        await tx
          .update(consentGrants)
          .set({ withdrawnAt: now, withdrawalReason: request.body?.reason ?? null })
          .where(eq(consentGrants.id, consentGrantId));

        await emitEvent(tx, {
          eventType: "ConsentWithdrawn",
          aggregateType: "ConsentGrant",
          aggregateId: consentGrantId,
          aggregateSequence: await nextAggregateSequence(tx, "ConsentGrant", consentGrantId),
          requirementIds: ["CONSENT-003"],
          actor: {
            type: principal.type,
            id: principal.id,
            organizationId: principal.organizationId,
          },
          correlationId: request.correlationId,
          // Consumers must act on this, so it is never more restricted than the
          // grant it revokes.
          dataClassification: "confidential",
          sourceInstanceId: env.instanceId,
          sourceService: env.serviceName,
          payload: {
            consentGrantId,
            homeInstanceId: grant.homeInstanceId,
            partyId,
            withdrawnUses: grant.permittedUses,
            withdrawnAt: now.toISOString(),
          },
        });
      });

      return reply.status(204).send();
    },
  );
}

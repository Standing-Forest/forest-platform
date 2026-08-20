/**
 * LAND-001, LAND-002 — who is the farmer, the landowner, and the controller of
 * a parcel.
 *
 * These are roles a party holds over land, not three kinds of person. One human
 * is often both farmer and landowner; a controller frequently is neither the
 * registered owner nor the farmer. Modelling them as a relationship is what
 * makes the question that actually matters answerable: who may consent to
 * conservation on this parcel.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Env } from "../../config/env.js";
import { authorize } from "../../core/auth/authorize.js";
import { AppError } from "../../core/errors/app-error.js";
import { UnregisteredError } from "../../core/errors/unregistered.js";
import { emitEvent, nextAggregateSequence } from "../../core/events/outbox.js";
import { newId } from "../../core/ids.js";
import { registerContractGap } from "../../core/spec/contract-gap.js";
import { assertKnownRequirements } from "../../core/spec/registry.js";
import type { Database } from "../../db/client.js";
import { consentGrants, landRoles, partyRecords } from "../../db/schema.js";

const REQUIREMENT_IDS = ["LAND-001", "LAND-002"];
assertKnownRequirements(REQUIREMENT_IDS, "POST /parcels/{parcelId}/land-roles");

/** Roles that let their holder commit the land to conservation (LAND-002). */
const AUTHORITY_BEARING_ROLES = ["landowner", "land_controller"] as const;

registerContractGap({
  operation: "land role parcel references are unenforced",
  missingArtifacts: ["table forests.parcels (GEO-001)"],
  blockedRequirementIds: ["LAND-001", "LAND-002"],
  notes:
    "A land role names the parcel it applies to, but forests.parcels does not exist, so the " +
    "reference has no foreign key and a role can be asserted over a parcel id that " +
    "corresponds to nothing. Approving the land-and-trees contract creates the table and " +
    "adds the constraint. Until then, treat parcel ids in parties.land_roles as unverified.",
});

const landRoleBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["partyId", "role"],
  properties: {
    partyId: { type: "string", format: "uuid" },
    role: { enum: ["farmer", "landowner", "land_controller"] },
    authorityBasis: { type: "string", minLength: 1, maxLength: 500 },
    exclusive: { type: "boolean" },
    supportingEvidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["evidenceAssetId", "checksumSha256"],
        properties: {
          evidenceAssetId: { type: "string", format: "uuid" },
          checksumSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          kind: { type: "string", maxLength: 120 },
        },
      },
    },
    supersedesLandRoleId: { type: "string", format: "uuid" },
    validFrom: { type: "string", format: "date-time" },
    validTo: { type: "string", format: "date-time" },
  },
} as const;

interface LandRoleBody {
  partyId: string;
  role: "farmer" | "landowner" | "land_controller";
  authorityBasis?: string;
  exclusive?: boolean;
  supportingEvidence?: Array<Record<string, string>>;
  supersedesLandRoleId?: string;
  validFrom?: string;
  validTo?: string;
}

export function registerLandRoleRoutes(
  app: FastifyInstance,
  deps: { db: Database; env: Env },
): void {
  const { db, env } = deps;

  app.post<{ Params: { parcelId: string }; Body: LandRoleBody }>(
    "/parcels/:parcelId/land-roles",
    {
      schema: { body: landRoleBodySchema },
      // Determines who may commit land and, downstream, who is paid. A prime
      // fraud target, so the ceiling is low.
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const principal = request.principal;
      authorize(principal, "land_role.assert");
      if (!principal) throw new Error("unreachable");

      const { parcelId } = request.params;
      const body = request.body;

      if (body.role === "land_controller" && !body.authorityBasis) {
        throw new AppError(
          "LAND_AUTHORITY_NOT_ESTABLISHED",
          "A land controller must state the basis on which it holds authority",
          { role: body.role },
        );
      }

      const [party] = await db
        .select()
        .from(partyRecords)
        .where(and(eq(partyRecords.partyId, body.partyId), isNull(partyRecords.supersededAt)))
        .limit(1);

      if (!party) {
        throw new UnregisteredError(404, "PARTY_NOT_FOUND", "No such party", {
          partyId: body.partyId,
        });
      }

      // SEC-006: the party must belong to the caller's tenant.
      authorize(principal, "land_role.assert", { resourceInstanceId: party.homeInstanceId });

      // An authority-bearing role is the basis on which conservation gets sold
      // to a sponsor. Asserting one for a party who never consented to
      // conservation payments would manufacture authority they did not give.
      const conveysAuthority = (AUTHORITY_BEARING_ROLES as readonly string[]).includes(body.role);
      if (conveysAuthority) {
        const grants = await db
          .select({ permittedUses: consentGrants.permittedUses })
          .from(consentGrants)
          .where(
            and(eq(consentGrants.partyId, body.partyId), isNull(consentGrants.withdrawnAt)),
          );
        const consented = grants.some((g) =>
          (g.permittedUses as string[]).includes("conservation_payment"),
        );
        if (!consented) {
          throw new AppError(
            "CONSENT_SCOPE_NOT_PERMITTED",
            `Cannot record '${body.role}' for a party without live consent to conservation payment`,
            { partyId: body.partyId, role: body.role, requiredUse: "conservation_payment" },
          );
        }
      }

      const landRoleId = newId();
      const now = new Date();
      const validFrom = body.validFrom ? new Date(body.validFrom) : now;

      const created = await db.transaction(async (tx) => {
        // Supersede rather than overwrite (ARCH-003): land is sold, tenancies
        // end, controllers are replaced, and the platform must still be able to
        // answer who held authority on the day a payment was authorized.
        if (body.supersedesLandRoleId) {
          await tx
            .update(landRoles)
            .set({ supersededAt: now })
            .where(
              and(
                eq(landRoles.landRoleId, body.supersedesLandRoleId),
                isNull(landRoles.supersededAt),
              ),
            );
        }

        const [row] = await tx
          .insert(landRoles)
          .values({
            id: newId(),
            landRoleId,
            homeInstanceId: party.homeInstanceId,
            partyId: body.partyId,
            parcelId,
            role: body.role,
            authorityBasis: body.authorityBasis ?? null,
            conveysAuthorityToCommit: conveysAuthority,
            exclusive: body.exclusive ?? false,
            supportingEvidence: body.supportingEvidence ?? [],
            assertedBy: principal.id,
            supersedesLandRoleId: body.supersedesLandRoleId ?? null,
            validFrom,
            validTo: body.validTo ? new Date(body.validTo) : null,
            recordedAt: now,
            supersededAt: null,
          })
          .returning();

        await emitEvent(tx, {
          eventType: "LandRoleAsserted",
          aggregateType: "LandRole",
          aggregateId: landRoleId,
          aggregateSequence: await nextAggregateSequence(tx, "LandRole", landRoleId),
          requirementIds: REQUIREMENT_IDS,
          actor: {
            type: principal.type,
            id: principal.id,
            organizationId: principal.organizationId,
          },
          correlationId: request.correlationId,
          dataClassification: "confidential",
          sourceInstanceId: env.instanceId,
          sourceService: env.serviceName,
          payload: {
            landRoleId,
            homeInstanceId: party.homeInstanceId,
            partyId: body.partyId,
            parcelId,
            role: body.role,
            ...(body.authorityBasis ? { authorityBasis: body.authorityBasis } : {}),
            conveysAuthorityToCommit: conveysAuthority,
            exclusive: body.exclusive ?? false,
            supersedesLandRoleId: body.supersedesLandRoleId ?? null,
            validFrom: validFrom.toISOString(),
            validTo: body.validTo ?? null,
          },
        });

        return row;
      });

      return reply.status(201).send({
        landRoleId: created.landRoleId,
        partyId: created.partyId,
        parcelId: created.parcelId,
        role: created.role,
        authorityBasis: created.authorityBasis,
        conveysAuthorityToCommit: created.conveysAuthorityToCommit,
        exclusive: created.exclusive,
        validFrom: created.validFrom,
        validTo: created.validTo,
      });
    },
  );

  /**
   * Who holds which role over this parcel, and does anyone have authority to
   * commit it. LAND-002 exists so that this question has an answer before
   * conservation is sold to a sponsor.
   */
  app.get<{ Params: { parcelId: string } }>(
    "/parcels/:parcelId/land-roles",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      const principal = request.principal;
      authorize(principal, "land_role.read");
      if (!principal) throw new Error("unreachable");

      const rows = await db
        .select()
        .from(landRoles)
        .where(
          and(
            eq(landRoles.parcelId, request.params.parcelId),
            eq(landRoles.homeInstanceId, principal.instanceId),
            isNull(landRoles.supersededAt),
          ),
        );

      return {
        parcelId: request.params.parcelId,
        // The whole point of LAND-002, stated plainly rather than left for the
        // caller to re-derive from the role list.
        authorityToCommitEstablished: rows.some((r) => r.conveysAuthorityToCommit),
        parcelExistenceVerified: false,
        roles: rows.map((r) => ({
          landRoleId: r.landRoleId,
          partyId: r.partyId,
          role: r.role,
          authorityBasis: r.authorityBasis,
          conveysAuthorityToCommit: r.conveysAuthorityToCommit,
          exclusive: r.exclusive,
          validFrom: r.validFrom,
          validTo: r.validTo,
        })),
      };
    },
  );
}

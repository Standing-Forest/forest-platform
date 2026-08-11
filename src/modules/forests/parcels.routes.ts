/**
 * GEO-001 — POST /parcels/{parcelId}/boundaries.
 *
 * The operation is declared in the OpenAPI and traceability.csv names both its
 * table (forests.parcel_boundaries) and its event (ParcelBoundarySubmitted),
 * but neither the table nor any boundary/geometry schema exists in the approved
 * package. 0001_foundation.sql creates only instances, projects and outbox.
 *
 * Everything that *is* specified still runs — authorization, tenant isolation,
 * and the x-idempotency-required contract — and then the request is refused
 * with SPECIFICATION_CONTRACT_MISSING naming exactly what is absent. Guessing a
 * boundary schema here would be the DEV-AI-001 violation.
 */
import type { FastifyInstance } from "fastify";
import { authorize } from "../../core/auth/authorize.js";
import { UnregisteredError } from "../../core/errors/unregistered.js";
import { contractMissing, registerContractGap } from "../../core/spec/contract-gap.js";
import { assertKnownRequirements } from "../../core/spec/registry.js";

const REQUIREMENT_IDS = ["GEO-001", "EVID-001"];
assertKnownRequirements(REQUIREMENT_IDS, "POST /parcels/{parcelId}/boundaries");

// Registered at module load, not on first request, so the gap report lists it
// whether or not anyone has called the endpoint.
const BOUNDARY_GAP = registerContractGap({
  operation: "POST /parcels/{parcelId}/boundaries (submitParcelBoundary)",
  missingArtifacts: [
    "table forests.parcels",
    "table forests.parcel_boundaries (append-only, per GEO-001)",
    "schemas/forests/parcel-boundary.schema.json (geometry representation, SRID, validity rules)",
    "events/forests/parcel-boundary-submitted.schema.json payload contract",
    "openapi/root.yaml requestBody and response schemas for submitParcelBoundary",
    "idempotency key storage contract",
  ],
  blockedRequirementIds: REQUIREMENT_IDS,
  notes:
    "traceability.csv maps GEO-001 to forests.parcel_boundaries and ParcelBoundarySubmitted, " +
    "but 0001_foundation.sql creates only core.instances, forests.projects and events.outbox.",
});

export function registerParcelRoutes(app: FastifyInstance): void {
  app.post<{ Params: { parcelId: string } }>(
    "/parcels/:parcelId/boundaries",
    {
      // Tighter than the global default: this route authorizes against a
      // high-risk permission, and boundary submission is a deliberate,
      // infrequent act by a field worker rather than an automated one.
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request) => {
      authorize(request.principal, "parcel.submit_boundary");

      // x-idempotency-required: true in openapi/root.yaml
      const key = request.headers["idempotency-key"];
      if (!key) {
        throw new UnregisteredError(
          400,
          "IDEMPOTENCY_KEY_REQUIRED",
          "This operation is declared x-idempotency-required and needs an Idempotency-Key header",
          { operationId: "submitParcelBoundary" },
        );
      }

      throw contractMissing(BOUNDARY_GAP);
    },
  );
}

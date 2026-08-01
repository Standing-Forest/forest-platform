/**
 * AI-002 / AI-004 — POST /ai/query.
 *
 * The OpenAPI marks this x-grounding-required and x-citation-required, and
 * AI-004 requires the assistant to abstain when evidence is insufficient. None
 * of the machinery those rules govern exists yet: no citation schema, no
 * evidence store, no retrieval contract, no response schema.
 *
 * An ungrounded answer would violate the two requirements this endpoint exists
 * to satisfy, so the endpoint refuses rather than answering. Abstaining under
 * insufficient evidence is, in effect, exactly what AI-004 asks for.
 */
import type { FastifyInstance } from "fastify";
import { contractMissing, registerContractGap } from "../../core/spec/contract-gap.js";
import { assertKnownRequirements } from "../../core/spec/registry.js";

const REQUIREMENT_IDS = ["AI-002", "AI-004"];
assertKnownRequirements(REQUIREMENT_IDS, "POST /ai/query");

// Registered at module load so the gap report lists it whether or not anyone
// has called the endpoint.
const GROUNDED_QUERY_GAP = registerContractGap({
  operation: "POST /ai/query (queryGroundedAssistant)",
  missingArtifacts: [
    "table ai.citations",
    "schemas/ai/citation.schema.json",
    "schemas/ai/grounded-response.schema.json",
    "evidence retrieval contract (EVID-001 trace-to-evidence)",
    "abstention threshold definition for AI-004",
    "openapi/root.yaml requestBody and 200 response schema for queryGroundedAssistant",
  ],
  blockedRequirementIds: REQUIREMENT_IDS,
  notes:
    "AI_GROUNDING_INSUFFICIENT (422) exists in the error catalog for the runtime case where " +
    "evidence is too thin. This 409 is the different, structural case: the grounding " +
    "contract itself is absent, so no answer can be grounded at all.",
});

export function registerAiRoutes(app: FastifyInstance): void {
  app.post("/ai/query", async () => {
    throw contractMissing(GROUNDED_QUERY_GAP);
  });
}

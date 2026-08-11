/**
 * ARCH-001 — POST /projects, the one operation Release 0 specifies completely
 * enough to implement: forests.projects exists in the approved SQL and
 * traceability.csv names its event (ForestProjectCreated).
 *
 * SPEC GAP: the OpenAPI declares no requestBody and no response schema for this
 * operation. The request shape below is *derived* from the approved table's
 * columns rather than invented — id and created_at are server-generated,
 * home_instance_id comes from the authenticated tenant, and what remains is
 * what a caller must supply. This is recorded as a gap so the OpenAPI can catch
 * up to it.
 */
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Env } from "../../config/env.js";
import { authorize } from "../../core/auth/authorize.js";
import { UnregisteredError } from "../../core/errors/unregistered.js";
import { emitEvent, nextAggregateSequence } from "../../core/events/outbox.js";
import { newId } from "../../core/ids.js";
import { registerContractGap } from "../../core/spec/contract-gap.js";
import { assertKnownRequirements } from "../../core/spec/registry.js";
import type { Database } from "../../db/client.js";
import { instances, projects } from "../../db/schema.js";

const REQUIREMENT_IDS = ["ARCH-001"];
assertKnownRequirements(REQUIREMENT_IDS, "POST /projects");

registerContractGap({
  operation: "POST /projects request and response schemas",
  missingArtifacts: [
    "openapi/root.yaml requestBody for createProject",
    "openapi/root.yaml response schema for 201",
    "schemas/forests/project.schema.json",
  ],
  blockedRequirementIds: REQUIREMENT_IDS,
  notes:
    "Implemented by deriving the request shape from the approved forests.projects columns. " +
    "If the OpenAPI later specifies a different shape, this route must change.",
});

const createProjectBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["publicId", "leadOrganizationId"],
  properties: {
    publicId: { type: "string", minLength: 1, maxLength: 255 },
    leadOrganizationId: { type: "string", format: "uuid" },
    metadata: { type: "object" },
  },
} as const;

interface CreateProjectBody {
  publicId: string;
  leadOrganizationId: string;
  metadata?: Record<string, unknown>;
}

export function registerProjectRoutes(
  app: FastifyInstance,
  deps: { db: Database; env: Env },
): void {
  const { db, env } = deps;

  app.post<{ Body: CreateProjectBody }>(
    "/projects",
    {
      schema: { body: createProjectBodySchema },
      // Tighter than the global default. This route authorizes, writes and
      // emits an event; nobody legitimately creates twenty projects a minute,
      // and a lower ceiling limits both permission brute-forcing and the blast
      // radius of a runaway client.
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const principal = request.principal;
      authorize(principal, "project.create");
      // authorize throws when principal is null; this narrows for the compiler.
      if (!principal) throw new Error("unreachable");

      const { publicId, leadOrganizationId, metadata } = request.body;

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

      const projectId = newId();

      // ARCH-005: the row and its event commit together or not at all.
      const created = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(projects)
          .values({
            id: projectId,
            publicId,
            homeInstanceId: principal.instanceId,
            leadOrganizationId,
            createdAt: new Date(),
            metadata: metadata ?? {},
          })
          .returning();

        const sequence = await nextAggregateSequence(tx, "ForestProject", projectId);

        await emitEvent(tx, {
          eventType: "ForestProjectCreated",
          aggregateType: "ForestProject",
          aggregateId: projectId,
          aggregateSequence: sequence,
          payload: {
            projectId,
            publicId,
            homeInstanceId: principal.instanceId,
            leadOrganizationId,
            metadata: metadata ?? {},
          },
          requirementIds: REQUIREMENT_IDS,
          actor: {
            type: principal.type,
            id: principal.id,
            organizationId: principal.organizationId,
          },
          correlationId: request.correlationId,
          dataClassification: "internal",
          sourceInstanceId: env.instanceId,
          sourceService: env.serviceName,
        });

        return row;
      });

      return reply.status(201).send({
        id: created.id,
        publicId: created.publicId,
        homeInstanceId: created.homeInstanceId,
        leadOrganizationId: created.leadOrganizationId,
        createdAt: created.createdAt,
        metadata: created.metadata,
      });
    },
  );
}

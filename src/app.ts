import Fastify, { type FastifyInstance } from "fastify";
import { newId } from "./core/ids.js";
import { AppError } from "./core/errors/app-error.js";
import { UnregisteredError } from "./core/errors/unregistered.js";
import { EnvelopeValidationError } from "./core/events/envelope.js";
import { listContractGaps } from "./core/spec/contract-gap.js";
import { adrs, errorDefinitions, permissions, requirements, specVersion } from "./core/spec/registry.js";
import { devHeaderResolver, type Principal, type PrincipalResolver } from "./core/auth/principal.js";
import type { Database } from "./db/client.js";
import type { Env } from "./config/env.js";
import { registerProjectRoutes } from "./modules/forests/projects.routes.js";
import { registerParcelRoutes } from "./modules/forests/parcels.routes.js";
import { registerAiRoutes } from "./modules/ai/query.routes.js";

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal | null;
    correlationId: string;
  }
}

export interface AppOptions {
  env: Env;
  db: Database;
  principalResolver?: PrincipalResolver;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { env, db } = options;
  const principalResolver = options.principalResolver ?? devHeaderResolver(env.nodeEnv);

  const app = Fastify({
    logger: { level: env.logLevel },
    genReqId: () => newId(),
  });

  app.decorateRequest("principal", null);
  app.decorateRequest("correlationId", "");

  // Correlation id travels with the request and onto every event it emits.
  app.addHook("onRequest", async (request, reply) => {
    const incoming = request.headers["x-correlation-id"];
    const correlationId = (Array.isArray(incoming) ? incoming[0] : incoming) ?? newId();
    request.correlationId = correlationId;
    reply.header("x-correlation-id", correlationId);
    request.principal = await principalResolver.resolve(request);
  });

  app.setErrorHandler((error, request, reply) => {
    const correlationId = request.correlationId || newId();

    if (error instanceof AppError) {
      request.log.warn({ code: error.code, correlationId }, error.message);
      return reply.status(error.httpStatus).send(error.toBody(correlationId));
    }

    if (error instanceof UnregisteredError) {
      request.log.warn({ code: error.unregisteredCode, correlationId }, error.message);
      return reply.status(error.httpStatus).send(error.toBody(correlationId));
    }

    if (error instanceof EnvelopeValidationError) {
      // A malformed envelope is our bug, never the caller's.
      request.log.error({ issues: error.issues, correlationId }, error.message);
      return reply.status(500).send({
        code: "DOMAIN_EVENT_ENVELOPE_INVALID",
        message: "Generated domain event did not satisfy the canonical envelope",
        specificationRegistered: false,
        correlationId,
      });
    }

    const fastifyError = error as { validation?: unknown; message?: string };
    if (fastifyError.validation) {
      return reply.status(400).send({
        code: "REQUEST_BODY_INVALID",
        message: fastifyError.message ?? "Request body failed schema validation",
        specificationRegistered: false,
        correlationId,
      });
    }

    request.log.error({ err: error, correlationId }, "unhandled error");
    return reply.status(500).send({
      code: "INTERNAL_ERROR",
      message: "Internal server error",
      specificationRegistered: false,
      correlationId,
    });
  });

  app.get("/health", async () => ({ status: "ok", specVersion }));

  /** What this deployment knows it cannot do, and why. */
  app.get("/internal/contract-gaps", async () => ({
    specVersion,
    gaps: listContractGaps(),
  }));

  /** The registries this deployment loaded, for operator verification. */
  app.get("/internal/specification", async () => ({
    specVersion,
    requirements: [...requirements.values()],
    permissions: [...permissions.values()],
    errors: [...errorDefinitions.values()],
    adrs: [...adrs.values()],
  }));

  await app.register(async (instance) => {
    registerProjectRoutes(instance, { db, env });
    registerParcelRoutes(instance);
    registerAiRoutes(instance);
  }, { prefix: "/api/v1" });

  return app;
}

import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyRateLimit from "@fastify/rate-limit";
import { newId } from "./core/ids.js";
import { AppError } from "./core/errors/app-error.js";
import { UnregisteredError } from "./core/errors/unregistered.js";
import { translateDatabaseError } from "./core/errors/database.js";
import { EnvelopeValidationError } from "./core/events/envelope.js";
import { listContractGaps } from "./core/spec/contract-gap.js";
import { adrs, errorDefinitions, permissions, requirements, specVersion } from "./core/spec/registry.js";
import { devHeaderResolver, type Principal, type PrincipalResolver } from "./core/auth/principal.js";
import type { Database } from "./db/client.js";
import type { Env } from "./config/env.js";
import { registerProjectRoutes } from "./modules/forests/projects.routes.js";
import { registerPartyRoutes } from "./modules/parties/parties.routes.js";
import { registerLandRoleRoutes } from "./modules/parties/land-roles.routes.js";
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
    ajv: {
      customOptions: {
        // Fastify defaults to removeAdditional: true, which silently strips
        // properties a schema does not declare. For a contract-driven API that
        // is the wrong failure mode: a caller sending homeInstanceId or any
        // other unspecified field would get a 201 and believe it took effect.
        // Reject instead, so `additionalProperties: false` means what it says.
        removeAdditional: false,
      },
    },
  });

  // Routes that authorize must be rate limited, or a permission check becomes
  // something an attacker can retry indefinitely — and an unauthenticated
  // caller can exhaust the database connection pool for everyone else.
  //
  // The store is in-memory, which means the limit is per process. Running more
  // than one instance requires a shared store (Redis); that is recorded as a
  // gap rather than silently assumed.
  await app.register(fastifyRateLimit, {
    max: env.rateLimitMax,
    timeWindow: env.rateLimitWindowMs,
    // Identify by authenticated actor where there is one, so a shared NAT does
    // not let one abusive caller lock out an entire village office.
    keyGenerator: (request) => {
      const actor = request.headers["x-actor-id"];
      const id = Array.isArray(actor) ? actor[0] : actor;
      return id ?? request.ip;
    },
    errorResponseBuilder: (_request, context) => ({
      code: "RATE_LIMIT_EXCEEDED",
      message: `Too many requests. Retry in ${Math.ceil(context.ttl / 1000)}s.`,
      specificationRegistered: false,
      retryable: true,
    }),
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

    // The rate limiter raises a plain object carrying its own status. Without
    // this it falls through to the generic handler and a throttled caller gets
    // a 500, which tells them to retry harder rather than to back off.
    const withStatus = error as { statusCode?: number; code?: string; message?: string };
    if (withStatus.code === "RATE_LIMIT_EXCEEDED" || withStatus.statusCode === 429) {
      request.log.warn({ code: "RATE_LIMIT_EXCEEDED", correlationId }, withStatus.message ?? "");
      return reply.status(429).send({
        code: "RATE_LIMIT_EXCEEDED",
        message: withStatus.message ?? "Too many requests",
        specificationRegistered: false,
        retryable: true,
        correlationId,
      });
    }

    // A constraint doing its job is a caller error, not a server fault.
    const databaseError = translateDatabaseError(error);
    if (databaseError) {
      request.log.warn(
        { code: databaseError.unregisteredCode, correlationId },
        databaseError.message,
      );
      return reply.status(databaseError.httpStatus).send(databaseError.toBody(correlationId));
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
    registerPartyRoutes(instance, { db, env });
    registerLandRoleRoutes(instance, { db, env });
    registerParcelRoutes(instance);
    registerAiRoutes(instance);
  }, { prefix: "/api/v1" });

  // The web UI. Not described by any approved contract — it is a product
  // surface that consumes the API, and it labels every screen it renders from
  // sample data rather than from the platform.
  const webRoot =
    process.env.WEB_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../web");
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, index: ["index.html"] });
  } else {
    app.log.warn({ webRoot }, "web UI directory not found; serving API only");
  }

  return app;
}

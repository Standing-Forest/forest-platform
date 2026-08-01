/**
 * Who is acting, and at what assurance level.
 *
 * SPEC GAP: Release 0 contains no authentication contract — no session, token,
 * or credential schema exists in the approved package. Rather than invent one,
 * the principal is resolved through a port. The only implementation shipped is
 * a development header shim which refuses to run outside development, so a
 * production deployment fails closed until a real authenticator is wired.
 */
import type { FastifyRequest } from "fastify";
import { registerContractGap } from "../spec/contract-gap.js";

export type AssuranceLevel = "aal1" | "aal2" | "aal3";

export interface Principal {
  id: string;
  type: "user" | "service" | "system";
  organizationId: string;
  /** Tenant boundary for SEC-006 isolation. */
  instanceId: string;
  assuranceLevel: AssuranceLevel;
  permissions: ReadonlySet<string>;
}

export interface PrincipalResolver {
  resolve(request: FastifyRequest): Promise<Principal | null>;
}

registerContractGap({
  operation: "authentication",
  missingArtifacts: [
    "schemas for session/token/credential",
    "OpenAPI securitySchemes",
    "error codes for authentication and authorization failure",
  ],
  blockedRequirementIds: ["SEC-006"],
  notes:
    "No authentication contract exists in Release 0. A development header shim is provided " +
    "and is hard-disabled outside development.",
});

const ASSURANCE_LEVELS: AssuranceLevel[] = ["aal1", "aal2", "aal3"];

const isAssuranceLevel = (value: string): value is AssuranceLevel =>
  (ASSURANCE_LEVELS as string[]).includes(value);

/**
 * Development-only resolver driven by request headers. Explicitly not a
 * security mechanism — it trusts the caller completely.
 */
export function devHeaderResolver(nodeEnv: string): PrincipalResolver {
  if (nodeEnv === "production") {
    throw new Error(
      "devHeaderResolver must not be used in production: no approved authentication contract exists yet",
    );
  }

  return {
    async resolve(request) {
      const header = (name: string): string | undefined => {
        const value = request.headers[name];
        return Array.isArray(value) ? value[0] : value;
      };

      const id = header("x-actor-id");
      if (!id) return null;

      const level = header("x-assurance-level") ?? "aal1";

      return {
        id,
        type: (header("x-actor-type") as Principal["type"]) ?? "user",
        organizationId: header("x-organization-id") ?? "",
        instanceId: header("x-instance-id") ?? "",
        assuranceLevel: isAssuranceLevel(level) ? level : "aal1",
        permissions: new Set(
          (header("x-permissions") ?? "")
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean),
        ),
      };
    },
  };
}

export function meetsAssuranceLevel(actual: AssuranceLevel, required: AssuranceLevel): boolean {
  return ASSURANCE_LEVELS.indexOf(actual) >= ASSURANCE_LEVELS.indexOf(required);
}

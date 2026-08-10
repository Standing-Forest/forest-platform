/**
 * ADR-014: hybrid authorization. Every gate is driven by permissions.json —
 * the permission's own riskLevel, stepUpAuthentication and approvalPolicy
 * decide what is required, so tightening a permission is a spec edit, not a
 * code edit.
 */
import { UnregisteredError } from "../errors/unregistered.js";
import { contractMissing, registerContractGap } from "../spec/contract-gap.js";
import { requirePermission, type Permission } from "../spec/registry.js";
import { meetsAssuranceLevel, type AssuranceLevel, type Principal } from "./principal.js";

/**
 * SPEC GAP: errors.json defines no code for authentication or authorization
 * failure, so these cannot be AppError instances. They carry conventional HTTP
 * statuses and say plainly that their code is not in the approved registry.
 */
export class AuthError extends UnregisteredError {
  constructor(
    httpStatus: number,
    unregisteredCode: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(httpStatus, unregisteredCode, message, details);
    this.name = "AuthError";
  }
}

registerContractGap({
  operation: "authorization failure responses",
  missingArtifacts: [
    "errors.json entries for authentication required (401) and permission denied (403)",
  ],
  blockedRequirementIds: ["SEC-006"],
  notes:
    "Authorization failures cannot be expressed through the approved error catalog. " +
    "They are returned with unregistered codes until the catalog covers them.",
});

registerContractGap({
  operation: "SEC-006 cross-tenant access enforcement",
  missingArtifacts: [
    "an OpenAPI operation that reads or mutates an existing tenant-owned resource",
  ],
  blockedRequirementIds: ["SEC-006"],
  notes:
    "Writes are isolated by construction — home_instance_id comes from the authenticated " +
    "principal and the request schema is closed, so a caller cannot place a resource in " +
    "another tenant. But all three declared operations either create or are stubs, so no " +
    "route can pass resourceInstanceId and the cross-tenant check below is never reached " +
    "from HTTP. It is unit-tested directly. The first read/update operation added must wire " +
    "it in; see tests/integration.tenancy.test.ts.",
});

registerContractGap({
  operation: "dual-control approval",
  missingArtifacts: [
    "schema and table for approval records",
    "API operations to request and grant an approval",
  ],
  blockedRequirementIds: ["GEO-001", "FIN-001"],
  notes:
    "permissions.json marks parcel.approve_boundary and finance.payout.approve as " +
    "approvalPolicy=dual_control, but nothing in the package defines how an approval is " +
    "recorded or verified. Any route needing dual control refuses with 409.",
});

export interface AuthorizeOptions {
  /** Tenant the resource belongs to, for SEC-006 isolation. */
  resourceInstanceId?: string;
}

export function authorize(
  principal: Principal | null,
  permissionCode: string,
  options: AuthorizeOptions = {},
): Permission {
  const permission = requirePermission(permissionCode);

  if (!principal) {
    throw new AuthError(401, "AUTHENTICATION_REQUIRED", "Authentication is required", {
      permission: permissionCode,
    });
  }

  if (!principal.permissions.has(permissionCode)) {
    throw new AuthError(403, "PERMISSION_DENIED", `Principal lacks permission '${permissionCode}'`, {
      permission: permissionCode,
      riskLevel: permission.riskLevel,
      requirementIds: permission.requirementIds,
    });
  }

  // SEC-006: a principal may never act across a tenant boundary.
  if (
    options.resourceInstanceId !== undefined &&
    options.resourceInstanceId !== principal.instanceId
  ) {
    throw new AuthError(403, "TENANT_ISOLATION_VIOLATION", "Resource belongs to another tenant", {
      permission: permissionCode,
      requirementIds: ["SEC-006"],
    });
  }

  if (permission.stepUpAuthentication) {
    const required = permission.stepUpAuthentication as AssuranceLevel;
    if (!meetsAssuranceLevel(principal.assuranceLevel, required)) {
      throw new AuthError(
        403,
        "STEP_UP_REQUIRED",
        `Permission '${permissionCode}' requires assurance level ${required}`,
        {
          permission: permissionCode,
          requiredAssuranceLevel: required,
          actualAssuranceLevel: principal.assuranceLevel,
        },
      );
    }
  }

  // No contract exists for recording or verifying an approval, so a permission
  // that demands one cannot be honoured — refusing is the only faithful answer.
  if (permission.approvalPolicy) {
    throw contractMissing({
      operation: `permission '${permissionCode}' (approvalPolicy=${permission.approvalPolicy})`,
      missingArtifacts: [
        "schema and table for approval records",
        `definition of approval policy '${permission.approvalPolicy}'`,
      ],
      blockedRequirementIds: permission.requirementIds,
    });
  }

  return permission;
}

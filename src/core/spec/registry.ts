/**
 * Runtime loader for the Release 0 machine-readable specification package.
 *
 * The spec package is the single source of truth. Nothing in this codebase
 * hardcodes an HTTP status, a permission code, or a requirement id — it all
 * comes from here. If the package changes, behaviour changes with it.
 *
 * See docs/forest_platform_machine_readable_release0/forest_platform_release0/
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Location of the specification package. Overridable so a container image can
 * place it wherever it likes; the default is the checkout layout.
 */
export const SPEC_ROOT =
  process.env.SPEC_ROOT ??
  resolve(here, "../../../docs/forest_platform_machine_readable_release0/forest_platform_release0");

const readJson = <T>(relativePath: string): T =>
  JSON.parse(readFileSync(join(SPEC_ROOT, relativePath), "utf8")) as T;

export interface Requirement {
  id: string;
  title: string;
  priority: string;
  status: string;
  owner: string;
}

export interface Permission {
  code: string;
  resourceType: string;
  action: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  stepUpAuthentication?: string;
  approvalPolicy?: string;
  requirementIds: string[];
}

export interface ErrorDefinition {
  code: string;
  httpStatus: number;
  domain: string;
  retryable: boolean;
  requirementIds: string[];
}

export interface Adr {
  id: string;
  title: string;
  status: string;
}

const requirementsFile = readJson<{ version: string; requirements: Requirement[] }>(
  "requirements/requirements.json",
);
const permissionsFile = readJson<{ version: string; permissions: Permission[] }>(
  "permissions/permissions.json",
);
const errorsFile = readJson<{ version: string; errors: ErrorDefinition[] }>("errors/errors.json");
const adrFile = readJson<{ version: string; adrs: Adr[] }>("adr/registry.json");

export const specVersion = requirementsFile.version;

export const requirements: ReadonlyMap<string, Requirement> = new Map(
  requirementsFile.requirements.map((r) => [r.id, r]),
);
export const permissions: ReadonlyMap<string, Permission> = new Map(
  permissionsFile.permissions.map((p) => [p.code, p]),
);
export const errorDefinitions: ReadonlyMap<string, ErrorDefinition> = new Map(
  errorsFile.errors.map((e) => [e.code, e]),
);
export const adrs: ReadonlyMap<string, Adr> = new Map(adrFile.adrs.map((a) => [a.id, a]));

/** The canonical domain-event envelope schema (JSON Schema 2020-12). */
export const domainEventSchema = readJson<Record<string, unknown>>(
  "events/envelope/domain-event.schema.json",
);

/** The canonical Money schema — integer minor units only (ADR-027). */
export const moneySchema = readJson<Record<string, unknown>>("schemas/core/money.schema.json");

/**
 * Guards against drift between code and the requirement registry. Every event
 * we emit and every route we serve tags itself with requirement ids; if one of
 * those ids is not an approved requirement, that is a bug in this codebase, not
 * a runtime condition — so it throws at startup rather than per request.
 */
export function assertKnownRequirements(ids: readonly string[], context: string): void {
  const unknown = ids.filter((id) => !requirements.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `${context} references requirement ids absent from the approved registry: ${unknown.join(", ")}`,
    );
  }
}

export function requirePermission(code: string): Permission {
  const permission = permissions.get(code);
  if (!permission) {
    throw new Error(
      `Permission '${code}' is not in the approved permission registry (permissions/permissions.json)`,
    );
  }
  return permission;
}

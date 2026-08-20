import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AppError } from "../src/core/errors/app-error.js";
import { buildEvent } from "../src/core/events/outbox.js";
import { EnvelopeValidationError } from "../src/core/events/envelope.js";
import { errorDefinitions, permissions, requirements } from "../src/core/spec/registry.js";
import { authorize, AuthError } from "../src/core/auth/authorize.js";
import type { Principal } from "../src/core/auth/principal.js";

const principal = (over: Partial<Principal> = {}): Principal => ({
  id: "00000000-0000-7000-8000-0000000000aa",
  type: "user",
  organizationId: "00000000-0000-7000-8000-0000000000bb",
  instanceId: "00000000-0000-7000-8000-000000000001",
  assuranceLevel: "aal1",
  permissions: new Set(["project.create"]),
  ...over,
});

const validEventInput = {
  eventType: "ForestProjectCreated",
  aggregateType: "ForestProject",
  aggregateId: "019fbdf7-949a-719a-806d-8746f7a7038a",
  aggregateSequence: 1,
  payload: { projectId: "019fbdf7-949a-719a-806d-8746f7a7038a" },
  requirementIds: ["ARCH-001"],
  actor: { type: "user" as const, id: "00000000-0000-7000-8000-0000000000aa" },
  correlationId: "019fbdf7-948e-763a-918f-187adb1a5519",
  dataClassification: "internal" as const,
  sourceInstanceId: "00000000-0000-7000-8000-000000000001",
  sourceService: "forest-platform-api",
};

describe("specification registry", () => {
  it("loads the approved registries", () => {
    // Asserting exact counts made this fail every time a contract was approved,
    // which is noise rather than signal. What matters is that each registry
    // loaded and that entries the code depends on are present.
    assert.ok(requirements.size > 0);
    assert.ok(permissions.size > 0);
    assert.ok(errorDefinitions.size > 0);

    for (const id of ["ARCH-001", "ARCH-005", "SEC-006", "DEV-AI-001", "PARTY-001", "CONSENT-003"]) {
      assert.ok(requirements.has(id), `requirement ${id} should be approved`);
    }
    for (const code of ["project.create", "party.register", "party.read", "land_role.assert"]) {
      assert.ok(permissions.has(code), `permission ${code} should be approved`);
    }
    for (const code of ["SPECIFICATION_CONTRACT_MISSING", "CONSENT_SCOPE_NOT_PERMITTED"]) {
      assert.ok(errorDefinitions.has(code), `error ${code} should be approved`);
    }
  });

  it("marks every loaded requirement as approved, never proposed", () => {
    // Draft artifacts carry status "proposed". If one reaches the approved
    // package without being promoted, that is a broken approval, not a detail.
    const notApproved = [...requirements.values()].filter((r) => r.status !== "approved");
    assert.deepEqual(notApproved.map((r) => r.id), []);
  });
});

describe("error catalog", () => {
  it("takes http status and retryability from errors.json, not from code", () => {
    for (const definition of errorDefinitions.values()) {
      const error = new AppError(definition.code, "test");
      assert.equal(error.httpStatus, definition.httpStatus);
      assert.equal(error.retryable, definition.retryable);
    }
  });

  it("refuses to construct an error code that is not in the registry", () => {
    assert.throws(() => new AppError("NOT_A_REAL_CODE", "test"), /not in the approved error registry/);
  });

  it("reports SPECIFICATION_CONTRACT_MISSING as 409", () => {
    assert.equal(new AppError("SPECIFICATION_CONTRACT_MISSING", "x").httpStatus, 409);
  });
});

describe("domain event envelope", () => {
  it("accepts a well-formed event", () => {
    const event = buildEvent(validEventInput);
    assert.equal(event.eventType, "ForestProjectCreated");
    assert.equal(event.schemaVersion, 1);
    assert.ok(event.eventId);
  });

  it("rejects an event missing a required envelope field", () => {
    assert.throws(
      () => buildEvent({ ...validEventInput, dataClassification: undefined as never }),
      EnvelopeValidationError,
    );
  });

  it("rejects an eventType that violates the schema pattern", () => {
    assert.throws(
      () => buildEvent({ ...validEventInput, eventType: "forest_project_created" }),
      EnvelopeValidationError,
    );
  });

  it("rejects requirement ids that are not in the approved registry", () => {
    assert.throws(
      () => buildEvent({ ...validEventInput, requirementIds: ["NOT-A-REQ"] }),
      /absent from the approved registry/,
    );
  });
});

describe("authorization", () => {
  it("requires authentication", () => {
    assert.throws(() => authorize(null, "project.create"), (e: AuthError) => e.httpStatus === 401);
  });

  it("denies a principal lacking the permission", () => {
    assert.throws(
      () => authorize(principal({ permissions: new Set(["tree.register"]) }), "project.create"),
      (e: AuthError) => e.httpStatus === 403 && e.unregisteredCode === "PERMISSION_DENIED",
    );
  });

  it("enforces tenant isolation (SEC-006)", () => {
    assert.throws(
      () => authorize(principal(), "project.create", { resourceInstanceId: "other-tenant" }),
      (e: AuthError) => e.unregisteredCode === "TENANT_ISOLATION_VIOLATION",
    );
  });

  it("enforces aal3 step-up where permissions.json demands it", () => {
    assert.throws(
      () =>
        authorize(
          principal({ permissions: new Set(["parcel.approve_boundary"]), assuranceLevel: "aal2" }),
          "parcel.approve_boundary",
        ),
      (e: AuthError) => e.unregisteredCode === "STEP_UP_REQUIRED",
    );
  });

  it("refuses dual-control permissions with 409 because no approval contract exists", () => {
    assert.throws(
      () =>
        authorize(
          principal({ permissions: new Set(["parcel.approve_boundary"]), assuranceLevel: "aal3" }),
          "parcel.approve_boundary",
        ),
      (e: AppError) => e.httpStatus === 409 && e.code === "SPECIFICATION_CONTRACT_MISSING",
    );
  });

  it("rejects permission codes absent from the registry", () => {
    assert.throws(
      () => authorize(principal(), "not.a.permission"),
      /not in the approved permission registry/,
    );
  });
});

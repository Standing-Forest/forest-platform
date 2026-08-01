/**
 * ADR-006: immutable domain events. The canonical envelope is defined by
 * events/envelope/domain-event.schema.json in the spec package; we validate
 * against that file directly rather than restating it, so an event that would
 * not survive the contract never reaches the outbox.
 */
// ajv and ajv-formats ship CommonJS. Under NodeNext ESM the callable value sits
// behind `.default` at runtime while the types describe the namespace, so both
// are unwrapped and given explicit call signatures here.
import ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { Options, ValidateFunction } from "ajv";

interface AjvInstance {
  compile(schema: unknown): ValidateFunction;
}
type AjvConstructor = new (options?: Options) => AjvInstance;
type AddFormats = (ajv: AjvInstance) => void;

const interop = <T>(mod: unknown): T =>
  ((mod as { default?: unknown }).default ?? mod) as T;

const Ajv2020 = interop<AjvConstructor>(ajv2020Module);
const addFormats = interop<AddFormats>(addFormatsModule);
import { assertKnownRequirements, domainEventSchema } from "../spec/registry.js";

export type DataClassification =
  | "public"
  | "internal"
  | "confidential"
  | "restricted"
  | "cultural_restricted";

export interface Actor {
  type: "user" | "service" | "system";
  id: string;
  organizationId?: string;
}

export interface DomainEvent<TPayload = Record<string, unknown>> {
  eventId: string;
  eventType: string;
  schemaVersion: number;
  aggregateType: string;
  aggregateId: string;
  aggregateSequence: number;
  actor: Actor;
  occurredAt: string;
  recordedAt: string;
  correlationId: string;
  sourceInstanceId: string;
  sourceService: string;
  dataClassification: DataClassification;
  requirementIds: string[];
  payload: TPayload;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const validate: ValidateFunction = ajv.compile(domainEventSchema);

export class EnvelopeValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Domain event does not satisfy the canonical envelope: ${issues.join("; ")}`);
    this.name = "EnvelopeValidationError";
  }
}

/**
 * Throws unless `event` satisfies the canonical envelope. Also cross-checks the
 * declared requirement ids against the approved registry — the schema only
 * requires that the array is non-empty, not that the ids are real.
 */
export function assertValidEnvelope<T>(event: DomainEvent<T>): asserts event is DomainEvent<T> {
  if (!validate(event)) {
    const issues = (validate.errors ?? []).map(
      (e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`,
    );
    throw new EnvelopeValidationError(issues);
  }
  assertKnownRequirements(event.requirementIds, `event ${event.eventType}`);
}
